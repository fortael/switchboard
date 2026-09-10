<template>
  <div class="sbx-boardside">
    <!-- ── Summary ──────────────────────────────────────────────────
         What every session on the board just finished, in one place, so the
         board can be read without opening anything. -->
    <section
      class="sbx-boardside__block sbx-boardside__block--summary"
      :class="{ 'is-collapsed': collapsed }"
    >
      <!-- The whole title bar is the toggle; the buttons on it stop the click
           so pressing Summarize never also folds the answer away. -->
      <header
        class="sbx-boardside__head sbx-boardside__head--toggle"
        role="button"
        :aria-expanded="!collapsed"
        @click="collapsed = !collapsed"
      >
        <SbIcon
          name="chevron-down"
          :size="12"
          tone="muted"
          class="sbx-boardside__chevron"
          :class="{ 'is-collapsed': collapsed }"
        />
        <SbIcon name="sparkles" :size="13" tone="muted" />
        <span class="sbx-boardside__title">Summary</span>
        <button
          v-if="pending"
          type="button"
          class="sbx-boardside__action sbx-boardside__action--stop"
          data-tooltip="Stop the claude call"
          @click.stop="stop"
        >Stop</button>
        <button
          type="button"
          class="sbx-boardside__action"
          :class="{ 'is-busy': pending }"
          :disabled="pending || !boardSessions.length"
          :data-tooltip="pending
            ? 'Asking claude…'
            : `Reads only the last message of each of the ${summarizable.length} most recent sessions on the board, not the whole session`"
          @click.stop="summarize"
        >{{ pending ? 'Summarizing…' : 'Summarize' }}</button>
      </header>

      <div v-show="!collapsed" class="sbx-boardside__body sbx-boardside__body--summary">
        <p v-if="pending" class="sbx-boardside__note">
          Reading {{ summarizable.length }} session{{ summarizable.length === 1 ? '' : 's' }} — this runs one headless claude call and can take a while.
        </p>
        <p v-else-if="error" class="sbx-boardside__error">{{ error }}</p>
        <p v-else-if="!entries.length" class="sbx-boardside__note">
          {{ boardSessions.length
            ? 'Summarize reads the last message of each session on the board and reports what it just finished.'
            : 'Nothing on the board to summarize.' }}
        </p>

        <article v-for="entry in entries" :key="entry.sessionId" class="sbx-boardside__entry">
          <p class="sbx-boardside__text">{{ entry.summary }}</p>
          <button
            type="button"
            class="sbx-boardside__link"
            :title="entry.projectPath"
            @click="select(entry)"
          >
            <ProjectAvatar class="sbx-boardside__avatar" :project-path="entry.projectPath" />
            <span class="sbx-boardside__linktext">{{ entry.title }}</span>
            <SbIcon name="square-arrow-out-up-right" :size="11" tone="muted" />
          </button>
        </article>

        <p v-if="usage" class="sbx-boardside__usage">
          {{ usage.inputTokens.toLocaleString() }} in · {{ usage.outputTokens.toLocaleString() }} out
          <template v-if="usage.costUSD"> · ${{ usage.costUSD.toFixed(3) }}</template>
        </p>
      </div>
    </section>

    <!-- ── Projects ─────────────────────────────────────────────────
         The Projects tab's row stripped to what scoping a board needs:
         no containers, no git. Counts are the board's own counts, taken
         before the project filter so switching between them is possible. -->
    <section class="sbx-boardside__block sbx-boardside__block--projects">
      <header class="sbx-boardside__head">
        <SbIcon name="folder" :size="13" tone="muted" />
        <span class="sbx-boardside__title">Projects</span>
        <span class="sbx-boardside__count">{{ rows.length }}</span>
      </header>

      <div class="sbx-boardside__body">
        <button
          type="button"
          class="sbx-boardside__proj"
          :class="{ 'is-active': !store.boardProjectFilter }"
          @click="pick(null)"
        >
          <span class="sbx-boardside__allicon"><SbIcon name="list" :size="11" /></span>
          <span class="sbx-boardside__projname">All projects</span>
          <span class="sbx-boardside__projcount">{{ total }}</span>
        </button>

        <!-- A div, not a button: the New session control is a real button and
             cannot be nested inside one. -->
        <div
          v-for="row in rows"
          :key="row.projectPath"
          class="sbx-boardside__proj"
          :class="{ 'is-active': row.projectPath === store.boardProjectFilter }"
          role="button"
          tabindex="0"
          :title="row.projectPath"
          @click="pick(row.projectPath)"
          @keydown.enter.prevent="pick(row.projectPath)"
          @keydown.space.prevent="pick(row.projectPath)"
        >
          <ProjectAvatar class="sbx-boardside__avatar" :project-path="row.projectPath" />
          <span class="sbx-boardside__projname">{{ row.name }}</span>
          <!-- Before the count, not after: the counts have to stay in one
               right-aligned column, and All projects carries no + to pad it. -->
          <button
            type="button"
            class="sbx-boardside__new"
            data-tooltip="New session in this project"
            aria-label="New session in this project"
            @click.stop="newSession(row, $event)"
          >
            <SbIcon name="plus" :size="11" tone="muted" />
          </button>
          <span class="sbx-boardside__projcount">{{ row.count }}</span>
        </div>

        <p v-if="!rows.length" class="sbx-boardside__note">No sessions match the current filters.</p>
      </div>
    </section>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { store } from '../store.js';
