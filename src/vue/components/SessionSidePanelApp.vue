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
      <!-- The diff takes the header over rather than stacking a second bar:
           at this width every row of chrome is a row the diff does not get. -->
      <header v-if="activeDiff" class="sbx-sidepanel__head">
        <button
          type="button"
          class="sbx-sidepanel__backbtn"
          data-tooltip="Back to changes"
          aria-label="Back to changes"
          @click="closeDiff"
        >
          <SbIcon name="chevron-down" :size="13" class="sbx-sidepanel__backchev" />
          Back
        </button>
        <span class="sbx-sidepanel__difffile" :title="activeDiff.filePath">{{ baseOf(activeDiff.filePath) }}</span>
        <span class="sbx-sidepanel__spacer"></span>
        <span class="sbx-sidepanel__diffcount">{{ diffIndex + 1 }}/{{ changedFiles.length }}</span>
        <button
          type="button" class="sbx-sidepanel__iconbtn" data-tooltip="Previous file"
          aria-label="Previous file" :disabled="diffIndex <= 0" @click="stepDiff(-1)"
        >
          <SbIcon name="chevron-down" :size="12" class="sbx-sidepanel__prevchev" />
        </button>
        <button
          type="button" class="sbx-sidepanel__iconbtn" data-tooltip="Next file"
          aria-label="Next file" :disabled="diffIndex >= changedFiles.length - 1" @click="stepDiff(1)"
        >
          <SbIcon name="chevron-down" :size="12" class="sbx-sidepanel__nextchev" />
        </button>
      </header>

      <header v-else class="sbx-sidepanel__head">
        <span class="sbx-sidepanel__title">{{ activeTab?.label }}</span>
        <span v-if="tab === 'changes' && detail?.totalAdded" class="pv-added">+{{ detail.totalAdded }}</span>
        <span v-if="tab === 'changes' && detail?.totalDeleted" class="pv-deleted">&minus;{{ detail.totalDeleted }}</span>
        <span class="sbx-sidepanel__spacer"></span>
        <SbIcon name="git-branch" :size="12" tone="muted" />
        <span class="sbx-sidepanel__branch" :title="detail?.branch || ''">{{ detail?.branch || '—' }}</span>
        <span class="sbx-sidepanel__path" :title="projectPath">{{ shortPath }}</span>
        <button
          v-if="tab !== 'shell'"
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

      <!-- ── Diff overlay ────────────────────────────────────────────── -->
      <div v-if="activeDiff" class="sbx-sidepanel__pane sbx-sidepanel__pane--diff">
        <div ref="diffHostRef" class="sbx-sidepanel__diffhost"></div>
      </div>

      <!-- ── Changes: working tree / commits ─────────────────────────── -->
      <template v-else-if="tab === 'changes'">
        <!-- Two views of the same git pane rather than a fourth rail button:
             writing a commit and pushing it are the same errand. -->
        <div class="sbx-sidepanel__subtabs">
          <button
            type="button" class="sbx-sidepanel__subtab"
            :class="{ 'is-active': changesView === 'files' }"
            @click="changesView = 'files'"
          >Changes<span v-if="changedFiles.length" class="sbx-sidepanel__subcount">{{ changedFiles.length }}</span></button>
          <button
            type="button" class="sbx-sidepanel__subtab"
            :class="{ 'is-active': changesView === 'commits' }"
            @click="changesView = 'commits'"
          >Commits<span v-if="unpushedCommits.length" class="sbx-sidepanel__subcount is-unpushed">{{ unpushedCommits.length }}</span></button>
        </div>

        <template v-if="changesView === 'commits'">
          <div class="sbx-sidepanel__pane sbx-sidepanel__pane--commits">
            <template v-if="unpushedCommits.length">
              <div class="sbx-sidepanel__seclabel is-unpushed">
                {{ unpushedCommits.length }} unpushed
              </div>
              <div v-for="c in unpushedCommits" :key="'u' + c.hash" class="pv-commit-item sbx-sidepanel__commititem is-unpushed">
                <span class="pv-commit-hash">{{ c.hash }}</span>
                <span class="pv-commit-msg" :title="c.message">{{ c.message }}</span>
                <span class="pv-commit-date">{{ c.date }}</span>
              </div>
            </template>

            <div v-if="pushedCommits.length" class="sbx-sidepanel__seclabel">Recent</div>
            <div v-for="c in pushedCommits" :key="c.hash" class="pv-commit-item sbx-sidepanel__commititem">
              <span class="pv-commit-hash">{{ c.hash }}</span>
              <span class="pv-commit-msg" :title="c.message">{{ c.message }}</span>
              <span class="pv-commit-date">{{ c.date }}</span>
            </div>

            <div v-if="!commits.length && !unpushedCommits.length" class="pv-empty">
              {{ loading && !detail ? 'Loading…' : 'No commits' }}
            </div>
          </div>

          <div class="sbx-sidepanel__commit">
            <div v-if="!detail?.upstream" class="sbx-sidepanel__gitmsg">No upstream branch — nothing to push to.</div>
            <div class="sbx-sidepanel__commitrow">
              <span class="sbx-sidepanel__genlabel" :title="detail?.upstream || ''">{{ detail?.upstream || '—' }}</span>
              <span class="sbx-sidepanel__spacer"></span>
              <!-- Two-step rather than a modal: pushing publishes to a remote,
                   so it should not be one stray click, and a 380px column is
                   the wrong place for a dialog. -->
              <button
                v-if="!confirmPush"
                type="button" class="pv-action-btn"
                :disabled="gitBusy || !detail?.upstream || !unpushedCommits.length"
                @click="confirmPush = true"
              >Push{{ unpushedCommits.length ? ` (${unpushedCommits.length})` : '' }}</button>
              <template v-else>
                <button type="button" class="pv-gen-style-btn" @click="confirmPush = false">Cancel</button>
                <button type="button" class="pv-action-btn" :disabled="gitBusy" @click="doPush">Confirm push</button>
              </template>
            </div>
            <div v-if="gitMsg" class="sbx-sidepanel__gitmsg" :class="{ 'is-error': gitMsgError }">{{ gitMsg }}</div>
          </div>
        </template>

        <template v-else>
        <div class="sbx-sidepanel__pane sbx-sidepanel__pane--files">
          <template v-if="changedFiles.length">
            <div
              v-for="f in changedFiles" :key="f.file"
              class="pv-file-row pv-file-row--clickable"
              :class="{ loading: loadingFile === f.file }"
              :title="f.file"
              @click="openDiff(f.file)"
            >
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

        <!-- Committing from here is the point: the session that made the
             changes is right there, so going to the Projects tab to write the
             message is a trip for nothing. -->
        <div v-if="changedFiles.length" class="sbx-sidepanel__commit">
          <textarea
            v-if="!generating"
            class="pv-commit-input sbx-sidepanel__commitinput"
            placeholder="Commit message…"
            v-model="commitMessage"
            rows="3"
          ></textarea>
          <div v-else class="sbx-sidepanel__generating">Generating…</div>
          <div class="sbx-sidepanel__commitrow">
            <span class="sbx-sidepanel__genlabel">Claude:</span>
            <button
              type="button" class="pv-gen-style-btn"
              :disabled="gitBusy || generating" title="One-sentence commit message"
              @click="generateCommitMsg('short')"
            >short</button>
            <button
              type="button" class="pv-gen-style-btn"
              :disabled="gitBusy || generating" title="Title + bullet list of key changes"
              @click="generateCommitMsg('descriptive')"
            >detailed</button>
            <span class="sbx-sidepanel__spacer"></span>
            <button
              type="button" class="pv-action-btn"
              :disabled="gitBusy || !commitMessage.trim()"
              @click="doCommit"
            >Commit</button>
          </div>
          <!-- Who the commit will be authored as. Easy to be in a worktree or a
               repo with a local override and not notice until after the fact. -->
          <div v-if="gitUser.name || gitUser.email" class="pv-git-user">
            <SbIcon name="users" :size="11" />
            <span class="pv-git-user-name">{{ gitUser.name }}</span>
            <span v-if="gitUser.email" class="pv-git-user-email">&lt;{{ gitUser.email }}&gt;</span>
          </div>
          <div v-if="gitMsg" class="sbx-sidepanel__gitmsg" :class="{ 'is-error': gitMsgError }">{{ gitMsg }}</div>
        </div>
        </template>
      </template>

      <!-- ── Containers ──────────────────────────────────────────────── -->
      <div v-else-if="tab === 'containers'" class="sbx-sidepanel__pane sbx-sidepanel__pane--containers">
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

      <!-- ── Scratch shell ───────────────────────────────────────────── -->
      <!-- v-show, not v-if: the xterm instance is bound to this host element,
           and unmounting it on every tab switch would tear the PTY down and
           lose the user's scrollback and their shell state. -->
      <div v-show="tab === 'shell'" class="sbx-sidepanel__pane sbx-sidepanel__pane--shell">
        <div ref="shellHostRef" class="sbx-sidepanel__shellhost" @mousedown="focusShell"></div>
      </div>
    </div>
  </aside>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { store } from '../store.js';
