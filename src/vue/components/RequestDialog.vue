<template>
  <div
    ref="rootRef"
    class="sbx-req"
    :class="[`sbx-req--${mode}`, { 'is-wide': mode === 'ask' }]"
    tabindex="-1"
    role="dialog"
    aria-modal="true"
    @keydown="onKey"
  >
    <!-- ── Heading ─────────────────────────────────────────────── -->
    <div class="sbx-req__head">
      <SbIcon :name="mode === 'ask' ? 'message-square' : 'triangle-alert'" :size="13" />
      <span class="sbx-req__q">{{ heading }}</span>
      <span v-if="subject" class="sbx-req__subject" :title="subject">{{ subject }}</span>
      <span v-if="steps.length > 1" class="sbx-req__count">{{ step + 1 }} / {{ steps.length }}</span>
    </div>

    <!-- Where you are in a multi-question run, and a way back to any of it.
         Answered steps stay clickable: changing your mind about the first
         answer is the whole reason a wizard has a back button. -->
    <div v-if="steps.length > 1" class="sbx-req__steps">
      <button
        v-for="(s, i) in steps"
        :key="s.id"
        type="button"
        class="sbx-req__step"
        :class="{ 'is-current': i === step, 'is-done': i < step || answeredAt(i) }"
        :disabled="i > step && !answeredAt(i - 1)"
        @click="goTo(i)"
      >{{ s.header || `Q${i + 1}` }}</button>
    </div>

    <!-- ── AskUserQuestion ─────────────────────────────────────── -->
    <template v-if="mode === 'ask' && current">
      <p v-if="current.description" class="sbx-req__desc">{{ current.description }}</p>

      <div v-if="current.kind === 'choice'" class="sbx-req__options" role="listbox">
        <button
          v-for="(option, i) in current.options"
          :key="option.label"
          type="button"
          class="sbx-req__option"
          :class="{ 'is-cursor': i === cursor, 'is-picked': isPicked(option.label) }"
          role="option"
          :aria-selected="isPicked(option.label)"
          @mouseenter="cursor = i"
          @click="choose(i)"
        >
          <kbd class="sbx-req__key">{{ i + 1 }}</kbd>
          <span class="sbx-req__option-body">
            <span class="sbx-req__option-label">{{ option.label }}</span>
            <span v-if="option.description" class="sbx-req__option-desc">{{ option.description }}</span>
          </span>
          <SbIcon v-if="isPicked(option.label)" name="check" :size="12" class="sbx-req__tick" />
        </button>
      </div>

      <!-- Rendered for the option under the cursor, which is what "on focus"
           means for a list you drive with a keyboard. -->
      <pre v-if="cursorPreview" class="sbx-req__preview">{{ cursorPreview }}</pre>

      <input
        v-if="current.kind === 'number'"
        ref="textRef"
        v-model="slot.text"
        class="sbx-req__text"
        type="number"
        :min="current.min"
        :max="current.max"
        :step="current.step || 1"
        :placeholder="numberPlaceholder"
      >
      <textarea
        v-else
        ref="textRef"
        v-model="slot.text"
        class="sbx-req__text"
        rows="1"
        :placeholder="textPlaceholder"
        @input="growText"
      ></textarea>
      <p v-if="error" class="sbx-req__error">{{ error }}</p>
    </template>

    <!-- ── MCP elicitation ─────────────────────────────────────── -->
    <template v-else-if="mode === 'elicit'">
      <p class="sbx-req__desc">{{ request.message }}</p>

      <p v-if="request.mode === 'url'" class="sbx-req__url">
        <a :href="request.url" @click.prevent="openUrl">{{ request.url }}</a>
      </p>

      <div v-else-if="fields.length" class="sbx-req__fields">
        <label v-for="field in fields" :key="field.name" class="sbx-req__field">
          <span class="sbx-req__field-name">
            {{ field.title }}<em v-if="field.required">*</em>
          </span>
          <select v-if="field.enum" v-model="form[field.name]" class="sbx-req__text">
            <option v-for="v in field.enum" :key="v" :value="v">{{ v }}</option>
          </select>
          <input
            v-else-if="field.type === 'boolean'"
            v-model="form[field.name]"
            type="checkbox"
          >
          <input
            v-else
            v-model="form[field.name]"
            class="sbx-req__text"
            :type="field.type === 'number' || field.type === 'integer' ? 'number' : 'text'"
            :placeholder="field.description"
          >
        </label>
      </div>
    </template>

    <!-- ── Refusal fallback ────────────────────────────────────── -->
    <p v-else-if="mode === 'dialog'" class="sbx-req__desc">
      {{ dialog.guidanceText || 'The turn can be retried on the fallback model, or you can rephrase it.' }}
    </p>

    <!-- ── Plain tool permission ───────────────────────────────── -->
    <pre v-else-if="detail" class="sbx-req__detail">{{ detail }}</pre>

    <!-- ── Actions ─────────────────────────────────────────────── -->
    <div class="sbx-req__actions">
      <button
        v-if="step > 0"
        type="button" class="pv-gen-style-btn"
        @click="goTo(step - 1)"
      >Back <kbd class="sbx-req__key">←</kbd></button>

      <span class="sbx-req__spacer"></span>

      <template v-if="mode === 'ask'">
        <button type="button" class="pv-gen-style-btn" @click="cancel">
          Cancel <kbd class="sbx-req__key">esc</kbd>
        </button>
        <button
          v-if="current && current.kind === 'choice' && !isAnswered(current, slot)"
          type="button" class="pv-gen-style-btn" @click="advance"
        >Skip</button>
        <button type="button" class="pv-action-btn" :disabled="!!error" @click="advance">
          {{ step === steps.length - 1 ? 'Submit' : 'Next' }} <kbd class="sbx-req__key">↵</kbd>
        </button>
      </template>

      <!-- One numbered row per answer, in the order you read them, so the
           digit you press is the line you are looking at. -->
      <template v-else>
        <button
          v-for="(choice, i) in choices"
          :key="choice.id"
          type="button"
          :class="choice.tone === 'primary' ? 'pv-action-btn' : 'pv-gen-style-btn'"
          :data-tooltip="choice.description || null"
          @click="settle(choice.id)"
        >
          <kbd class="sbx-req__key">{{ i + 1 }}</kbd> {{ choice.label }}
        </button>
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, nextTick } from 'vue';
import SbIcon from './SbIcon.vue';
import { describePermission, permissionChoices } from '../permission-describe.js';
import {
  parseQuestions, questionTitle, initialAnswers, isAnswered, slotError, buildUpdatedInput,
} from '../ask-question.js';

