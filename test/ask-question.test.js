const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseQuestions, questionTitle, initialAnswers, isAnswered, slotError,
  buildUpdatedInput, NOTES_ONLY, MAX_OPTIONS,
} = require('../src/vue/ask-question.js');

const choice = (over = {}) => ({
  question: 'Which library?',
  header: 'Library',
  options: [
    { label: 'date-fns', description: 'Small' },
    { label: 'luxon', description: 'Batteries included', preview: 'DateTime.now()' },
  ],
  multiSelect: false,
  ...over,
});

// ── Parsing ───────────────────────────────────────────────────────

test('a plain multiple-choice question parses as one', () => {
  const [q] = parseQuestions({ questions: [choice()] });
  assert.equal(q.kind, 'choice');
  assert.equal(q.header, 'Library');
  assert.equal(q.options.length, 2);
  assert.equal(q.options[1].preview, 'DateTime.now()');
  assert.equal(q.multiSelect, false);
});

// The field is newer than the tool. Every payload written before it exists is
// a choice, and must not read as an unrecognised kind.
test('a question with no kind is a choice, not an unknown', () => {
  const [q] = parseQuestions({ questions: [choice({ kind: undefined })] });
  assert.equal(q.kind, 'choice');
});

test('the open-ended and numeric kinds survive with their own fields', () => {
  const [text, number] = parseQuestions({
    questions: [
      { question: 'Name it?', header: 'Name', kind: 'text', placeholder: 'my-app' },
      { question: 'How many?', header: 'Count', kind: 'number', min: 1, max: 10, defaultValue: 3, unit: 'workers' },
    ],
  });
  assert.equal(text.kind, 'text');
  assert.equal(text.placeholder, 'my-app');
  assert.equal(number.kind, 'number');
  assert.deepEqual([number.min, number.max, number.defaultValue], [1, 10, 3]);
  assert.equal(number.unit, 'workers');
});

test('an unrecognised kind degrades to a choice rather than rendering nothing', () => {
  const [q] = parseQuestions({ questions: [choice({ kind: 'carousel' })] });
  assert.equal(q.kind, 'choice');
});

// A list with no options is unanswerable as a list; a text box still lets the
// user say something, which is better than a dead dialog.
test('a choice that arrived with no options falls back to free text', () => {
  const [q] = parseQuestions({ questions: [choice({ options: [] })] });
  assert.equal(q.kind, 'text');
});

test('questions with no text are dropped', () => {
  assert.equal(parseQuestions({ questions: [{ header: 'x' }, choice()] }).length, 1);
});

test('a malformed input never throws', () => {
  assert.deepEqual(parseQuestions(null), []);
  assert.deepEqual(parseQuestions({ questions: 'nope' }), []);
  assert.deepEqual(parseQuestions({ questions: [null, 7] }), []);
});

test('options past the fourth are dropped, because the keyboard stops there', () => {
  const options = Array.from({ length: 7 }, (_, i) => ({ label: `o${i}`, description: '' }));
  const [q] = parseQuestions({ questions: [choice({ options })] });
  assert.equal(q.options.length, MAX_OPTIONS);
});

test('multiSelect only applies to a choice', () => {
  const [q] = parseQuestions({
    questions: [{ question: 'Free?', header: 'F', kind: 'text', multiSelect: true }],
  });
  assert.equal(q.multiSelect, false);
});

test('the title above the set is read when there is one', () => {
  assert.equal(questionTitle({ title: 'Set up auth' }), 'Set up auth');
  assert.equal(questionTitle(undefined), '');
});

// ── Slots ─────────────────────────────────────────────────────────

test('a number question starts on its default so Enter alone is an answer', () => {
  const qs = parseQuestions({
    questions: [{ question: 'How many?', header: 'N', kind: 'number', min: 1, max: 5, defaultValue: 2 }],
  });
  assert.equal(initialAnswers(qs)[0].text, '2');
});

test('a question is answered by a pick or by typing, and neither is required', () => {
  const [q] = parseQuestions({ questions: [choice()] });
  assert.equal(isAnswered(q, { selected: [], text: '' }), false);
  assert.equal(isAnswered(q, { selected: ['luxon'], text: '' }), true);
  assert.equal(isAnswered(q, { selected: [], text: 'something else' }), true);
});

