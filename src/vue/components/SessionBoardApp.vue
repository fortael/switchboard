<template>
  <div class="sbx-board">
    <div class="sbx-board__bar">
      <SbIcon name="square-kanban" :size="15" tone="muted" />
      <div class="sbx-board__heading">Board</div>
      <div class="sbx-board__summary">{{ summary }}</div>
      <button
        type="button"
        class="sbx-board__toggle"
        :class="{ 'is-active': store.boardHighlightFresh }"
        :aria-pressed="store.boardHighlightFresh"
        data-tooltip="Fade cards by how long ago the session last did anything"
        @click="store.boardHighlightFresh = !store.boardHighlightFresh"
      >Highlight fresh</button>
    </div>

    <div class="sbx-board__grid">
      <section
        v-for="col in columns"
        :key="col.id"
        class="sbx-board__col"
        :class="'sbx-board__col--' + col.id"
      >
        <header class="sbx-board__colhead">
          <span class="sbx-board__dot"></span>
          <span class="sbx-board__collabel">{{ col.label }}</span>
          <span class="sbx-board__count">{{ col.total }}</span>
        </header>

        <div class="sbx-board__colbody">
          <div v-if="!col.groups.length" class="sbx-board__empty">Empty</div>

          <div v-for="group in col.groups" :key="group.projectPath" class="sbx-board__group">
            <div class="sbx-board__grouphead">
              <ProjectAvatar class="sbx-board__avatar" :project-path="group.projectPath" />
              <span class="sbx-board__grouppath" :title="group.projectPath">{{ group.label }}</span>
            </div>

            <SessionCard
              v-for="session in group.items"
              :key="session.sessionId"
              :session="session"
              :highlight-fresh="store.boardHighlightFresh"
              :selected="session.sessionId === store.boardPreviewId"
              @preview="preview"
              @open="open"
            />
          </div>
        </div>
      </section>
    </div>

  </div>
</template>

<script setup>
import { computed, onUnmounted } from 'vue';
import { store } from '../store.js';
import SbIcon from './SbIcon.vue';
import ProjectAvatar from './ProjectAvatar.vue';
import SessionCard from './SessionCard.vue';
import { filterSessions } from '../session-filter.js';
import { tick } from '../time-tick.js';

// Lifecycle order, left to right. Nothing here is stored: a card's column is
// re-derived from live session state on every render, which is also why the
// board has no drag and drop — dragging would assert a state the runtime is
// about to overwrite.
const COLUMNS = [
  { id: 'idle', label: 'IDLE' },
  { id: 'waiting', label: 'WAITING INPUT' },
  { id: 'running', label: 'IN PROGRESS' },
  { id: 'done', label: 'DONE' },
];

// Precedence, not a partition: a session can carry more than one of these
// marks at once. Blocked-on-the-user outranks everything (it is the only state
// that cannot progress without a human), and running outranks done because a
// session the user opened and then sent back to work is working, not finished
// — otherwise readPending would pin it in DONE for the whole next turn.
function columnFor(id) {
  if (store.attentionSessions.has(id)) return 'waiting';
  if (store.sessionBusyState.get(id)) return 'running';
  // readPending = finished, read, still the open session. See app.js.
  if (store.responseReadySessions.has(id) || store.readPendingSessions.has(id)) return 'done';
  return 'idle';
}

function shortPath(projectPath) {
  return projectPath.split('/').filter(Boolean).slice(-2).join('/') || projectPath;
}

// One pass over the projects, bucketed by column, so each project appears at
// most once per column and keeps its own header there.
const columns = computed(() => {
  tick.value; // eslint-disable-line no-unused-expressions -- re-read timeago
  const byId = new Map(COLUMNS.map(c => [c.id, { ...c, groups: [], total: 0 }]));

  for (const project of store.projects) {
    // Scoped to one project from the board's sidebar. Applied here rather than
    // inside filterSessions: it is a board-only lens, and the sidebar list has
    // no concept of it.
    if (store.boardProjectFilter && project.projectPath !== store.boardProjectFilter) continue;
    // Exactly what the sidebar list is showing — same filter module, same
    // flags. The board is the list in another shape, not a second dataset.
    const sessions = filterSessions(project.sessions, {
      showArchived: store.showArchived,
      showStarredOnly: store.showStarredOnly,
      showRunningOnly: store.showRunningOnly,
      showTodayOnly: store.showTodayOnly,
      searchMatchIds: store.searchMatchIds,
      activePtyIds: store.activePtyIds,
    });
    const buckets = new Map();
    for (const session of sessions) {
      const colId = columnFor(session.sessionId);
      if (!buckets.has(colId)) buckets.set(colId, []);
      buckets.get(colId).push(session);
    }
    for (const [colId, items] of buckets) {
      items.sort((a, b) => new Date(b.modified) - new Date(a.modified));
      const col = byId.get(colId);
      col.groups.push({ projectPath: project.projectPath, label: shortPath(project.projectPath), items });
      col.total += items.length;
    }
  }

  return COLUMNS.map(c => byId.get(c.id));
});

const summary = computed(() => {
  const sessions = columns.value.reduce((n, c) => n + c.total, 0);
  const projects = new Set();
  for (const col of columns.value) for (const g of col.groups) projects.add(g.projectPath);
  if (!sessions) return 'No sessions';
  return `${sessions} session${sessions === 1 ? '' : 's'} across ${projects.size} project${projects.size === 1 ? '' : 's'}`;
});

// ── Bottom split ──────────────────────────────────────────────────
// One click opens the session for real and shows it in a pane under the
// board — the same live terminal you get on the Sessions tab, not a copy of
// it. #terminal-area is never reparented: file-panel.js owns that subtree, so
// the split is done by moving the two absolutely positioned panes with CSS
// (.has-board-split in css/board-view.css) and refitting afterwards.
function refitSoon() {
  requestAnimationFrame(() => window._refitOpenTerminals?.());
}

function preview(session) {
  store.boardPreviewId = session.sessionId;
  window.__sb?.openSession?.(session);
  refitSoon();
}

// Routed through app.js rather than clearing the id here: closing the pane is
// what retires the card from DONE, and doing it locally skipped that — the
// session came back to DONE-forever, since nothing else ever released it.
function closePreview() {
  window.__sb?.closeSessionView?.();
  refitSoon();
}

// Leaving the board must not strand the terminal in a half-height pane. This
// one stays a plain clear: switching tabs is not closing the session, which
// remains open in the session view and keeps whatever card it had earned.
onUnmounted(() => { store.boardPreviewId = null; });

// The board is a survey, not a workspace: opening a card hands you over to the
// session view, the same way the attention rail does.
function open(session) {
  store.boardPreviewId = null;
  window.vueApp?.setTab?.('sessions');
  window.__sb?.openSession?.(session);
  refitSoon();
}

// The board's sidebar links a session summary back to its card; selecting it
// has to mean exactly what clicking that card means.
defineExpose({ selectSession: preview });
</script>
