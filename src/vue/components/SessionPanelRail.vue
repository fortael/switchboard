<template>
  <!-- Overlaid on the terminal rather than living in the session header,
       because the header is hidden in the board's bottom split and these
       controls have to reach both views. Sitting inside #terminal-area also
       means the coming SDK-backed session view inherits them for free: it
       replaces what is under the rail, not the rail itself. -->
  <div class="sbx-panelrail" :class="{ 'is-open': !!store.sidePanelTab }">
    <button
      v-for="tab in TABS"
      :key="tab.id"
      type="button"
      class="sbx-panelrail__btn"
      :class="{ 'is-active': store.sidePanelTab === tab.id }"
      :data-tooltip="store.sidePanelTab === tab.id ? `Hide ${tab.label.toLowerCase()}` : tab.label"
      :aria-pressed="store.sidePanelTab === tab.id"
      :aria-label="tab.label"
      @click="select(tab.id)"
    >
      <SbIcon :name="tab.icon" :size="14" />
      <span v-if="badgeFor(tab.id)" class="sbx-panelrail__badge">{{ badgeFor(tab.id) }}</span>
    </button>

    <span class="sbx-panelrail__sep" role="separator"></span>

    <!-- Stop kills the process. Close only puts the view away — two different
         things, so they do not share a look. -->
    <button
      type="button"
      class="sbx-panelrail__btn sbx-panelrail__btn--danger"
      data-tooltip="Stop session"
      aria-label="Stop session"
      @click="stop"
    >
      <SbIcon name="square" :size="14" />
    </button>

    <button
      type="button"
      class="sbx-panelrail__btn"
      data-tooltip="Close this view — the session keeps running"
      aria-label="Close session view"
      @click="closeView"
    >
      <SbIcon name="x" :size="15" />
    </button>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue';
import { store } from '../store.js';
import SbIcon from './SbIcon.vue';
import { TABS, setSidePanelTab } from '../side-panel-tabs.js';

const projectPath = computed(() => store.headerSession?.projectPath || '');
const sessionId = computed(() => store.headerSession?.sessionId || '');

// Whatever `get-project-detail` last wrote for this project, straight out of
// SQLite. A plain row read: no git, no docker, no `projects-changed` broadcast
// — so the badges can be there the moment the rail is, instead of appearing
// only once the panel has been opened. Stale-while-revalidate: the panel
// refreshes the row for real whenever it is opened.
const cached = ref(null);

async function loadCounts() {
  const p = projectPath.value;
  if (!p) { cached.value = null; return; }
  const row = await window.api.getProjectGitCache(p).catch(() => null);
  if (projectPath.value === p) cached.value = row;
}

// The open panel holds fresher numbers than the row does, so prefer it.
const detail = computed(() => store.sidePanelDetail || cached.value);

function badgeFor(id) {
  if (id === 'changes') return detail.value?.changedFiles?.length || 0;
  if (id === 'containers') {
    const running = (detail.value?.containers || [])
      .filter(c => (c.state || '').includes('running')).length;
    return running || 0;
  }
  return 0;
}

onMounted(loadCounts);
watch(projectPath, loadCounts);

// Closing the panel drops store.sidePanelDetail, so re-read the row it just
// refreshed rather than falling back to whatever this component loaded first.
watch(() => store.sidePanelTab, (tab) => { if (!tab) loadCounts(); });

// A turn that just ended is the moment the working tree stopped moving. The
// row is only rewritten by a real detail load, so this picks up a refresh the
// panel or the Projects tab did while this session was busy.
watch(() => !!store.sessionBusyState.get(sessionId.value), (busy, wasBusy) => {
  if (wasBusy && !busy) loadCounts();
});

function select(id) {
  setSidePanelTab(store.sidePanelTab === id ? null : id);
}

// Moved off the session header with the panel toggles, for the same reason:
// the header does not exist in the board's bottom split, and stopping the
// session you are looking at should not require leaving that view.
function stop() {
  const id = store.headerSession?.sessionId;
  if (id && window.confirmAndStopSession) window.confirmAndStopSession(id);
}

// app.js knows which of the two views is showing and closes the right one —
// the board's bottom split belongs to the board, the full view does not.
function closeView() { window.__sb?.closeSessionView?.(); }
</script>