test('a number outside its bounds is refused before the round trip', () => {
  const [q] = parseQuestions({
    questions: [{ question: 'How many?', header: 'N', kind: 'number', min: 1, max: 5 }],
  });
  assert.match(slotError(q, { selected: [], text: '9' }), /At most 5/);
  assert.match(slotError(q, { selected: [], text: '0' }), /At least 1/);
  assert.match(slotError(q, { selected: [], text: 'lots' }), /Enter a number/);
  assert.equal(slotError(q, { selected: [], text: '3' }), '');
  assert.equal(slotError(q, { selected: [], text: '' }), '');
});

// ── Building the answer ───────────────────────────────────────────

test('a single choice answers with its label, keyed by the question text', () => {
  const questions = parseQuestions({ questions: [choice()] });
  const out = buildUpdatedInput({ questions: [choice()] }, questions, [{ selected: ['date-fns'], text: '' }]);
  assert.deepEqual(out.answers, { 'Which library?': 'date-fns' });
  assert.equal(out.annotations, undefined);
});

test('the chosen option carries its preview into the annotations', () => {
  const questions = parseQuestions({ questions: [choice()] });
  const out = buildUpdatedInput({}, questions, [{ selected: ['luxon'], text: '' }]);
  assert.deepEqual(out.annotations, { 'Which library?': { preview: 'DateTime.now()' } });
});

test('multiple picks join into the one string the CLI parses back apart', () => {
  const questions = parseQuestions({ questions: [choice({ multiSelect: true })] });
  const out = buildUpdatedInput({}, questions, [{ selected: ['luxon', 'date-fns'], text: '' }]);
  // Option order, not click order: the answer should read like the list did.
  assert.equal(out.answers['Which library?'], 'date-fns, luxon');
});

// Typing beside a choice is a note on that choice, not a second answer — the
// same split the CLI's own dialog makes.
test('text typed alongside a pick becomes a note, not the answer', () => {
  const questions = parseQuestions({ questions: [choice()] });
  const out = buildUpdatedInput({}, questions, [{ selected: ['luxon'], text: 'but pin the version' }]);
  assert.equal(out.answers['Which library?'], 'luxon');
  assert.equal(out.annotations['Which library?'].notes, 'but pin the version');
});

test('text typed with nothing picked answers with the notes-only sentinel', () => {
  const questions = parseQuestions({ questions: [choice()] });
  const out = buildUpdatedInput({}, questions, [{ selected: [], text: 'neither — use Temporal' }]);
  assert.equal(out.answers['Which library?'], NOTES_ONLY);
  assert.equal(out.annotations['Which library?'].notes, 'neither — use Temporal');
});

test('an open-ended question answers with what was typed', () => {
  const questions = parseQuestions({
    questions: [{ question: 'Name it?', header: 'Name', kind: 'text' }],
  });
  const out = buildUpdatedInput({}, questions, [{ selected: [], text: '  wootonpad  ' }]);
  assert.deepEqual(out.answers, { 'Name it?': 'wootonpad' });
});

test('a skipped question is absent rather than empty', () => {
  const questions = parseQuestions({ questions: [choice()] });
  const out = buildUpdatedInput({}, questions, [{ selected: [], text: '   ' }]);
  assert.deepEqual(out.answers, {});
});

test('the original input is carried through, since the CLI reads it back', () => {
  const input = { questions: [choice()], metadata: { source: 'remember' } };
  const out = buildUpdatedInput(input, parseQuestions(input), [{ selected: ['luxon'], text: '' }]);
  assert.deepEqual(out.metadata, { source: 'remember' });
  assert.equal(out.questions.length, 1);
});

test('answers already on the input are replaced, not merged into', () => {
  const input = { questions: [choice()], answers: { stale: 'x' }, annotations: { stale: {} } };
  const out = buildUpdatedInput(input, parseQuestions(input), [{ selected: ['luxon'], text: '' }]);
  assert.deepEqual(Object.keys(out.answers), ['Which library?']);
  assert.deepEqual(Object.keys(out.annotations), ['Which library?']);
});

test('a run of questions answers each under its own key', () => {
  const input = {
    questions: [choice(), choice({ question: 'Which runtime?', header: 'Runtime' })],
  };
  const questions = parseQuestions(input);
  const out = buildUpdatedInput(input, questions, [
    { selected: ['date-fns'], text: '' },
    { selected: [], text: 'bun' },
  ]);
  assert.deepEqual(out.answers, {
    'Which library?': 'date-fns',
    'Which runtime?': NOTES_ONLY,
  });
});