// One dialog for every way the session can stop and wait for a person:
//
//   permission   an ordinary tool asking to run              → canUseTool
//   ask          AskUserQuestion, one to four questions      → canUseTool
//   elicit       an MCP server asking for input or a login   → onElicitation
//
// They differ in what they show and agree on how they are answered: a numbered
// list, digits 1-9 as aliases, arrows to move, Enter to take, Escape to
// refuse. Answering with the keyboard is the point — the mouse is the fallback.

const props = defineProps({
  request: { type: Object, required: true },
});
const emit = defineEmits(['respond', 'cancel']);

const rootRef = ref(null);
const textRef = ref(null);

/**
 * The only `request_user_dialog` kind this component draws. sdk-session.js
 * declares the same name to the CLI and answers anything else `cancelled`; the
 * two lists are checked against each other in test/sdk-session.test.js.
 */
const REFUSAL_FALLBACK = 'refusal_fallback_prompt';

const mode = computed(() => {
  if (props.request.kind === 'elicitation') return 'elicit';
  if (props.request.kind === 'dialog') {
    return props.request.dialogKind === REFUSAL_FALLBACK ? 'dialog' : 'unknown';
  }
  return props.request.toolName === 'AskUserQuestion' && questions.value.length ? 'ask' : 'permission';
});

// ── AskUserQuestion ───────────────────────────────────────────────

const questions = computed(() =>
  props.request.toolName === 'AskUserQuestion' ? parseQuestions(props.request.input) : []);

const steps = computed(() => (mode.value === 'ask' ? questions.value : []));
const step = ref(0);
const cursor = ref(0);
const slots = ref([]);

const current = computed(() => steps.value[step.value] || null);
const slot = computed(() => slots.value[step.value] || { selected: [], text: '' });

const error = computed(() =>
  (current.value ? slotError(current.value, slot.value) : ''));

const cursorPreview = computed(() =>
  (current.value?.kind === 'choice' && current.value.options[cursor.value]?.preview) || '');

