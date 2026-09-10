<template>
  <button
    ref="triggerRef"
    type="button"
    class="sbx-smenu__trigger"
    :class="{ 'is-open': open }"
    :data-tooltip="open ? null : 'Session menu'"
    aria-label="Session menu"
    :aria-expanded="open"
    @click.stop="toggle"
    @dblclick.stop
  >
    <SbIcon name="ellipsis" :size="14" tone="muted" />
  </button>

  <!-- Teleported: the sidebar and the board columns both clip their overflow,
       and a menu opened on the last card would be cut off inside either. -->
  <Teleport to="body">
    <div
      v-if="open"
      ref="menuRef"
      class="sbx-smenu"
      :style="pos"
      role="menu"
      @click.stop
      @dblclick.stop
      @mousedown.stop
    >
      <!-- Renaming happens in the menu rather than in the row: the board has
           cards, not rows, and this is the one control both hosts share. -->
      <div v-if="renaming" class="sbx-smenu__rename">
        <input
          ref="renameInput"
          v-model="renameValue"
          class="sbx-smenu__renameinput"
          type="text"
          placeholder="Session name"
          @keydown.enter="saveRename"
          @keydown.esc.stop="renaming = false"
        />
        <div class="sbx-smenu__renamerow">
          <button type="button" class="sbx-smenu__renamebtn" @click="renaming = false">Cancel</button>
          <button type="button" class="sbx-smenu__renamebtn is-primary" @click="saveRename">Save</button>
        </div>
        <p class="sbx-smenu__muted">Leave it empty to go back to the session's own first line.</p>
      </div>

      <div v-else class="sbx-smenu__actions">
        <button type="button" class="sbx-smenu__item" role="menuitem" @click="run(openSession)">
          <SbIcon name="square-arrow-out-up-right" :size="13" tone="muted" />
          <span>Open session</span>
        </button>

        <button type="button" class="sbx-smenu__item" role="menuitem" @click="startRename">
          <SbIcon name="pencil" :size="13" tone="muted" />
          <span>Rename…</span>
        </button>

        <button type="button" class="sbx-smenu__item" role="menuitem" @click="run(() => sb('toggleStar', id))">
          <SbIcon :name="session.starred ? 'pin-off' : 'pin'" :size="13" tone="muted" />
          <span>{{ session.starred ? 'Unpin' : 'Pin' }}</span>
        </button>

        <button
          v-if="isRunning"
          type="button"
          class="sbx-smenu__item"
          role="menuitem"
          @click="run(() => sb('stopSession', id))"
        >
          <SbIcon name="square-stop" :size="13" tone="muted" />
          <span>Stop session</span>
        </button>

        <template v-if="session.type !== 'terminal'">
          <button type="button" class="sbx-smenu__item" role="menuitem" @click="run(() => sb('forkSession', id))">
            <SbIcon name="git-fork" :size="13" tone="muted" />
            <span>Fork session</span>
          </button>

          <button
            v-if="!isRunning"
            type="button"
            class="sbx-smenu__item"
            role="menuitem"
            @click="run(() => sb('launchConfig', id))"
          >
            <SbIcon name="settings" :size="13" tone="muted" />
            <span>Resume with config…</span>
          </button>

          <button type="button" class="sbx-smenu__item" role="menuitem" @click="run(() => sb('showJsonl', id))">
            <SbIcon name="message-square" :size="13" tone="muted" />
            <span>View messages</span>
          </button>
        </template>

        <!-- Stays open: the answer lands in this menu. -->
        <button
          type="button"
          class="sbx-smenu__item"
          role="menuitem"
          :disabled="summaryPending"
          @click="summarize"
        >
          <SbIcon name="sparkles" :size="13" tone="muted" />
          <span>{{ summaryPending ? 'Summarizing…' : 'Summarize recent work' }}</span>
        </button>

        <button type="button" class="sbx-smenu__item" role="menuitem" @click="run(() => sb('archiveSession', id))">
          <SbIcon name="archive" :size="13" tone="muted" />
          <span>{{ session.archived ? 'Unarchive' : 'Archive' }}</span>
        </button>
      </div>

      <!-- ── Summarize output ─────────────────────────────────────── -->
      <div v-if="summaryPending || summary || summaryError" class="sbx-smenu__summary">
        <div class="sbx-smenu__summaryhead">
          <span class="sbx-smenu__sectiontitle">Recent work</span>
          <button
            v-if="summaryPending"
            type="button"
            class="sbx-smenu__stop"
            @click="abortSummary"
          >Stop</button>
        </div>
        <p v-if="summaryPending" class="sbx-smenu__muted">Reading the last few turns…</p>
        <p v-else-if="summaryError" class="sbx-smenu__error">{{ summaryError }}</p>
        <p v-else class="sbx-smenu__summarytext">{{ summary }}</p>
        <p v-if="summaryUsage" class="sbx-smenu__usage">
          {{ compact(summaryUsage.inputTokens) }} in · {{ compact(summaryUsage.outputTokens) }} out
          <template v-if="summaryUsage.costUSD"> · ${{ summaryUsage.costUSD.toFixed(3) }}</template>
        </p>
      </div>

      <!-- ── Facts ────────────────────────────────────────────────── -->
      <div class="sbx-smenu__info">
        <span class="sbx-smenu__sectiontitle">Session</span>

        <dl class="sbx-smenu__rows">
          <div v-for="row in rows" :key="row.label" class="sbx-smenu__row">
            <dt>{{ row.label }}</dt>
            <dd :title="row.title || undefined">{{ row.value }}</dd>
          </div>
        </dl>

        <p v-if="metaPending" class="sbx-smenu__muted">Reading the transcript…</p>
        <p v-else-if="metaError" class="sbx-smenu__error">{{ metaError }}</p>

        <template v-if="firstPrompt">
          <span class="sbx-smenu__sectiontitle">First prompt</span>
          <p class="sbx-smenu__prompt">{{ firstPrompt }}</p>
        </template>

        <button type="button" class="sbx-smenu__copy" @click="copyId">
          <SbIcon :name="copied ? 'check' : 'copy'" :size="11" tone="muted" />
          <span>{{ copied ? 'Copied' : id }}</span>
        </button>
      </div>

      <!-- Last, below the facts: the one irreversible item here, kept out of
           the reach of a click aimed at the list above it. -->
      <div class="sbx-smenu__danger">
        <button
          type="button"
          class="sbx-smenu__item sbx-smenu__item--danger"
          role="menuitem"
          @click="run(remove)"
        >
          <SbIcon name="trash-2" :size="13" tone="muted" />
          <span>Delete session</span>
        </button>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, computed, nextTick, onUnmounted } from 'vue';
