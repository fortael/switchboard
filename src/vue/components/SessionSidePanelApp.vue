<template>
  <aside class="sbx-sidepanel">
    <!-- Drag to resize. Every width change has to refit the session terminal:
         xterm owns its cols/rows and hands them to the PTY, so a narrower
         terminal that was not refitted makes the CLI wrap at the old width. -->
    <div
      class="sbx-sidepanel__grip"
      :class="{ 'is-dragging': dragging }"
      title="Drag to resize"
      @mousedown.prevent="startDrag"
      @dblclick="resetWidth"
    ></div>

    <div class="sbx-sidepanel__body">
      <header class="sbx-sidepanel__head">
        <SbIcon name="git-branch" :size="12" tone="muted" />
        <span class="sbx-sidepanel__branch" :title="detail?.branch || ''">{{ detail?.branch || '—' }}</span>
        <span class="sbx-sidepanel__path" :title="projectPath">{{ shortPath }}</span>
        <button
          type="button"
          class="sbx-sidepanel__iconbtn"
          :class="{ 'is-busy': loading }"
          data-tooltip="Refresh"
          aria-label="Refresh"
          @click="load()"
        >
          <SbIcon name="refresh-cw" :size="12" />
        </button>
        <button
          type="button"
          class="sbx-sidepanel__iconbtn"
          data-tooltip="Close panel"
          aria-label="Close panel"
          @click="close"
        >
          <SbIcon name="x" :size="13" />
        </button>
      </header>

      <!-- ── Uncommitted changes ─────────────────────────────────────── -->
      <section class="sbx-sidepanel__section" :class="{ 'is-collapsed': !sections.changes }">
        <button type="button" class="sbx-sidepanel__sechead" @click="toggle('changes')">
          <SbIcon class="sbx-sidepanel__chev" name="chevron-down" :size="12" />
          <span class="sbx-sidepanel__sectitle">Uncommitted changes</span>
          <span v-if="changedFiles.length" class="pv-count-badge">{{ changedFiles.length }}</span>
          <span class="sbx-sidepanel__secstat">
            <span v-if="detail?.totalAdded" class="pv-added">+{{ detail.totalAdded }}</span>
            <span v-if="detail?.totalDeleted" class="pv-deleted">&minus;{{ detail.totalDeleted }}</span>
          </span>
        </button>
        <div v-show="sections.changes" class="sbx-sidepanel__secbody sbx-sidepanel__secbody--files">
          <template v-if="changedFiles.length">
            <div v-for="f in changedFiles" :key="f.file" class="pv-file-row" :title="f.file">
              <span class="pv-file-status" :class="fileStatus(f)">{{ fileStatusChar(f) }}</span>
              <span class="pv-file-name"
                ><span class="sbx-sidepanel__filedir">{{ dirOf(f.file) }}</span
                ><span class="sbx-sidepanel__filebase">{{ baseOf(f.file) }}</span
              ></span>
              <span class="pv-file-diff">
                <span v-if="f.added" class="pv-added">+{{ f.added }}</span>
                <span v-if="f.deleted" class="pv-deleted">&minus;{{ f.deleted }}</span>
              </span>
            </div>
          </template>
          <div v-else class="pv-empty">{{ loading && !detail ? 'Loading…' : 'Working tree clean' }}</div>
        </div>
      </section>

      <!-- ── Containers ──────────────────────────────────────────────── -->
      <section class="sbx-sidepanel__section" :class="{ 'is-collapsed': !sections.containers }">
        <button type="button" class="sbx-sidepanel__sechead" @click="toggle('containers')">
          <SbIcon class="sbx-sidepanel__chev" name="chevron-down" :size="12" />
          <span class="sbx-sidepanel__sectitle">Containers</span>
          <span v-if="containers.length" class="pv-count-badge">{{ runningCount }}/{{ containers.length }}</span>
        </button>
        <div v-show="sections.containers" class="sbx-sidepanel__secbody sbx-sidepanel__secbody--containers">
          <template v-if="containers.length">
            <div
              v-for="c in containers" :key="c.name"
              class="pv-container-row"
              :class="{ running: (c.state || '').includes('running') }"
              :title="c.status || c.state"
            >
              <span class="pv-container-dot"></span>
              <span class="pv-container-name">{{ c.name }}</span>
              <span class="pv-container-state">{{ c.status || c.state }}</span>
              <span v-if="c.ports" class="pv-container-ports">{{ c.ports }}</span>
            </div>
          </template>
          <div v-else class="pv-empty">{{ loading && !detail ? 'Loading…' : 'No compose services' }}</div>
        </div>
      </section>

      <!-- ── Scratch shell ───────────────────────────────────────────── -->
      <section
        class="sbx-sidepanel__section sbx-sidepanel__section--shell"
        :class="{ 'is-collapsed': !sections.shell }"
      >
        <button type="button" class="sbx-sidepanel__sechead" @click="toggle('shell')">
          <SbIcon class="sbx-sidepanel__chev" name="chevron-down" :size="12" />
          <span class="sbx-sidepanel__sectitle">Shell</span>
          <span class="sbx-sidepanel__secnote">{{ shellNote }}</span>
        </button>
        <div v-show="sections.shell" class="sbx-sidepanel__secbody sbx-sidepanel__secbody--shell">
          <div ref="shellHostRef" class="sbx-sidepanel__shellhost" @mousedown="focusShell"></div>
        </div>
      </section>
    </div>
  </aside>