import SbIcon from './SbIcon.vue';
import { TABS, setSidePanelTab } from '../side-panel-tabs.js';

const WIDTH_KEY = 'sessionSidePanelWidth';
const MIN_WIDTH = 280;

const detail = ref(null);
const loading = ref(false);
const dragging = ref(false);
const shellHostRef = ref(null);
const shellReady = ref(false);

// Diff overlay + commit box, the two things that used to mean a trip to the
// Projects tab. Same IPC calls that tab makes — getFileDiff, gitGenerateCommitMsg,
// gitCommit — so behaviour cannot drift between the two places.
const activeDiff = ref(null);
const loadingFile = ref(null);
const diffHostRef = ref(null);
const commitMessage = ref('');
const generating = ref(false);
const gitBusy = ref(false);
const gitMsg = ref('');
const gitMsgError = ref(false);
const changesView = ref('files');   // 'files' | 'commits'
const confirmPush = ref(false);
const gitUser = ref({ name: '', email: '' });
let diffView = null;
let gitMsgTimer = 0;

const tab = computed(() => store.sidePanelTab);
const activeTab = computed(() => TABS.find(t => t.id === tab.value) || null);

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
const commits = computed(() => detail.value?.commits || []);
const unpushedCommits = computed(() => detail.value?.unpushedCommits || []);
// `commits` is the last 15 regardless of push state, so drop the ones already
// listed above as unpushed instead of showing them twice.
const pushedCommits = computed(() => {
  const unpushed = new Set(unpushedCommits.value.map(c => c.hash));
  return commits.value.filter(c => !unpushed.has(c.hash));
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
function publish(det) {
  detail.value = det;
  store.sidePanelDetail = det;
}

async function load() {
  const p = projectPath.value;
  if (!p || loading.value) return;
  loading.value = true;
  try {
    const det = await window.api.getProjectDetail(p);
    if (projectPath.value === p && det) publish(det);
  } catch {
    /* keep whatever we already had rather than blanking the panel */
  } finally {
    loading.value = false;
  }
}

async function reset(p) {
  publish(null);
  gitUser.value = { name: '', email: '' };
  if (!p) return;
  // Paint the cached git state first so opening the panel is not a blank flash.
  const cached = await window.api.getProjectGitCache(p).catch(() => null);
  if (cached && projectPath.value === p) publish(cached);
  load();
  // Read per-repo, not once globally: a worktree or a repo-local user.email
  // override is exactly the case worth surfacing before you commit.
  const info = await window.api.getGitUserInfo(p).catch(() => null);
  if (info?.ok && projectPath.value === p) {
    gitUser.value = { name: info.name || '', email: info.email || '' };
  }
}

// No polling. get-project-detail broadcasts `projects-changed` on every call,
// which re-renders the whole sidebar, so a timer here would be far from free.
// Instead: on open, on project change, on an explicit refresh — and once each
// time the CLI stops working, which is exactly when the working tree has just
// stopped moving. 'requires_action' counts: a permission prompt for an Edit
// means the previous edits have already landed.
const sessionState = computed(() =>
  store.sessionBusyState.get(sessionId.value) ? 'running' : 'idle'
);
watch(sessionState, (now, before) => { if (before === 'running' && now !== 'running') load(); });

// Switching sessions re-scopes the panel in place; the pane the user chose
// stays open. That is the whole point of keeping the tab in the store rather
// than in this component.
watch(projectPath, (p) => {
  // A half-typed message belongs to the project it was written for.
  activeDiff.value = null;
  commitMessage.value = '';
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
// the shell renders a handful of columns wide. If another pane is showing,
// wait until the shell one is selected.
async function ensureShell() {
  const p = projectPath.value;
  if (!p || shellReady.value || tab.value !== 'shell') return;
  await nextTick();
  const host = shellHostRef.value;
  if (!host || !host.offsetParent) return;
  host.innerHTML = '';
  const entry = await window.createPanelTerminal?.(host, p);
  if (entry) shellReady.value = true;
}

function focusShell() { window.focusPanelTerminal?.(); }

// ── Diff overlay ──────────────────────────────────────────────────
const diffIndex = computed(() =>
  changedFiles.value.findIndex(f => f.file === activeDiff.value?.filePath)
);

async function openDiff(filePath) {
  if (loadingFile.value) return;
  loadingFile.value = filePath;
  try {
    const res = await window.api.getFileDiff(projectPath.value, filePath);
    if (!res?.ok) { showGitMsg(res?.error || 'Could not read that file', true); return; }
    activeDiff.value = { filePath, oldContent: res.oldContent, newContent: res.newContent };
  } finally {
    loadingFile.value = null;
  }
}

function closeDiff() { activeDiff.value = null; }

function stepDiff(delta) {
  const next = changedFiles.value[diffIndex.value + delta];
  if (next) openDiff(next.file);
}

// Unified, not side-by-side. The Projects tab has the full width for two
// columns; this panel is 380px by default, where a split merge view truncates
// both halves and shows neither. Same CodeMirror bundle either way. It measures
// on open, so it is built after the host is in the DOM and torn down whenever
// the overlay changes.
watch(activeDiff, async (diff) => {
  if (diffView) {
    try { typeof diffView.destroy === 'function' ? diffView.destroy() : diffView.a?.destroy(); } catch {}
    diffView = null;
  }
  if (!diff) return;
  await nextTick();
  const el = diffHostRef.value;
  if (!el) return;
  el.innerHTML = '';
  diffView = window.createReadOnlyUnifiedMergeViewer?.(el, diff.oldContent, diff.newContent, diff.filePath);
});

// A file that stopped being dirty — committed, or reverted — has no diff left
// to show, so drop the overlay rather than leave a stale one up.
watch(changedFiles, (files) => {
  const open = activeDiff.value?.filePath;
  if (open && !files.some(f => f.file === open)) activeDiff.value = null;
});

// ── Commit ────────────────────────────────────────────────────────
function showGitMsg(text, isError = false) {
  gitMsg.value = text;
  gitMsgError.value = isError;
  clearTimeout(gitMsgTimer);
  gitMsgTimer = setTimeout(() => { gitMsg.value = ''; }, 4000);
}

async function generateCommitMsg(style = 'short') {
  generating.value = true;
  gitBusy.value = true;
  try {
    const res = await window.api.gitGenerateCommitMsg(projectPath.value, style);
    if (res?.ok) commitMessage.value = res.message;
    else showGitMsg(res?.error || 'Generation failed', true);
  } finally {
    generating.value = false;
    gitBusy.value = false;
  }
}

async function doCommit() {
  const message = commitMessage.value.trim();
  if (!message) return;
  gitBusy.value = true;
  try {
    const res = await window.api.gitCommit(projectPath.value, message);
    if (res?.ok) {
      showGitMsg('Committed');
      commitMessage.value = '';
      activeDiff.value = null;
      await load();
    } else {
      showGitMsg(res?.error || 'Commit failed', true);
    }
  } finally {
    gitBusy.value = false;
  }
}

async function doPush() {
  confirmPush.value = false;
  gitBusy.value = true;
  showGitMsg('Pushing…');
  try {
    const res = await window.api.gitPush(projectPath.value);
    if (res?.ok) { showGitMsg('Pushed'); await load(); }
    else showGitMsg(res?.error || 'Push failed', true);
  } finally {
    gitBusy.value = false;
  }
}

// An armed Push must not survive the thing it was armed for.
watch([projectPath, changesView, () => store.sidePanelTab], () => { confirmPush.value = false; });

// Selecting a pane changes what is on screen but not the panel's width, so the
// session terminal does not move. The scratch shell does need a fit, since it
// was measured while hidden or has never been created.
watch(tab, (next) => {
  if (next === 'shell') {
    ensureShell().then(() => requestAnimationFrame(() => window._refitOpenTerminals?.()));
  }
});

function close() { setSidePanelTab(null); }

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
  clearTimeout(gitMsgTimer);
  if (diffView) {
    try { typeof diffView.destroy === 'function' ? diffView.destroy() : diffView.a?.destroy(); } catch {}
    diffView = null;
  }
  window.destroyPanelTerminal?.();
  store.sidePanelDetail = null;
});
</script>