import SbIcon from './SbIcon.vue';
import ProjectAvatar from './ProjectAvatar.vue';
import { filterSessions } from '../session-filter.js';

const props = defineProps({
  callbacks: { type: Object, required: true },
});

// One claude call has to hold every transcript at once, so the board's tail is
// where it gets cut. Most recent first, so what falls off the end is the work
// furthest from the user's attention.
const MAX_SUMMARIZED = 12;

// Same rules SessionBoardApp applies, minus the project filter — these counts
// are what you would see *if* you picked that project, which is the only
// reading that lets you move between them.
const boardFilters = computed(() => ({
  showArchived: store.showArchived,
  showStarredOnly: store.showStarredOnly,
  showRunningOnly: store.showRunningOnly,
  showTodayOnly: store.showTodayOnly,
  searchMatchIds: store.searchMatchIds,
  activePtyIds: store.activePtyIds,
}));

const rows = computed(() => {
  const out = [];
  for (const project of store.projects) {
    const count = filterSessions(project.sessions, boardFilters.value).length;
    if (!count) continue;
    out.push({
      projectPath: project.projectPath,
      name: project.projectPath.split('/').filter(Boolean).pop() || project.projectPath,
      count,
      // The new-session popover needs the project itself, not just its path.
      project,
    });
  }
  return out.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
});

const total = computed(() => rows.value.reduce((n, r) => n + r.count, 0));

// Every session the board is currently drawing — the project filter included,
// because this is the set the Summarize button describes.
const boardSessions = computed(() => {
  const out = [];
  for (const project of store.projects) {
    if (store.boardProjectFilter && project.projectPath !== store.boardProjectFilter) continue;
    for (const session of filterSessions(project.sessions, boardFilters.value)) out.push(session);
  }
  return out.sort((a, b) => new Date(b.modified || 0) - new Date(a.modified || 0));
});

const summarizable = computed(() => boardSessions.value.slice(0, MAX_SUMMARIZED));

function titleOf(session) {
  const name = session.name || session.summary;
  return (window.cleanDisplayName ? window.cleanDisplayName(name) : name) || session.sessionId;
}

function pick(projectPath) {
  store.boardProjectFilter = store.boardProjectFilter === projectPath ? null : projectPath;
}

// Anchored to the + itself so the popover opens beside the row it belongs to.
function newSession(row, event) {
  window.__sb?.newSession?.(row.project, event.currentTarget);
}

function select(entry) {
  if (entry.session) props.callbacks.selectSession?.(entry.session);
}

// ── Summarize ─────────────────────────────────────────────────────
const pending = ref(false);
const error = ref('');
const entries = ref([]);
// What the last Summarize actually cost, straight from the CLI's json envelope.
const usage = ref(null);

// Folded away by default once the user folds it: the projects below are the
// control they reach for most, and a run of summaries pushes them down.
const collapsed = ref(localStorage.getItem('boardSummaryCollapsed') === '1');
watch(collapsed, (value) => localStorage.setItem('boardSummaryCollapsed', value ? '1' : '0'));

function stop() {
  window.api?.boardSummarizeAbort?.();
}

async function summarize() {
  if (pending.value) return;
  const sessions = summarizable.value;
  if (!sessions.length) return;
  // Asking for a summary means wanting to read one.
  collapsed.value = false;

  // preload.js declares the channel, so an older running renderer against a
  // newer bundle is the only way this is missing — say so rather than showing
  // a TypeError.
  const call = window.api?.boardSummarizeSessions;
  if (typeof call !== 'function') {
    error.value = 'Summaries are unavailable in this build — restart WootonPad.';
    entries.value = [];
    return;
  }

  pending.value = true;
  error.value = '';
  usage.value = null;
  try {
    const byId = new Map(sessions.map(s => [s.sessionId, s]));
    const result = await call(sessions.map(s => ({
      sessionId: s.sessionId,
      projectPath: s.projectPath,
      title: titleOf(s),
    })));
    if (!result?.ok) {
      entries.value = [];
      usage.value = null;
      error.value = result?.cancelled ? 'Stopped.' : (result?.error || 'Could not generate summaries.');
      return;
    }
    entries.value = (result.summaries || [])
      .filter(s => byId.has(s.sessionId) && s.summary)
      .map(s => {
        const session = byId.get(s.sessionId);
        return {
          sessionId: s.sessionId,
          summary: s.summary,
          session,
          title: titleOf(session),
          projectPath: session.projectPath,
        };
      });
    usage.value = result.usage || null;
    if (!entries.value.length) error.value = 'claude returned no summaries for these sessions.';
  } catch (e) {
    entries.value = [];
    error.value = e?.message || String(e);
  } finally {
    pending.value = false;
  }
}
</script>
