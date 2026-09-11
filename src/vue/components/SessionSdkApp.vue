<template>
  <div class="sbx-sdk" :class="{ 'is-asking': !!request }">
    <div ref="bodyRef" class="sbx-sdk__body"></div>
    <div v-if="loadingHistory" class="sbx-sdk__loading">Loading history…</div>

    <div v-if="unknownCount" class="sbx-sdk__drift">
      {{ unknownCount }} message{{ unknownCount > 1 ? 's' : '' }} this build does not recognise — expand them above and report what they are.
    </div>

    <div class="sbx-sdk__composer">
    <!-- Claude is blocked on this. The turn is genuinely stopped until it is
         answered, which is why it sits above the composer rather than
         somewhere you could miss — and why it takes the keyboard. -->
    <RequestDialog
      v-if="request"
      :key="request.requestId"
      :request="request"
      @respond="respond"
    />

      <!-- The session's own commands, not a list this build shipped with.
           A CLI that gains a command, a plugin that adds one, a project with
           its own — all of them appear here without WootonPad knowing. -->
      <div v-if="menuItems.length" class="sbx-sdk__commands">
        <button
          v-for="(item, i) in menuItems"
          :key="item.key"
          type="button"
          class="sbx-sdk__command"
          :class="{ 'is-active': i === commandIndex }"
          @mousedown.prevent="pick(item)"
        >
          <span class="sbx-sdk__command-name">{{ item.label }}</span>
          <span v-if="item.hint" class="sbx-sdk__command-hint">{{ item.hint }}</span>
          <span v-if="item.description" class="sbx-sdk__command-desc">{{ item.description }}</span>
        </button>
      </div>

      <div class="sbx-sdk__field">
        <textarea
          ref="inputRef"
          v-model="draft"
          class="sbx-sdk__input"
          rows="1"
          :placeholder="busy ? 'Claude is working — your message will go next' : 'Message Claude…'"
          @keydown="onKey"
          @input="autoGrow"
        ></textarea>
        <!-- Enter sends; nothing else needs saying. The glyph is an
             affordance, not an instruction, and it is the only thing in the
             corner so Interrupt reads as the exception it is. -->
        <button
          v-if="busy"
          type="button"
          class="sbx-sdk__stop"
          data-tooltip="Interrupt"
          aria-label="Interrupt"
          @click="interrupt"
        >
          <SbIcon name="square" :size="12" />
        </button>
        <span v-else class="sbx-sdk__enter" aria-hidden="true">&#8629;</span>
      </div>

      <!-- Everything that changes how the next turn runs, on one line under
           the field: what Claude may do on the left, what it runs as on the
           right, and how full the window is at the end. -->
      <div class="sbx-sdk__controls">
        <select class="sbx-sdk__select" :value="permissionMode" @change="onPermissionMode">
          <option v-for="m in PERMISSION_MODES" :key="m.value" :value="m.value">{{ m.label }}</option>
        </select>

        <span class="sbx-sdk__spacer"></span>

        <select class="sbx-sdk__select sbx-sdk__select--model" :value="model" @change="onModel" :title="modelTitle">
          <option v-for="m in models" :key="m.value" :value="m.value">{{ modelLabel(m) }}</option>
        </select>

        <select
          v-if="effortLevels.length"
          class="sbx-sdk__select" :value="effort" @change="onEffort"
        >
          <option v-for="e in effortLevels" :key="e" :value="e">{{ e }}</option>
        </select>

        <span
          v-if="context"
          class="sbx-sdk__context"
          :title="`${context.totalTokens.toLocaleString()} of ${context.maxTokens.toLocaleString()} tokens`"
        >
          <UsageRing :value="context.percentage" :size="14" />
          {{ Math.round(context.percentage) }}%
        </span>

        <span v-if="init" class="sbx-sdk__about" :title="aboutTitle">v{{ init.claude_code_version }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, markRaw, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { store } from '../store.js';
import SbIcon from './SbIcon.vue';
import UsageRing from './UsageRing.vue';
import RequestDialog from './RequestDialog.vue';
import { normalize } from '../message-normalizer.ts';
import { modelLabels, defaultModelValue } from '../model-name.js';
import {
  renderViewItems, renderJsonlEntry, renderJsonlText, mergeLocalCommandEntries,
} from '../message-render.js';

const bodyRef = ref(null);
const inputRef = ref(null);
const draft = ref('');
const busy = ref(false);
const unknownCount = ref(0);

// Whatever the session is currently blocked on: a tool permission, a set of
// questions, or an MCP server asking for input. One slot, because the session
// can only be stopped on one thing at a time.
const request = ref(null);

// The CLI's own permission modes, in the order they escalate. `bypassPermissions`
// is deliberately absent: turning off every check is not a dropdown item.
const PERMISSION_MODES = [
  { value: 'auto', label: 'Auto' },
  { value: 'default', label: 'Manual' },
  { value: 'acceptEdits', label: 'Accept edits' },
  { value: 'plan', label: 'Plan' },
];
const permissionMode = ref('default');
const model = ref('');
// Set once the user picks a row by hand. Until then the picker is only ever
// showing a guess, and every later report of what is running may correct it.
let modelPinned = false;
const effort = ref('high');
const models = ref([]);
const context = ref(null);
// What the CLI reports it is actually running, from system/init at the head of
// each turn. "Default" is a row that resolves to something; this is that
// something, and it is the only honest answer to "which model is this".
const liveModel = ref('');

// The whole `system/init` payload. It arrives at the head of every turn and
// lists what this session can actually do — its commands, skills, agents,
// tools and MCP servers. Reading the UI off it rather than off a list compiled
// into WootonPad is what keeps the two from drifting apart.
const init = ref(null);

/** `claude-opus-5[1m]` → `claude-opus-5`; the suffix is already in the name. */
const wireId = (m) => String(m?.resolvedModel || m?.value || '').replace(/\[1m\]$/, '');

// "Opus 5", "Haiku 4.5" — the names the CLI's own picker uses. See
// model-name.js for why the wire id is what they are derived from.
const labels = computed(() => modelLabels(models.value));
const modelLabel = (m) => labels.value.get(m.value) || m.displayName;

const selectedModel = computed(() =>
  models.value.find(m => m.value === model.value) || models.value[0] || null);

// Effort is per model — Haiku offers none at all, and the picker should not
// promise a setting the model will ignore.
const effortLevels = computed(() => selectedModel.value?.supportedEffortLevels || []);

const modelTitle = computed(() => {
  const m = selectedModel.value;
  if (!m) return '';
  const running = liveModel.value ? `\nRunning: ${liveModel.value}` : '';
  return `${m.description || m.displayName}${running}`;
});

const sessionId = computed(() => store.headerSession?.sessionId || '');

// Tool results arrive as their own message, after the call that produced them.
// Holding them here lets renderViewItems fold a result into the call it belongs
// to, exactly as the transcript viewer does when it reads a finished .jsonl.
let toolResults = new Map();

// ── Rendering ─────────────────────────────────────────────────────

function atBottom() {
  const el = bodyRef.value;
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 60;
}

function stickBottom(stick) {
  const el = bodyRef.value;
  if (stick && el) el.scrollTop = el.scrollHeight;
}

// The working indicator and the paragraph being streamed both live at the end
// of the transcript, so finished messages have to go in front of them rather
// than after.
function tail() {
  return liveEl || workingEl || null;
}

function append(nodes) {
  const el = bodyRef.value;
  if (!el || !nodes.childNodes.length) return;
  // Only chase the bottom if the user was already there — otherwise reading
  // back through a long turn would be yanked away on every message.
  const stick = atBottom();
  const before = tail();
  if (before && before.parentNode === el) el.insertBefore(nodes, before);
  else el.appendChild(nodes);
  stickBottom(stick);
}

// ── Streaming ─────────────────────────────────────────────────────
//
// `includePartialMessages` gives the answer a token at a time. Those tokens go
// into a throwaway paragraph at the end of the transcript; when the turn's
// finished `assistant` message arrives — the same text, properly blocked —
// the throwaway is dropped and the real one takes its place. Rendering both
// would print the answer twice.

/** @type {HTMLElement|null} the paragraph currently being written into */
let liveEl = null;
let liveText = '';
/** @type {HTMLElement|null} the "working" row, last child while a turn runs */
let workingEl = null;

function streamDelta(text) {
  const el = bodyRef.value;
  if (!el || !text) return;
  const stick = atBottom();

  if (!liveEl || liveEl.parentNode !== el) {
    liveEl = document.createElement('div');
    liveEl.className = 'jsonl-entry jsonl-assistant sbx-streaming';
    const body = document.createElement('div');
    body.className = 'jsonl-text';
    liveEl.appendChild(body);
    if (workingEl && workingEl.parentNode === el) el.insertBefore(liveEl, workingEl);
    else el.appendChild(liveEl);
    liveText = '';
  }

  liveText += text;
  liveEl.firstChild.innerHTML = renderJsonlText(liveText);
  stickBottom(stick);
}

function endStream() {
  liveEl?.remove();
  liveEl = null;
  liveText = '';
}

function setWorking(on) {
  const el = bodyRef.value;
  if (!el) return;
  if (!on) { workingEl?.remove(); workingEl = null; return; }
  if (workingEl && workingEl.parentNode === el) return;
  const stick = atBottom();
  workingEl = document.createElement('div');
  workingEl.className = 'jsonl-entry jsonl-assistant sbx-working';
  workingEl.innerHTML = '<span class="sbx-working__dots"><i></i><i></i><i></i></span>'
    + '<span class="sbx-working__label">Working</span>';
  el.appendChild(workingEl);
  stickBottom(stick);
}

watch(busy, setWorking);

function handle(message) {
  if (message?.type === 'system' && message.subtype === 'init') {
    init.value = message;
    if (message.model) liveModel.value = message.model;
  }
  const items = normalize(message);

  for (const item of items) {
    if (item.kind === 'unknown') unknownCount.value++;
    // Remember results before rendering, so a call in the same batch can claim
    // one; a late result renders on its own.
    if (item.kind === 'tool_result' && item.toolUseId) {
      toolResults.set(item.toolUseId, item.content);
    }
    if (item.kind === 'turn_end') {
      endStream();
      busy.value = false;
      refreshContext();
    } else if (item.kind === 'delta') {
      // Any frame at all means the turn is alive — including one carrying no
      // text, which is what a long thinking block looks like from here. That
      // also covers a session driven from somewhere else: nothing was typed
      // into this composer, so nothing set busy.
      busy.value = true;
      if (item.target === 'text') streamDelta(item.text);
    } else if (item.kind !== 'silent') {
      // A real message closes the streamed draft: either it is the finished
      // version of it, or the model has moved on to a tool call.
      endStream();
      if (item.kind === 'text' || item.kind === 'tool_use' || item.kind === 'thinking') {
        busy.value = true;
      }
    }
  }

  append(renderViewItems(items, toolResults, { foldTools: true }));
}

// ── Input ─────────────────────────────────────────────────────────

function send() {
  const text = draft.value.trim();
  if (!text || !sessionId.value) return;
  // Echoed locally: the CLI does not send the prompt back, and a message that
  // vanishes on submit reads as a dropped one.
  append(renderViewItems([{ kind: 'text', role: 'user', text }]));
  window.api.sendInput(sessionId.value, text);
  draft.value = '';
  busy.value = true;
  nextTick(() => { autoGrow(); inputRef.value?.focus(); });
}

// One row until there is more to show. Reset to auto first so the box can
// shrink again when text is deleted, then take the content's own height up to
// a ceiling — past that it scrolls rather than eating the transcript.
const MAX_INPUT_HEIGHT = 220;
function autoGrow() {
  const el = inputRef.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, MAX_INPUT_HEIGHT) + 'px';
}

