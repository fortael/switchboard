// ask-question.js — the AskUserQuestion tool, as something a UI can drive.
//
// AskUserQuestion arrives through `canUseTool` like any other tool, which is
// misleading: there is nothing to permit. The tool *is* the dialog. Its input
// carries the questions, and the answers go back in `updatedInput` — allowing
// the call with the answers filled in is how the user replies.
//
//   canUseTool('AskUserQuestion', input) → { behavior: 'allow', updatedInput }
//
// The shape of a question has grown past the plain multiple choice the type
// declarations still describe: the CLI also emits `kind: 'text'` (open-ended)
// and `kind: 'number'` (a bounded quantity), and every choice option may carry
// a `preview` worth rendering beside it. Absence of `kind` means choice, which
// is what every older payload is.
//
// This module is the model only — no DOM, no Vue. What the dialog looks like
// is RequestDialog.vue's problem; what a half-answered wizard means is this
// file's.

/**
 * The answer the CLI expects when the user typed something but picked nothing.
 * Their words go to `annotations[question].notes`; this marks the slot as
 * deliberately unpicked rather than skipped. Taken from the CLI's own UI.
 */
export const NOTES_ONLY = '(notes only)';

/** Options are capped at four by the tool schema, which is also 1–4 on a keyboard. */
export const MAX_OPTIONS = 4;

function str(value) {
  return typeof value === 'string' ? value : '';
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * The questions, normalised. Anything malformed is dropped rather than
 * rendered half-built: a question with no text has nothing to ask, and a
 * choice with no options has nothing to answer.
 *
 * @param {unknown} input the raw `AskUserQuestion` tool input
 * @returns {Array<object>}
 */
export function parseQuestions(input) {
  const raw = (input && typeof input === 'object' && Array.isArray(input.questions))
    ? input.questions : [];
  const out = [];

  for (const q of raw) {
    if (!q || typeof q !== 'object') continue;
    const question = str(q.question).trim();
    if (!question) continue;

    // `kind` is the newer field. Its absence is not "unknown" — it is the
    // original multiple-choice question, which is still the common case.
    let kind = str(q.kind) || 'choice';
    if (kind !== 'text' && kind !== 'number') kind = 'choice';

    const options = (Array.isArray(q.options) ? q.options : [])
      .map(o => (o && typeof o === 'object'
        ? { label: str(o.label), description: str(o.description), preview: str(o.preview) }
        : { label: String(o ?? ''), description: '', preview: '' }))
      .filter(o => o.label)
      .slice(0, MAX_OPTIONS);

    // A choice that lost its options in transit would render as a dead list.
    // Falling back to free text still lets the user answer.
    if (kind === 'choice' && !options.length) kind = 'text';

    out.push({
      id: question,                 // answers and annotations are keyed by the text
      question,
      header: str(q.header).trim(),
      description: str(q.description).trim(),
      kind,
      options,
      multiSelect: kind === 'choice' && q.multiSelect === true,
      placeholder: str(q.placeholder),
      min: num(q.min),
      max: num(q.max),
      step: num(q.step),
      defaultValue: num(q.defaultValue),
      unit: str(q.unit),
    });
  }

  return out;
}

/** The title the CLI sometimes puts above the whole set. */
export function questionTitle(input) {
  return (input && typeof input === 'object') ? str(input.title).trim() : '';
}

/** A blank answer slot per question, with `number` pre-filled from its default. */
export function initialAnswers(questions) {
  return questions.map(q => ({
    selected: [],
    text: q.kind === 'number' && q.defaultValue !== undefined ? String(q.defaultValue) : '',
  }));
}

/**
 * A question is answerable in three ways, and all three are optional — the CLI
 * lets a question go unanswered rather than forcing a choice nobody has.
 */
export function isAnswered(question, slot) {
  if (!slot) return false;
  if (question.kind === 'choice') return slot.selected.length > 0 || !!slot.text.trim();
  return !!slot.text.trim();
}

/**
 * A number outside its own bounds is the one input worth refusing: the CLI
 * validates it on the other side and the round trip is a wasted turn.
 */
export function slotError(question, slot) {
  if (question.kind !== 'number' || !slot?.text.trim()) return '';
  const value = Number(slot.text.trim());
  if (!Number.isFinite(value)) return 'Enter a number.';
  if (question.min !== undefined && value < question.min) return `At least ${question.min}.`;
  if (question.max !== undefined && value > question.max) return `At most ${question.max}.`;
  return '';
}

/**
 * The tool input, answered — what goes back as `updatedInput`.
 *
 * `answers` is keyed by question text and holds a single string: for
 * multi-select that is the chosen labels joined, which is the form the CLI
 * parses back apart. Free text the user typed alongside a choice is not an
 * answer, it is a note, and it rides `annotations` — the same split the CLI's
 * own dialog makes.
 */
export function buildUpdatedInput(input, questions, slots) {
  const answers = {};
  const annotations = {};

  questions.forEach((q, i) => {
    const slot = slots[i];
    if (!slot) return;
    const text = slot.text.trim();

    if (q.kind !== 'choice') {
      if (text) answers[q.id] = text;
      return;
    }

    const picked = q.options.filter(o => slot.selected.includes(o.label));
    if (picked.length) {
      answers[q.id] = picked.map(o => o.label).join(', ');
      const note = {};
      // Only one preview fits an answer, so it is the first pick's — with a
      // single-select question, the only one.
      const preview = picked.find(o => o.preview)?.preview;
      if (preview) note.preview = preview;
      if (text) note.notes = text;
      if (Object.keys(note).length) annotations[q.id] = note;
    } else if (text) {
      answers[q.id] = NOTES_ONLY;
      annotations[q.id] = { notes: text };
    }
  });

  const updated = { ...(input && typeof input === 'object' ? input : {}), answers };
  if (Object.keys(annotations).length) updated.annotations = annotations;
  else delete updated.annotations;
  return updated;
}