</template>

<script setup>
import { ref, reactive, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { store } from '../store.js';
import SbIcon from './SbIcon.vue';

const WIDTH_KEY = 'sessionSidePanelWidth';
const SECTIONS_KEY = 'sessionSidePanelSections';
const MIN_WIDTH = 280;

// Three stacked sections rather than tabs: the complaint this panel answers is
// about having to switch views, so everything that fits stays on screen.
const sections = reactive({ changes: true, containers: true, shell: true });
try {
  const saved = JSON.parse(localStorage.getItem(SECTIONS_KEY) || 'null');
  if (saved && typeof saved === 'object') Object.assign(sections, saved);
} catch {}

const detail = ref(null);
const loading = ref(false);
const dragging = ref(false);
const shellHostRef = ref(null);
const shellReady = ref(false);

// Everything in this panel is scoped to the OPEN SESSION's own project path,
// not to whatever the Projects tab happens to be showing — the session may be
// running in a worktree with its own branch and its own working tree.
const projectPath = computed(() => store.headerSession?.projectPath || '');
const sessionId = computed(() => store.headerSession?.sessionId || '');

const shortPath = computed(() =>
  projectPath.value.split('/').filter(Boolean).slice(-2).join('/')
);
const changedFiles = computed(() => detail.value?.changedFiles || []);
const containers = computed(() => detail.value?.containers || []);
const runningCount = computed(() =>
  containers.value.filter(c => (c.state || '').includes('running')).length
);
const shellNote = computed(() => {
  if (shellReady.value) return shortPath.value;
  return sections.shell ? 'starting…' : '';
});

// The basename is the part worth reading in a 380px column, so it is kept
// whole and only the directory is allowed to truncate.
function dirOf(p) {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i + 1);
}
function baseOf(p) {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

function fileStatus(f) {
  if (!f.added && f.deleted) return 'deleted';
  if (f.added && !f.deleted) return 'added';
  return 'modified';
}
function fileStatusChar(f) {
  if (!f.added && f.deleted) return 'D';
  if (f.added && !f.deleted) return 'A';
  return 'M';
}

// ── Data ──────────────────────────────────────────────────────────
// get-project-detail runs every git and docker command with the given path as
// cwd, so a worktree path yields that worktree's own branch, diff and compose
// services. No extra plumbing needed.
async function load() {
  const p = projectPath.value;
  if (!p || loading.value) return;
  loading.value = true;
  try {
    const det = await window.api.getProjectDetail(p);
    if (projectPath.value === p && det) detail.value = det;
  } catch {
    /* keep whatever we already had rather than blanking the panel */
  } finally {
    loading.value = false;
  }
}

async function reset(p) {
  detail.value = null;
  if (!p) return;
  // Paint the cached git state first so opening the panel is not a blank flash.
  const cached = await window.api.getProjectGitCache(p).catch(() => null);
  if (cached && projectPath.value === p) detail.value = cached;
  load();
}

// No polling. get-project-detail broadcasts `projects-changed` on every call,
// which re-renders the whole sidebar, so a timer here would be far from free.
// Instead: on open, on project change, on an explicit refresh — and once each
// time the CLI goes from working to idle, which is exactly when the working
// tree has just stopped moving.
const cliBusy = computed(() => !!store.sessionBusyState.get(sessionId.value));
watch(cliBusy, (now, before) => { if (before && !now) load(); });

watch(projectPath, (p) => {
  reset(p);
  startShell();
});

// ── Scratch shell ─────────────────────────────────────────────────
// Created here, destroyed on unmount and whenever the project path changes.
// terminal-manager.js owns the xterm/PTY details; main.js reaps a stray
// ephemeral PTY if a renderer reload skipped our teardown.
function startShell() {
  shellReady.value = false;
  window.destroyPanelTerminal?.();
  return ensureShell();
}

// xterm measures its character box the moment it is opened, so it must never
// be created inside a display:none host — the cell size comes out wrong and
// the shell renders a handful of columns wide. If the section is collapsed,
// wait for it to be expanded.
async function ensureShell() {
  const p = projectPath.value;
  if (!p || shellReady.value || !sections.shell) return;
  await nextTick();
  const host = shellHostRef.value;
  if (!host || !host.offsetParent) return;
  host.innerHTML = '';
  const entry = await window.createPanelTerminal?.(host, p);
  if (entry) shellReady.value = true;
}

function focusShell() { window.focusPanelTerminal?.(); }

// ── Sections ──────────────────────────────────────────────────────
function toggle(name) {
  sections[name] = !sections[name];
  localStorage.setItem(SECTIONS_KEY, JSON.stringify({ ...sections }));
  // Every section shares the leftover height with the shell, so any of them
  // opening or closing changes how tall the terminal is.
  if (sections.shell) ensureShell();
  scheduleFit();
}

function close() {
  store.sidePanelOpen = false;
  localStorage.setItem('sessionSidePanelOpen', '0');
}

// ── Resize ────────────────────────────────────────────────────────
let fitRaf = 0;
function scheduleFit() {
  cancelAnimationFrame(fitRaf);
  // rAF runs after Vue has flushed the width onto #terminal-area, so the
  // terminals measure their final box.
  fitRaf = requestAnimationFrame(() => window._refitOpenTerminals?.());
}

function startDrag(e) {
  dragging.value = true;
  const startX = e.clientX;
  const startWidth = store.sidePanelWidth;
  const max = Math.max(MIN_WIDTH, Math.round(window.innerWidth * 0.7));

  const onMove = (ev) => {
    const next = Math.min(max, Math.max(MIN_WIDTH, startWidth + (startX - ev.clientX)));
    if (next === store.sidePanelWidth) return;
    store.sidePanelWidth = next;
    scheduleFit();
  };
  const onUp = () => {
    dragging.value = false;
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    localStorage.setItem(WIDTH_KEY, String(store.sidePanelWidth));
    scheduleFit();
  };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
}

function resetWidth() {
  store.sidePanelWidth = 380;
  localStorage.setItem(WIDTH_KEY, '380');
  scheduleFit();
}

onMounted(() => {
  reset(projectPath.value);
  startShell();
});

onBeforeUnmount(() => {
  cancelAnimationFrame(fitRaf);
  window.destroyPanelTerminal?.();
});
</script>