const textPlaceholder = computed(() => {
  const q = current.value;
  if (!q) return '';
  if (q.kind === 'text') return q.placeholder || 'Type your answer…';
  // Alongside a choice list, typing is a note on the choice — or the answer
  // itself when none of the options fit. Both are what the CLI expects.
  return q.multiSelect ? 'Add a note, or type your own answer…' : 'Or type something else…';
});

const numberPlaceholder = computed(() => {
  const q = current.value;
  if (!q) return '';
  const range = [q.min, q.max].every(v => v !== undefined) ? `${q.min}–${q.max}` : '';
  return [range, q.unit].filter(Boolean).join(' ');
});

function answeredAt(i) {
  const q = steps.value[i];
  return q ? isAnswered(q, slots.value[i]) : false;
}

function isPicked(label) {
  return slot.value.selected.includes(label);
}

/**
 * Taking an option. A single-choice question is finished by the act of
 * choosing, so it moves on by itself — that is what makes answering a run of
 * questions with 1-2-3 feel like one gesture instead of six keys.
 */
function choose(i) {
  const q = current.value;
  const option = q?.options[i];
  if (!option) return;
  cursor.value = i;
  const picked = slots.value[step.value].selected;

  if (q.multiSelect) {
    const at = picked.indexOf(option.label);
    if (at === -1) picked.push(option.label);
    else picked.splice(at, 1);
    return;
  }
  slots.value[step.value].selected = [option.label];
  advance();
}

function goTo(i) {
  if (i < 0 || i >= steps.value.length) return;
  step.value = i;
  cursor.value = 0;
}

function advance() {
  if (error.value) return;
  if (step.value < steps.value.length - 1) { goTo(step.value + 1); return; }
  emit('respond', {
    behavior: 'allow',
    updatedInput: buildUpdatedInput(props.request.input, steps.value, slots.value),
  });
}

// ── Permission ────────────────────────────────────────────────────

const described = computed(() => describePermission(
  props.request.toolName, props.request.input, props.request));

const choices = computed(() => {
  if (mode.value === 'elicit') {
    return [
      { id: 'accept', label: props.request.mode === 'url' ? 'Open link' : 'Send', description: '', tone: 'primary' },
      { id: 'decline', label: 'Decline', description: '', tone: 'danger' },
    ];
  }
  if (mode.value === 'dialog') {
    // The one kind this build declares it can draw. The CLI validates the
    // answer against exactly these three, and takes 'cancelled' as the default.
    return [
      { id: 'retry_fallback', label: `Retry on ${modelName(dialog.value.fallbackModel)}`, description: '', tone: 'primary' },
      { id: 'edit_prompt', label: 'Let me rewrite the prompt', description: '' },
      { id: 'cancelled', label: 'Neither', description: '', tone: 'danger' },
    ];
  }
  return permissionChoices(props.request);
});

/** The refusal-fallback payload, when that is what this dialog is. */
const dialog = computed(() => (mode.value === 'dialog' ? (props.request.payload || {}) : {}));

/** `claude-opus-5[1m]` reads as noise in a sentence; the id alone does not. */
const modelName = (id) => String(id || 'the fallback model').replace(/\[1m\]$/, '');

const heading = computed(() => {
  if (mode.value === 'ask') {
    return current.value?.question || questionTitle(props.request.input) || 'Claude has a question';
  }
  if (mode.value === 'elicit') {
    return props.request.title || `${props.request.serverName} needs your input`;
  }
  if (mode.value === 'dialog') {
    return `${modelName(dialog.value.originalModel)} declined this turn.`;
  }
  return described.value.question;
});

const subject = computed(() => (mode.value === 'permission' ? described.value.subject : ''));
const detail = computed(() => (mode.value === 'permission' ? described.value.detail : ''));

// ── Elicitation ───────────────────────────────────────────────────

const form = ref({});

/** The requested JSON Schema, flattened to the fields a form can render. */
const fields = computed(() => {
  const schema = props.request.requestedSchema;
  const properties = schema?.properties;
  if (!properties || typeof properties !== 'object') return [];
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.entries(properties).map(([name, spec]) => ({
    name,
    title: spec?.title || name,
    description: spec?.description || '',
    type: spec?.type || 'string',
    enum: Array.isArray(spec?.enum) ? spec.enum : null,
    required: required.has(name),
  }));
});