import SbIcon from './SbIcon.vue';

const props = defineProps({
  session: { type: Object, required: true },
  isRunning: { type: Boolean, default: false },
});

const id = computed(() => props.session.sessionId);

// Everything a menu item does already exists on the app.js bridge, and every
// path from a session row to it runs through the same object. Going straight
// there beats threading eight more emits through ProjectGroup and the board.
function sb(name, ...args) { window.__sb?.[name]?.(...args); }

// ── Open / close ──────────────────────────────────────────────────
const open = ref(false);
const triggerRef = ref(null);
const menuRef = ref(null);
const pos = ref({});

function place() {
  const rect = triggerRef.value?.getBoundingClientRect();
  if (!rect) return;
  const width = 300;
  const margin = 8;
  let left = rect.right - width;
  left = Math.min(Math.max(left, margin), window.innerWidth - width - margin);
  pos.value = {
    left: left + 'px',
    top: rect.bottom + 6 + 'px',
    width: width + 'px',
    maxHeight: Math.min(560, window.innerHeight - 2 * margin) + 'px',
  };
  // Flip only once the real height is known — most menus fit below, and
  // reserving max-height for the decision would flip nearly all of them.
  nextTick(() => {
    const el = menuRef.value;
    if (!el) return;
    const height = el.offsetHeight;
    if (rect.bottom + 6 + height > window.innerHeight - margin) {
      pos.value = { ...pos.value, top: Math.max(margin, rect.top - 6 - height) + 'px' };
    }
  });
}

function onDocDown() { close(); }
function onKey(e) { if (e.key === 'Escape') close(); }

function close() {
  if (!open.value) return;
  open.value = false;
  // Reopening should land on the action list, not on a half-typed name.
  renaming.value = false;
  document.removeEventListener('mousedown', onDocDown);
  document.removeEventListener('keydown', onKey);
  window.removeEventListener('resize', close);
}

function toggle() {
  if (open.value) { close(); return; }
  open.value = true;
  document.addEventListener('mousedown', onDocDown);
  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', close);
  place();
  loadMeta();
}

onUnmounted(close);

// Every item but Summarize is a one-shot action; the menu has no reason to
// stay open behind it.
function run(fn) {
  close();
  fn();
}

function openSession() {
  window.vueApp?.setTab?.('sessions');
  sb('openSession', props.session);
}

// ── Rename ────────────────────────────────────────────────────────
const renaming = ref(false);
const renameValue = ref('');
const renameInput = ref(null);

function startRename() {
  // Only a name the user set. Seeding this with the auto summary would mean
  // clearing 120 characters of the first prompt before typing anything.
  renameValue.value = props.session.name || '';
  renaming.value = true;
  // The list shrinks to the rename box, so the menu has to be re-placed.
  nextTick(() => {
    renameInput.value?.focus();
    renameInput.value?.select();
    place();
  });
}

function saveRename() {
  const name = renameValue.value.trim();
  renaming.value = false;
  close();
  sb('renameSession', id.value, name || null);
}

async function remove() {
  const name = window.cleanDisplayName
    ? window.cleanDisplayName(props.session.name || props.session.summary)
    : (props.session.name || props.session.summary);
  if (!confirm(`Delete "${name}"?\n\nThis removes the transcript from ~/.claude/projects. It cannot be undone.`)) return;
  sb('deleteSession', id.value);
}