function onKey(event) {
  const menu = menuItems.value;
  if (menu.length) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      commandIndex.value = (commandIndex.value + 1) % menu.length;
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      commandIndex.value = (commandIndex.value - 1 + menu.length) % menu.length;
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      // Dismiss the menu, not the sentence: a file mention is usually typed
      // in the middle of one already worth keeping.
      draft.value = draft.value.startsWith('/') ? '' : `${draft.value} `;
      return;
    }
    // Enter completes rather than sending a half-typed command or path.
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      pick(menu[commandIndex.value]);
      return;
    }
  }
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    send();
  }
}

// The dialog decides what the answer is; this only knows where to send it.
// Elicitation and permission are separate control channels in the CLI and
// stay separate here.
function respond(decision) {
  const pending = request.value;
  if (!pending) return;
  request.value = null;
  // Flattened to plain JSON on the way out. The answer carries the tool input
  // back, and IPC serialises it with the structured-clone algorithm, which
  // refuses a Proxy outright — one reactive object that slipped in throws
  // *after* the dialog has closed, leaving the session blocked with nothing on
  // screen to answer. The payload is JSON on both sides of this call anyway.
  const plain = JSON.parse(JSON.stringify(decision));
  if (pending.kind === 'elicitation') window.api.sdkElicitationResponse(pending.requestId, plain);
  else if (pending.kind === 'dialog') window.api.sdkDialogResponse(pending.requestId, plain);
  else window.api.sdkPermissionResponse(pending.requestId, plain);
  // Answering hands the turn back, so the composer should be ready for the
  // next thing to say rather than leaving focus on a dialog that is gone.
  nextTick(() => inputRef.value?.focus());
}