function openUrl() {
  if (props.request.url) window.api?.openExternal?.(props.request.url);
}

function settle(id) {
  if (mode.value === 'dialog') {
    emit('respond', id === 'cancelled'
      ? { behavior: 'cancelled' }
      : { behavior: 'completed', result: id });
    return;
  }
  if (mode.value === 'elicit') {
    if (id === 'accept' && props.request.mode === 'url') openUrl();
    emit('respond', id === 'accept'
      ? { action: 'accept', content: { ...form.value } }
      : { action: 'decline' });
    return;
  }
  if (id === 'deny') {
    emit('respond', { behavior: 'deny', message: 'You declined this.' });
    return;
  }
  const decision = { behavior: 'allow' };
  // The CLI's own suggestion list, handed straight back: the rules it would
  // have written itself, so the next session behaves the same.
  if (id === 'always' && props.request.suggestions?.length) {
    decision.updatedPermissions = props.request.suggestions;
  }
  emit('respond', decision);
}

function cancel() {
  if (mode.value === 'elicit') { emit('respond', { action: 'cancel' }); return; }
  if (mode.value === 'dialog') { emit('respond', { behavior: 'cancelled' }); return; }
  emit('respond', { behavior: 'deny', message: 'You declined this.' });
}

// ── Keyboard ──────────────────────────────────────────────────────

/** Digits belong to the option list — unless you are typing, where they are text. */
function typing(event) {
  const tag = event.target?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function onKey(event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    cancel();
    return;
  }
  // A focused button already turns Enter and Space into a click. Handling it
  // here as well would answer twice — and in a multi-select, toggle back off.
  if (event.target?.tagName === 'BUTTON' && (event.key === 'Enter' || event.key === ' ')) return;

  const digit = /^[1-9]$/.test(event.key) ? Number(event.key) : 0;

  if (mode.value !== 'ask') {
    if (digit && !typing(event) && choices.value[digit - 1]) {
      event.preventDefault();
      settle(choices.value[digit - 1].id);
    }
    // Enter is the primary answer, which for a permission is the first row.
    if (event.key === 'Enter' && !typing(event)) {
      event.preventDefault();
      settle(choices.value[0].id);
    }
    return;
  }

  const options = current.value?.kind === 'choice' ? current.value.options : [];

  if (digit && !typing(event) && options[digit - 1]) {
    event.preventDefault();
    choose(digit - 1);
    return;
  }
  if (options.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    event.preventDefault();
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    cursor.value = (cursor.value + delta + options.length) % options.length;
    return;
  }
  // Left and Shift+Tab go back a step; inside a text box the arrow is a
  // caret move and must stay one.
  if ((event.key === 'ArrowLeft' && !typing(event))
      || (event.key === 'Tab' && event.shiftKey)) {
    if (step.value > 0) { event.preventDefault(); goTo(step.value - 1); }
    return;
  }
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    // Enter on a highlighted-but-unpicked option takes it, so arrow-then-Enter
    // works the same as pressing its number.
    if (options.length && !slot.value.selected.length && !slot.value.text.trim()) {
      choose(cursor.value);
      return;
    }
    advance();
  }
}

const MAX_TEXT_HEIGHT = 120;
function growText() {
  const el = textRef.value;
  if (!el || el.tagName !== 'TEXTAREA') return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, MAX_TEXT_HEIGHT) + 'px';
}

// The dialog takes focus when it appears: digits only work as answers if the
// composer does not have them, and the session is blocked anyway — there is
// nothing else worth typing into until this is settled.
function grabFocus() {
  nextTick(() => rootRef.value?.focus());
}

watch(() => props.request, () => {
  // A dialog kind that got past the transport filter has no renderer here, and
  // the SDK's contract for that case is to answer at once rather than park a
  // question nobody can read.
  if (mode.value === 'unknown') { emit('respond', { behavior: 'cancelled' }); return; }
  step.value = 0;
  cursor.value = 0;
  slots.value = initialAnswers(questions.value);
  form.value = {};
  for (const field of fields.value) {
    form.value[field.name] = field.type === 'boolean' ? false : '';
  }
  grabFocus();
}, { immediate: true });

watch(step, () => nextTick(growText));

onMounted(grabFocus);
</script>