// ── Facts ─────────────────────────────────────────────────────────
const meta = ref(null);
const metaPending = ref(false);
const metaError = ref('');

async function loadMeta() {
  if (meta.value || metaPending.value) return;
  const call = window.api?.getSessionMeta;
  if (typeof call !== 'function') {
    metaError.value = 'Session details are unavailable in this build — restart Switchboard.';
    return;
  }
  metaPending.value = true;
  metaError.value = '';
  try {
    const result = await call(id.value);
    if (result?.ok) meta.value = result;
    else metaError.value = result?.error || 'Could not read the transcript.';
  } catch (e) {
    metaError.value = e?.message || String(e);
  } finally {
    metaPending.value = false;
  }
}

function compact(n) {
  const value = Number(n) || 0;
  if (value >= 1e9) return (value / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (value >= 1e6) return (value / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (value >= 1e3) return (value / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(value);
}

function stamp(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const rel = window.formatDate ? window.formatDate(date) : '';
  return { value: rel || date.toLocaleString(), title: date.toLocaleString() };
}

function duration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

// Anything the cached session already knows is shown immediately; the rest
// fills in when the transcript read returns.
const rows = computed(() => {
  const s = props.session;
  const m = meta.value;
  const out = [];
  const push = (label, value, title) => {
    if (value === null || value === undefined || value === '' || value === 0) return;
    out.push({ label, value: String(value), title });
  };

  const created = stamp(m?.created || s.created);
  if (created) out.push({ label: 'Created', value: created.value, title: created.title });
  const active = stamp(m?.lastActivity || window.lastActivityTime?.get(s.sessionId) || s.modified);
  if (active) out.push({ label: 'Last active', value: active.value, title: active.title });
  if (m) push('Duration', duration(new Date(m.lastActivity) - new Date(m.created)));

  push('Status', props.isRunning ? 'Running' : (s.archived ? 'Archived' : null));
  push('Messages', m ? `${m.userTurns} user · ${m.assistantTurns} assistant` : s.messageCount);

  const added = m?.linesAdded ?? s.linesAdded;
  const removed = m?.linesRemoved ?? s.linesRemoved;
  if (added || removed) push('Churn', `+${added || 0} −${removed || 0}`);

  if (m) {
    const spent = [];
    if (m.outputTokens) spent.push(`${compact(m.outputTokens)} out`);
    if (m.inputTokens) spent.push(`${compact(m.inputTokens)} in`);
    if (spent.length) out.push({ label: 'Tokens', value: spent.join(' · ') });
    if (m.cacheCreateTokens || m.cacheReadTokens) {
      out.push({
        label: 'Cache',
        value: `${compact(m.cacheCreateTokens)} written · ${compact(m.cacheReadTokens)} read`,
      });
    }
    if (m.costUSD) push('Cost', `$${m.costUSD.toFixed(4)}`);
    if (m.fileBytes) push('Transcript', `${compact(m.fileBytes)}B`);
  }

  // Tool calls, file count, model, effort, branch, CLI version, slug and
  // project are deliberately not here: the row and the card already carry the
  // project and the churn, and the rest is not what this panel is opened for.
  return out;
});

const firstPrompt = computed(() => meta.value?.firstPrompt || props.session.firstPrompt || props.session.summary || '');

const copied = ref(false);
function copyId() {
  navigator.clipboard?.writeText(id.value);
  copied.value = true;
  setTimeout(() => { copied.value = false; }, 1500);
}

// ── Summarize ─────────────────────────────────────────────────────
const summary = ref('');
const summaryError = ref('');
const summaryPending = ref(false);
const summaryUsage = ref(null);

async function summarize() {
  if (summaryPending.value) return;
  const call = window.api?.boardSummarizeSessions;
  if (typeof call !== 'function') {
    summaryError.value = 'Summaries are unavailable in this build — restart Switchboard.';
    return;
  }
  summaryPending.value = true;
  summaryError.value = '';
  summary.value = '';
  summaryUsage.value = null;
  try {
    const name = window.cleanDisplayName
      ? window.cleanDisplayName(props.session.name || props.session.summary)
      : (props.session.name || props.session.summary);
    const result = await call(
      [{ sessionId: id.value, projectPath: props.session.projectPath, title: name || id.value }],
      { detail: true }
    );
    if (result?.ok) {
      summary.value = result.summaries?.[0]?.summary || '';
      summaryUsage.value = result.usage || null;
      if (!summary.value) summaryError.value = 'claude returned no summary for this session.';
    } else {
      summaryError.value = result?.cancelled ? 'Stopped.' : (result?.error || 'Could not generate a summary.');
    }
  } catch (e) {
    summaryError.value = e?.message || String(e);
  } finally {
    summaryPending.value = false;
    // The answer changes the menu's height, so it may no longer fit where it
    // was placed.
    place();
  }
}

function abortSummary() { window.api?.boardSummarizeAbort?.(); }
</script>