// ── Session controls ──────────────────────────────────────────────

async function onPermissionMode(event) {
  const value = event.target.value;
  const res = await window.api.sdkSetPermissionMode(sessionId.value, value);
  if (res?.ok) permissionMode.value = value;
}

async function onModel(event) {
  const value = event.target.value;
  const res = await window.api.sdkSetModel(sessionId.value, value);
  if (!res?.ok) return;
  model.value = value;
  modelPinned = true;
  // The new model may not offer the level the old one was on.
  const levels = effortLevels.value;
  if (levels.length && !levels.includes(effort.value)) {
    effort.value = levels.includes('high') ? 'high' : levels[levels.length - 1];
    window.api.sdkSetEffort(sessionId.value, effort.value);
  }
}

async function onEffort(event) {
  const value = event.target.value;
  const res = await window.api.sdkSetEffort(sessionId.value, value);
  if (res?.ok) effort.value = value;
}

// Read after a turn ends rather than on a timer: the number only moves when
// the conversation does, and this is a control request the session has to
// answer.
async function refreshContext() {
  if (!sessionId.value) return;
  const res = await window.api.sdkContextUsage(sessionId.value);
  if (res?.ok && res.value) context.value = res.value;
}

async function loadModels() {
  const res = await window.api.sdkModels(sessionId.value);
  if (!res?.ok || !Array.isArray(res.value)) return;
  models.value = res.value;
  syncSelectedModel();
}

// The list can only be fetched once the session is up, and on a chat opened
// before that it comes back empty — leaving the picker blank for the rest of
// the session. `system/init` is the first thing that proves the CLI is
// answering, so it is also the moment to ask again.
watch(init, () => { if (!models.value.length) loadModels(); });

/**
 * Point the picker at the row the session is actually running, matched by the
 * wire id rather than the alias — several rows resolve to the same model, and
 * the alias alone cannot say which.
 *
 * Runs on both sides of a race: the model list is fetched on mount, but the
 * CLI only says what it is running when the first turn opens, and either can
 * land first.
 */
function syncSelectedModel() {
  // A choice the user made outranks anything reported afterwards.
  if (modelPinned || !models.value.length) return;

  if (liveModel.value) {
    const running = liveModel.value.replace(/\[1m\]$/, '');
    const match = models.value.find(m => wireId(m) === running);
    if (match) { model.value = match.value; return; }
  }
  // Nothing has run yet, so there is nothing to report — but the session still
  // has a model, and a picker showing an empty box reads as broken rather than
  // as "not chosen". Show the row it will actually use until init says
  // otherwise.
  if (!model.value) model.value = defaultModelValue(models.value);
}

watch(liveModel, syncSelectedModel);

// ── Completion menus ──────────────────────────────────────────────
//
// Two menus share one strip above the field, because they are the same
// gesture: type a sigil, narrow a list, pick. `/` offers what this session can
// run — with the descriptions the CLI itself writes — and `@` offers the
// files of the project it is running in.

const commandIndex = ref(0);
const commandInfo = ref([]);   // SlashCommand[] from the session
const files = ref([]);         // relative paths, flattened from the file tree

// Commands the CLI tags as bound to a terminal — exit, doctor, colour pickers.
// The SDK's own docs say remote surfaces should hide them, and a chat has no
// terminal for them to act on.
const availableCommands = computed(() => {
  const all = init.value?.slash_commands || [];
  const terminalOnly = new Set(init.value?.terminal_slash_commands || []);
  return all.filter(c => !terminalOnly.has(c));
});

/** name → the CLI's own description and argument hint, when it gave one. */
const commandDetail = computed(() => {
  const map = new Map();
  for (const c of commandInfo.value) if (c?.name) map.set(c.name, c);
  return map;
});

const commandMatches = computed(() => {
  const text = draft.value;
  // Only while typing the command itself: a slash inside a sentence, or a
  // command already followed by its argument, is not a menu.
  if (!text.startsWith('/') || text.includes(' ') || text.includes('\n')) return [];
  const prefix = text.slice(1).toLowerCase();
  return availableCommands.value
    .filter(c => c.toLowerCase().startsWith(prefix))
    .slice(0, 8)
    .map((name) => {
      const detail = commandDetail.value.get(name);
      return {
        key: `cmd:${name}`,
        kind: 'command',
        value: name,
        label: `/${name}`,
        hint: detail?.argumentHint || '',
        description: detail?.description || '',
      };
    });
});

// `@` completes a path, so the token is whatever follows the last `@` that is
// still being typed — mid-sentence included, which is where file mentions
// actually appear.
const fileToken = computed(() => {
  const text = draft.value;
  const at = text.lastIndexOf('@');
  if (at === -1) return null;
  const token = text.slice(at + 1);
  if (/[\s\n]/.test(token)) return null;      // the mention is finished
  return { at, token };
});

const fileMatches = computed(() => {
  const found = fileToken.value;
  if (!found || !files.value.length) return [];
  const needle = found.token.toLowerCase();
  const scored = [];
  for (const path of files.value) {
    const lower = path.toLowerCase();
    const index = lower.indexOf(needle);
    if (needle && index === -1) continue;
    // A match on the file's own name beats one buried in a directory: typing
    // "app" means app.js far more often than it means src/app/thing.ts.
    const base = lower.split('/').pop();
    const rank = !needle ? 2 : base.startsWith(needle) ? 0 : lower.startsWith(needle) ? 1 : 2;
    scored.push({ path, rank, index });
    if (scored.length > 400) break;
  }
  scored.sort((a, b) => a.rank - b.rank || a.index - b.index || a.path.length - b.path.length);
  return scored.slice(0, 8).map(({ path }) => ({
    key: `file:${path}`,
    kind: 'file',
    value: path,
    label: path.split('/').pop(),
    hint: '',
    description: path,
  }));
});

// One strip, one keyboard: a slash command being typed wins, otherwise a file.
const menuItems = computed(() =>
  commandMatches.value.length ? commandMatches.value : fileMatches.value);

watch(menuItems, () => { commandIndex.value = 0; });

function pick(item) {
  if (!item) return;
  if (item.kind === 'command') {
    draft.value = `/${item.value} `;
  } else {
    const found = fileToken.value;
    if (!found) return;
    draft.value = `${draft.value.slice(0, found.at)}@${item.value} `;
  }
  nextTick(() => { autoGrow(); inputRef.value?.focus(); });
}

async function loadCommands() {
  const res = await window.api.sdkCommands(sessionId.value);
  if (res?.ok && Array.isArray(res.value)) commandInfo.value = res.value;
}

// Flattened once per session. The tree is already pruned in the main process
// (no .git, no node_modules, five levels deep), so this is a list of the paths
// a person would actually reference.
async function loadFiles() {
  const projectPath = store.headerSession?.projectPath;
  if (!projectPath) return;
  const res = await window.api.getFileTree(projectPath).catch(() => null);
  if (!res?.ok) return;
  const flat = [];
  const walk = (nodes) => {
    for (const node of nodes || []) {
      if (node.isDir) walk(node.children);
      else flat.push(node.path);
    }
  };
  walk(res.tree);
  files.value = flat;
}

const aboutTitle = computed(() => {
  const i = init.value;
  if (!i) return '';
  return [
    `Claude Code ${i.claude_code_version}`,
    `${(i.tools || []).length} tools · ${(i.skills || []).length} skills · ${(i.agents || []).length} agents`,
    `${availableCommands.value.length} commands`,
    (i.mcp_servers || []).length ? `MCP: ${i.mcp_servers.map(m => m.name).join(', ')}` : '',
    `Output style: ${i.output_style}`,
  ].filter(Boolean).join('\n');
});

// A dialog is a message, and a reload loses messages — but not the CLI's
// patience, which is still parked on the promise behind it. Ask what this
// session is stopped on rather than leaving it stopped with a blank composer.
async function loadPending() {
  if (!sessionId.value) return;
  const list = await window.api.sdkPendingRequests?.(sessionId.value).catch(() => null);
  if (!Array.isArray(list) || !list.length || request.value) return;
  request.value = markRaw(list[0]);
}

async function interrupt() {
  if (!sessionId.value) return;
  await window.api.sdkInterrupt(sessionId.value);
}

// ── Wiring ────────────────────────────────────────────────────────

let detach = null;

// A session opened in this view did not necessarily start in it. The transcript
// on disk is the same file either way, so the history is read back and painted
// with the same renderer the transcript viewer uses — a session started in a
// terminal months ago opens here as a chat, and carries on as one.
const loadingHistory = ref(true);

async function loadHistory() {
  const id = sessionId.value;
  if (!id) { loadingHistory.value = false; return; }
  try {
    const result = await window.api.readSessionJsonl(id);
    if (sessionId.value !== id) return;          // switched away mid-read
    const entries = mergeLocalCommandEntries(result?.entries || []);

    // A tool's result lands in a later entry than its call. Collect them first
    // so each call renders with its own result folded in, as the transcript
    // viewer does.
    const results = new Map();
    for (const entry of entries) {
      const blocks = entry.message?.content || entry.content;
      if (!Array.isArray(blocks)) continue;
      for (const block of blocks) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          results.set(block.tool_use_id, block.content || block.output || '');
        }
      }
    }

    const frag = document.createDocumentFragment();
    for (const entry of entries) {
      const el = renderJsonlEntry(entry, results, { foldTools: true });
      if (el) frag.appendChild(el);
    }
    const body = bodyRef.value;
    if (body && frag.childNodes.length) {
      body.appendChild(frag);
      body.scrollTop = body.scrollHeight;
    }
  } catch {
    /* A session with no transcript yet is the normal case for a new one. */
  } finally {
    loadingHistory.value = false;
  }
}

onMounted(() => {
  const onMessage = (id, message) => {
    if (id !== sessionId.value) return;
    handle(message);
  };
  window.api.onSdkMessage(onMessage);

  // markRaw, because the request is read and never edited — and because the
  // answer carries the tool input straight back over IPC. A reactive proxy
  // cannot be structured-cloned, so making it reactive would break the reply.
  window.api.onSdkPermissionRequest((id, incoming) => {
    if (id !== sessionId.value) return;
    request.value = markRaw(incoming);
  });
  window.api.onSdkElicitationRequest?.((id, incoming) => {
    if (id !== sessionId.value) return;
    request.value = markRaw({ ...incoming, kind: 'elicitation' });
  });
  window.api.onSdkDialogRequest?.((id, incoming) => {
    if (id !== sessionId.value) return;
    request.value = markRaw({ ...incoming, kind: 'dialog' });
  });
  // The CLI can withdraw the question — an interrupted turn. Take the dialog
  // down rather than leave a button that answers nothing.
  window.api.onSdkPermissionCancelled((id, requestId) => {
    if (request.value?.requestId === requestId) request.value = null;
  });
  // preload exposes no unsubscribe; guard by id instead and drop the reference
  // so a stale closure cannot keep rendering into a detached node.
  detach = () => { bodyRef.value = null; };
  loadHistory();
  loadPending();
  loadModels();
  loadCommands();
  loadFiles();
  refreshContext();
  nextTick(() => inputRef.value?.focus());
});

onBeforeUnmount(() => {
  detach?.();
  toolResults = new Map();
  liveEl = null;
  workingEl = null;
  liveText = '';
});

defineExpose({ handle });
</script>
