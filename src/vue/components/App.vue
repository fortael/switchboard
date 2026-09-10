<template>
  <div class="sbx-shell">
  <!-- ── TOP NAV ────────────────────────────────────────────────── -->
  <TopNavApp
    :tabs="store.sidebarCollapsed ? [] : TABS"
    :active-id="store.activeTab"
    :theme="store.theme"
    :sidebar-collapsed="store.sidebarCollapsed"
    :can-toggle-sidebar="true"
    @select="setTab"
    @settings="onGlobalSettings"
    @toggle-sidebar="store.sidebarCollapsed = !store.sidebarCollapsed"
    @toggle-theme="toggleTheme"
  >
    <template #account>
      <AccountDropdownApp ref="accountDropdownRef" :callbacks="accountDropdownCallbacks" />
    </template>
  </TopNavApp>

  <div class="sbx-shell__body">
  <!-- ── COLLAPSED RAIL ─────────────────────────────────────────── -->
  <CollapsedRailApp
    v-if="store.sidebarCollapsed"
    :tabs="TABS"
    :active-id="store.activeTab"
    :projects="attentionProjects"
    :active-project="store.attentionProject"
    @select="setTab"
    @select-project="onSelectAttentionProject"
    @settings="onGlobalSettings"
    @expand="store.sidebarCollapsed = false"
  />

  <!-- ── SIDEBAR ────────────────────────────────────────────────── -->
  <div id="sidebar" v-show="!store.sidebarCollapsed">
    <CommandBar
      :model-value="store.searchQuery"
      :placeholder="searchPlaceholder"
      add-title="Add project"
      @update:model-value="onSearchValue"
      @add="onAddProject"
      @spotlight="focusSearch"
    >
      <template #field-actions>
        <button
          v-show="store.searchQuery"
          type="button"
          class="sbx-commandbar__chip"
          aria-label="Clear search"
          @click="doClearSearch"
        >&times;</button>
        <button
          type="button"
          class="sbx-commandbar__chip"
          :class="{ 'is-active': store.searchTitlesOnly }"
          data-tooltip="Search titles only"
          aria-label="Search titles only"
          @click="toggleTitlesOnly"
        >Tt</button>
      </template>
    </CommandBar>

    <!-- Not scoped to the sessions tab: live sessions are worth watching from
         wherever you are. Renders nothing when nothing is running. The board
         is the exception — it already shows every live session as a card, so
         a rail of the same projects above it is noise. -->
    <AttentionRail
      v-if="store.activeTab !== 'board'"
      :items="attentionProjects"
      :active-name="attentionActiveName"
      @select="onSelectAttentionName"
    />

    <!-- Shared with the board: its cards are the same sessions under the same
         filter flags, so the row that picks between Recent and Archived has to
         be reachable from there too. The list/grid switch is not — the board is
         already a view of its own. -->
    <FilterTabs
      v-if="sessionListVisible || store.activeTab === 'board'"
      :class="{ 'sbx-filtertabs--no-views': store.activeTab === 'board' }"
      :tabs="FILTER_TABS"
      :active="store.sessionFilterTab"
      :view-mode="store.sidebarViewMode"
      @select="onFilterTab"
      @update:view-mode="onViewMode"
    >
      <template #actions>
        <span id="loading-status" v-show="store.loadingStatus">{{ store.loadingStatus }}</span>
        <button
          type="button"
          class="sbx-filtertabs__view"
          data-tooltip="Refresh sessions"
          aria-label="Refresh sessions"
          @click="onResort"
        >
          <SbIcon name="refresh-cw" :size="13" tone="muted" />
        </button>
      </template>
    </FilterTabs>

    <!-- Sidebar content panels (v-show keeps DOM alive for vanilla JS queries) -->
    <div id="sidebar-content" class="sbx-sidebar-panel" v-show="sessionListVisible && !store.accountSwitching">
      <SidebarApp :callbacks="sidebarCallbacks" />
    </div>
    <div v-if="store.accountSwitching && sessionListVisible" id="account-switch-overlay" class="account-switch-preloader">
      <div class="acct-spinner"></div><span>Switching account…</span>
    </div>
    <div id="plans-content" class="sbx-sidebar-panel" v-show="store.activeTab === 'plans'">
      <PlansApp ref="plansRef" :callbacks="planCallbacks" />
    </div>
    <div id="accounts-content" class="sbx-sidebar-panel" v-show="store.activeTab === 'accounts'">
      <AccountsApp ref="accountsRef" :callbacks="accountsCallbacks" />
    </div>
    <div id="projects-content" class="sbx-sidebar-panel" v-show="store.activeTab === 'projects'">
      <ProjectsApp ref="projectsRef" :callbacks="projectsCallbacks" />
    </div>
    <!-- Not a .sbx-sidebar-panel: this one owns two bounded scroll boxes of
         its own instead of being a single scrolling column. -->
    <div id="board-sidebar-content" class="sbx-boardside-panel" v-show="store.activeTab === 'board'">
      <BoardSidebarApp :callbacks="boardSidebarCallbacks" />
    </div>
  </div>

  <!-- ── RESIZE HANDLE ──────────────────────────────────────────── -->
  <div id="sidebar-resize-handle" v-show="!store.sidebarCollapsed"></div>

  <!-- ── MAIN AREA ──────────────────────────────────────────────── -->
  <div
    id="main"
    :class="{ 'is-board': store.showBoard, 'has-board-split': boardSplitActive }"
    :style="{ '--sbx-board-split': store.boardSplitHeight + 'px' }"
  >
    <!-- Drag the seam between the board and the session below it. -->
    <div
      v-if="boardSplitActive"
      class="sbx-board-splitter"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the session pane"
      @mousedown.prevent="startBoardResize"
    ></div>
    <!-- The pane's own close button is on SessionPanelRail now, so it is the
         same control in the same place in both views. -->
    <div id="placeholder">
      <p>Select a session from the sidebar to begin.</p>
    </div>
    <div id="board-viewer" v-show="store.showBoard">
      <SessionBoardApp ref="boardRef" />
    </div>
    <div id="plan-viewer" v-show="store.planViewerOpen">
      <ViewerContentApp
        ref="planViewerRef"
        language="markdown"
        storage-key="markdownPreviewMode"
        :show-copy-path="true"
        :show-copy-content="true"
        :on-save="planOnSave"
      />
    </div>
    <SettingsPanelApp v-if="store.settingsOpen" />
    <div id="project-viewer" style="display:none;">
      <ProjectViewerApp ref="projectViewerRef" :callbacks="projectViewerCallbacks" />
    </div>
    <div id="jsonl-viewer" v-show="store.showJsonl">
      <JsonlViewerApp ref="jsonlRef" />
    </div>
    <div id="account-viewer" v-show="store.accountViewerOpen">
      <AccountViewerApp ref="accountViewerRef" />
    </div>
    <!-- The side panel is absolutely positioned inside #terminal-area and the
         terminal split is given a matching right margin (css/side-panel.css).
         It cannot be a flex sibling of #terminals: file-panel.js reparents
         #terminals into a #terminal-split of its own at startup. -->
    <div
      id="terminal-area"
      :class="{ 'has-side-panel': sidePanelVisible }"
      :style="{ '--sbx-sidepanel-w': store.sidePanelWidth + 'px' }"
    >
      <div id="vue-session-header">
        <SessionHeaderApp />
      </div>
      <SessionPanelRail v-if="store.headerSession" />
      <SessionSidePanelApp v-if="sidePanelVisible" />
      <!-- Covers the terminal area for a session that has no terminal. Sits
           inside #terminal-area so the rail, the side panel and their gutters
           are laid out identically for both transports. -->
      <SessionSdkApp v-if="sdkSessionVisible" :key="store.headerSession.sessionId" />
      <!-- Legacy terminal header kept for JS references (hidden) -->
      <div id="terminal-header" style="display:none;">
        <div id="terminal-header-info">
          <span id="terminal-header-name"></span>
          <span id="terminal-header-pty-title" style="display:none;"></span>
          <span id="terminal-header-id"></span>
          <span id="terminal-header-shell" style="display:none;"></span>
          <span id="terminal-header-account" class="terminal-account-badge" style="display:none;"></span>
        </div>
        <div id="terminal-header-controls">
          <span id="terminal-header-status"></span>
          <button id="terminal-stop-btn" data-tooltip="Stop process">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><rect x="2" y="2" width="8" height="8" rx="1"/></svg>
          </button>
        </div>
      </div>
      <div id="grid-viewer" v-show="store.gridViewActive">
        <div id="grid-viewer-header">
          <span id="grid-viewer-title">Session Overview</span>
          <span id="grid-viewer-count">{{ store.gridViewerCount }}</span>
        </div>
      </div>
      <div id="terminals"></div>
    </div>
  </div>
  </div><!-- /.sbx-shell__body -->
  </div><!-- /.sbx-shell -->

  <!-- Status bar and grid cards rendered via Teleport into their existing container elements -->
  <Teleport to="#status-bar">
    <StatusBarApp ref="statusBarRef" />
  </Teleport>
  <Teleport to="#vue-grid-cards">
    <GridCardsApp ref="gridCardsRef" />
  </Teleport>

  <!-- Dialogs (overlays + popover, rendered via Teleport to body inside the component) -->
  <DialogsApp ref="dialogsRef" />
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue';
import { store } from '../store.js';
import SbIcon from './SbIcon.vue';
import TopNavApp from './TopNavApp.vue';
import CollapsedRailApp from './CollapsedRailApp.vue';
import CommandBar from './CommandBar.vue';
import FilterTabs from './FilterTabs.vue';
import AttentionRail from './AttentionRail.vue';
import SidebarApp from './SidebarApp.vue';
import SessionHeaderApp from './SessionHeaderApp.vue';
import SessionSidePanelApp from './SessionSidePanelApp.vue';
import SessionPanelRail from './SessionPanelRail.vue';
import SessionSdkApp from './SessionSdkApp.vue';
import { loadSidePanelTab } from '../side-panel-tabs.js';
import { OPEN_ORDER, mostUrgent, worstColumn, stateFromStore } from '../session-column.js';
import PlansApp from './PlansApp.vue';
import AccountsApp from './AccountsApp.vue';
import AccountDropdownApp from './AccountDropdownApp.vue';
import ProjectsApp from './ProjectsApp.vue';
import StatusBarApp from './StatusBarApp.vue';
import GridCardsApp from './GridCardsApp.vue';
import SettingsPanelApp from './SettingsPanelApp.vue';
import ProjectViewerApp from './ProjectViewerApp.vue';
import JsonlViewerApp from './JsonlViewerApp.vue';
import AccountViewerApp from './AccountViewerApp.vue';
import SessionBoardApp from './SessionBoardApp.vue';
import BoardSidebarApp from './BoardSidebarApp.vue';
import ViewerContentApp from './ViewerContentApp.vue';
import DialogsApp from './DialogsApp.vue';

// ── Template refs ────────────────────────────────────────────────
const plansRef = ref(null);
const accountsRef = ref(null);
const accountDropdownRef = ref(null);
const projectsRef = ref(null);
const statusBarRef = ref(null);
const gridCardsRef = ref(null);
const projectViewerRef = ref(null);
const jsonlRef = ref(null);
const accountViewerRef = ref(null);
const planViewerRef = ref(null);
const dialogsRef = ref(null);
const boardRef = ref(null);

const planOnSave = (filePath, content) => window.api.savePlan(filePath, content);

// ── Tab config ───────────────────────────────────────────────────
const TABS = [
  { id: 'sessions', icon: 'sparkles', label: 'Sessions' },
  { id: 'board', icon: 'square-kanban', label: 'Board' },
  { id: 'plans', icon: 'book-open', label: 'Plans' },
  { id: 'projects', icon: 'folder', label: 'Projects' },
  { id: 'accounts', icon: 'users', label: 'Accounts' },
];

// ── Search ───────────────────────────────────────────────────────
// The board renders the same sessions in another shape, so the sidebar keeps
// its list — and its filters — on both tabs.
// ── Board split resize ───────────────────────────────────────────
// Height of the session pane under the board, in px, measured from the bottom
// of #main. Kept in px rather than a ratio so the terminal keeps its row count
// when the window resizes.
const BOARD_SPLIT_MIN = 160;
const BOARD_SPLIT_MARGIN = 220;   // leave at least this much board visible

function setBoardSplit(px) {
  const main = document.getElementById('main');
  const max = Math.max(BOARD_SPLIT_MIN, (main?.clientHeight || 800) - BOARD_SPLIT_MARGIN);
  store.boardSplitHeight = Math.round(Math.min(max, Math.max(BOARD_SPLIT_MIN, px)));
}

function startBoardResize(event) {
  const main = document.getElementById('main');
  if (!main) return;
  const bottom = main.getBoundingClientRect().bottom;
  let frame = 0;

  const onMove = (e) => {
    setBoardSplit(bottom - e.clientY);
    // Refit on a frame, not on every mousemove: each one resizes the PTY.
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; window._refitOpenTerminals?.(); });
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.style.cursor = '';
    localStorage.setItem('boardSplitHeight', String(store.boardSplitHeight));
    window._refitOpenTerminals?.();
  };

  document.body.style.cursor = 'row-resize';
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  void event;
}

// Board with a session previewed below it: both panes are visible at once.
const boardSplitActive = computed(() =>
  store.activeTab === 'board' && !!store.boardPreviewId
);

const sessionListVisible = computed(() => store.activeTab === 'sessions');

const searchPlaceholder = computed(() => {
  switch (store.activeTab) {
    case 'plans': return 'Search plans...';
    case 'projects': return 'Search projects…';
    case 'board': return 'Search the board...';
    default: return 'Search sessions...';
  }
});

let searchDebounceTimer = null;

function onSearchValue(value) {
  store.searchQuery = value;
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(async () => {
    searchDebounceTimer = null;
    const query = store.searchQuery.trim();
    if (!query) { doClearSearch(); return; }
    if (store.activeTab === 'board') { runBoardSearch(query); return; }
    window.__sb?.search?.(query, store.searchTitlesOnly);
  }, 200);
}

// app.js's __sb.search dispatches on its own copy of the active tab and knows
// only the four list tabs, so on the board it falls through and nothing
// filters. Same index, same query, same destination — the result goes to
// store.searchMatchIds through the same bridge app.js uses, which is what the
// board's filterSessions() call already reads.
let boardSearchIds = null;

async function runBoardSearch(query) {
  try {
    const results = await window.api.search('session', query, store.searchTitlesOnly);
    boardSearchIds = new Set(results.map(r => r.id));
  } catch {
    boardSearchIds = null;
  }
  window.vueSidebar?.setSearch(boardSearchIds, null);
}

// app.js re-asserts its own (null) search set on every refreshSidebar, and
// those fire on the board too — a session exiting would otherwise drop an
// active board search without the user touching the field. Re-applying makes
// the field non-null, so this cannot re-enter.
watch(() => store.searchMatchIds, (ids) => {
  if (ids === null && boardSearchIds && store.activeTab === 'board' && store.searchQuery.trim()) {
    store.searchMatchIds = boardSearchIds;
  }
});

function doClearSearch() {
  store.searchQuery = '';
  boardSearchIds = null;
  if (searchDebounceTimer) { clearTimeout(searchDebounceTimer); searchDebounceTimer = null; }
  window.__sb?.clearSearch?.();
}

// No command palette yet — the ⌘K chip parks focus in the search field.
function focusSearch() {
  document.querySelector('.sbx-commandbar__input')?.focus();
}

async function toggleTitlesOnly() {
  store.searchTitlesOnly = !store.searchTitlesOnly;
  await window.api?.setSetting('searchTitlesOnly', store.searchTitlesOnly);
  const query = store.searchQuery.trim();
  if (!query) return;
  if (store.activeTab === 'board') runBoardSearch(query);
  else window.__sb?.search?.(query, store.searchTitlesOnly);
}

// ── Theme ────────────────────────────────────────────────────────
// Mirrored onto <html data-theme> — public/css/theme-light.css keys off it.
function applyTheme(next) {
  store.theme = next === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = store.theme;
  localStorage.setItem('theme', store.theme);
}

function toggleTheme() {
  applyTheme(store.theme === 'light' ? 'dark' : 'light');
}

// ── Active-session rail ──────────────────────────────────────────
// One entry per project that currently has a live session, worst status first
// so the projects wanting an answer sit at the front of the rail.
const REASONS = {
  waiting: 'needs input', done: 'response ready', running: 'working', idle: 'running',
};

const attentionProjects = computed(() => {
  const state = stateFromStore(store);
  const out = [];
  for (const p of store.projects) {
    const live = p.sessions.filter(s => store.activePtyIds.has(s.sessionId));
    if (!live.length) continue;
    const status = worstColumn(live, state);
    out.push({
      projectPath: p.projectPath,
      name: p.projectPath.split('/').filter(Boolean).pop() || p.projectPath,
      status,
      // Everything in this list is live, so 'idle' still reads as running —
      // saying otherwise would contradict the session header.
      reason: REASONS[status],
      count: live.length,
      recency: Math.max(...live.map(s => new Date(s.modified || 0).getTime() || 0)),
    });
  }
  // Waiting first, then the most recent within each band — the rail is a
  // worklist, so its front should always be the next thing to deal with.
  return out.sort((a, b) =>
    OPEN_ORDER[a.status] - OPEN_ORDER[b.status] || b.recency - a.recency);
});

// AttentionRail addresses entries by display name; the rail and the store
// speak projectPath.
const attentionActiveName = computed(() =>
  attentionProjects.value.find(p => p.projectPath === store.attentionProject)?.name || ''
);

function onSelectAttentionName(name) {
  const hit = attentionProjects.value.find(p => p.name === name);
  if (hit) onSelectAttentionProject(hit.projectPath);
}

function onSelectAttentionProject(projectPath) {
  store.attentionProject = projectPath;
  // The rail is on every tab, so a click from Plans or Projects has to take
  // you where the session actually lives.
  if (store.activeTab !== 'sessions') setTab('sessions');
  const project = store.projects.find(p => p.projectPath === projectPath);
  const live = project?.sessions.filter(s => store.activePtyIds.has(s.sessionId)) || [];
  if (!live.length) return;
  // Not the newest — the most urgent. A project with a dozen live sessions has
  // one that is actually holding a dialog, and that is the one the click means.
  const target = mostUrgent(live, stateFromStore(store));
  if (target) window.__sb?.openSession?.(target);
}

// ── Tab switching ────────────────────────────────────────────────
function setTab(tabId) {
  // A tab that has since been removed can still be sitting in the restored
  // ui_state — switching to it would leave an empty sidebar.
  if (!TABS.some(t => t.id === tabId)) return;
  if (tabId === store.activeTab) return;
  store.activeTab = tabId;
  // Clear search on tab switch
  store.searchQuery = '';
  boardSearchIds = null;
  store.searchMatchIds = null;
  store.searchMatchProjectPaths = null;
  window.__sb?.onTabChange?.(tabId);
}

// ── Filter tabs ──────────────────────────────────────────────────
// The redesign trades four independent toggles for one exclusive tab row, so
// picking a tab is the same as setting exactly one of the store's filter flags.
const FILTER_TABS = [
  { id: 'recent', label: 'Recent' },
  { id: 'running', label: 'Running' },
  { id: 'pinned', label: 'Pinned' },
  { id: 'today', label: 'Today' },
  { id: 'archived', label: 'Archived' },
];

function onFilterTab(id) {
  store.sessionFilterTab = id;
  store.showRunningOnly = id === 'running';
  store.showStarredOnly = id === 'pinned';
  store.showTodayOnly = id === 'today';
  store.showArchived = id === 'archived';
  localStorage.setItem('sessionFilterTab', id);
  window.__sb?.onFilterChange?.({
    showStarredOnly: store.showStarredOnly,
    showRunningOnly: store.showRunningOnly,
    showTodayOnly: store.showTodayOnly,
    showArchived: store.showArchived,
  });
}

function onViewMode(mode) {
  store.sidebarViewMode = mode;
  localStorage.setItem('sidebarViewMode', mode);
  if ((mode === 'grid') !== store.gridViewActive) window.__sb?.toggleGridView?.();
}

// ── Session side panel ───────────────────────────────────────────
// Only meaningful over an open session — it is scoped to that session's own
// project path. Opening, closing or resizing it changes the terminal's width,
// and xterm keeps its own cols/rows, so every transition ends in a refit.
// The board's bottom split gets it too: one pane at a time is narrow enough to
// share that space, and the shell in particular is worth having there.
const sidePanelVisible = computed(() =>
  !!store.sidePanelTab && !!store.headerSession
);

// An SDK-backed session has no xterm to show. Keyed by session id in the
// template so switching sessions rebuilds the transcript rather than appending
// one conversation onto another.
const sdkSessionVisible = computed(() =>
  !!store.headerSession && store.sdkSessionIds.has(store.headerSession.sessionId)
);

watch(sidePanelVisible, () => {
  requestAnimationFrame(() => window._refitOpenTerminals?.());
});

// ── Sidebar action callbacks ──────────────────────────────────────
function onGlobalSettings() { window.__sb?.openGlobalSettings?.(); }
function onResort() { window.__sb?.resort?.(); }
function onAddProject() { window.__sb?.addProject?.(); }

// ── Component callbacks ───────────────────────────────────────────
// Per-session actions are not here: SessionMenu calls window.__sb directly, so
// the list only forwards what the rows themselves still do.
const sidebarCallbacks = {
  openSession: (s) => window.__sb?.openSession?.(s),
  newSession: (project, btn) => window.__sb?.newSession?.(project, btn),
  openSettings: (path) => window.__sb?.openSettings?.(path),
  archiveSessions: (sessions) => window.__sb?.archiveSessions?.(sessions),
  removeProject: (path) => window.__sb?.removeProject?.(path),
};

const planCallbacks = {
  openPlan: (plan) => window.__sb?.openPlan?.(plan),
};

// A summary's link has to land exactly where a card click lands, so it goes
// through the board's own handler rather than repeating it here.
const boardSidebarCallbacks = {
  selectSession: (s) => boardRef.value?.selectSession(s),
};

const accountsCallbacks = {
  openAccountViewer: (id) => window.__sb?.openAccountViewer?.(id),
  switchAccount: (id) => window.__sb?.switchAccount?.(id),
  openAccountHomeSession: (acc) => window.__sb?.openAccountHomeSession?.(acc),
  renameAccount: (id, name) => window.__sb?.renameAccount?.(id, name),
  deleteAccount: (id) => window.__sb?.deleteAccount?.(id),
  createAccount: (name) => window.__sb?.createAccount?.(name),
  discoverWslClaudeHomes: () => window.__sb?.discoverWslClaudeHomes?.(),
  createWslAccount: (distro, name) => window.__sb?.createWslAccount?.(distro, name),
};

const accountDropdownCallbacks = {
  switchAccount: (id) => window.__sb?.switchAccount?.(id),
};

const projectsCallbacks = {
  openProject: (p) => window.__sb?.openProject?.(p),
  newSession: (p, btn) => window.__sb?.newSession?.(p, btn),
  addProject: () => window.__sb?.addProject?.(),
  projectRemoved: () => window.__sb?.projectRemoved?.(),
};

const projectViewerCallbacks = {
  newSession: (p, btn) => window.__sb?.newSession?.(p, btn),
  onTabChange: (tab) => window.__sb?.onPvTabChange?.(tab),
  worktreeDeleted: (worktreePath) => {
    store.projects = store.projects.filter(p => p.projectPath !== worktreePath);
  },
};

// ── Mount lifecycle ───────────────────────────────────────────────
onMounted(async () => {
  // Re-export component bridge APIs so app.js can call them
  Object.assign(window.vuePlans, {
    setPlans: (list) => plansRef.value?.setPlans(list),
    setActive: (f) => plansRef.value?.setActive(f),
    clearActive: () => plansRef.value?.clearActive(),
  });
  Object.assign(window.vueAccounts, {
    setAccounts: (list, id) => accountsRef.value?.setAccounts(list, id),
    setActiveAccount: (id) => accountsRef.value?.setActiveAccount(id),
    setUsage: (usage) => accountsRef.value?.setUsage(usage),
  });
  Object.assign(window.vueAccountDropdown, {
    setAccounts: (list, id, usage) => accountDropdownRef.value?.setAccounts(list, id, usage),
    setActiveAccount: (id) => accountDropdownRef.value?.setActiveAccount(id),
    setUsage: (usage) => accountDropdownRef.value?.setUsage(usage),
    close: () => accountDropdownRef.value?.close(),
  });
  Object.assign(window.vueProjects, {
    setProjects: (list) => projectsRef.value?.setProjects(list),
    setSearch: (q) => projectsRef.value?.setSearch(q),
    clearActive: () => projectsRef.value?.clearActive(),
    updateProjectInfo: (path, info) => projectsRef.value?.updateProjectInfo(path, info),
  });
  Object.assign(window.vueStatusBar, {
    setInfo: (text) => statusBarRef.value?.setInfo(text),
    setActivity: (text, type) => statusBarRef.value?.setActivity(text, type),
    setUpdater: (text, duration) => statusBarRef.value?.setUpdater(text, duration),
  });
  // GridCardsApp exposes addCard/updateCard/removeCard/clearAll directly
  window.vueGrid = gridCardsRef.value;

  const worktreePattern = /^(.+?)\/\.claude\/worktrees\/([^/]+)\/?$/;
  window.vueProjectViewer = {
    open: (proj) => {
      const worktrees = store.projects
        .filter(p => { const m = p.projectPath.match(worktreePattern); return m && m[1] === proj.projectPath; })
        .map(p => ({ projectPath: p.projectPath, name: p.projectPath.match(worktreePattern)?.[2] || p.projectPath }));
      projectViewerRef.value?.open(proj, worktrees);
    },
    close: () => projectViewerRef.value?.close(),
    setTab: (tab) => projectViewerRef.value?.setTab(tab),
  };
  window.vueApp = { setTab };
  window.vueJsonlViewer = { open: (s) => jsonlRef.value?.open(s) };
  window.vueAccountViewer = {
    load: (id) => accountViewerRef.value?.load(id),
    reload: () => accountViewerRef.value?.reload(),
  };
  Object.assign(window.vueDialogs, {
    openNewSession: (...args) => dialogsRef.value?.openNewSession(...args),
    openResumeSession: (...args) => dialogsRef.value?.openResumeSession(...args),
    openAddProject: (...args) => dialogsRef.value?.openAddProject(...args),
    openPopover: (...args) => dialogsRef.value?.openPopover(...args),
  });

  Object.assign(window.vuePlanViewer, {
    open: (...args) => planViewerRef.value?.open(...args),
  });

  // Settings panel — exposed so app.js and vanilla JS callers can open it.
  // Hides all vanilla-managed main-area content so the xterm canvas can't
  // intercept pointer events while settings is showing.
  window.openSettingsViewer = (scope, projectPath) => {
    store.planViewerOpen = false;
    const hide = ['terminal-area', 'placeholder', 'project-viewer'];
    for (const id of hide) {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    }
    store.showBoard = false;
    store.showJsonl = false;
    store.accountViewerOpen = false;
    store.settingsScope = scope || 'global';
    store.settingsProjectPath = projectPath || null;
    store.settingsOpen = true;
  };

  // Prevent browser "Save Page" shortcut from interfering with in-app Cmd+S save
  document.addEventListener('keydown', (e) => {
    const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? e.metaKey : e.ctrlKey;
    if (e.key === 's' && mod && !e.shiftKey && !e.altKey) e.preventDefault();
  });
  window.closeSettingsViewer = () => {
    store.settingsOpen = false;
    window._restoreAfterSettings?.();
  };

  // Restore persisted settings
  const savedTitlesOnly = await window.api?.getSetting('searchTitlesOnly');
  if (savedTitlesOnly) store.searchTitlesOnly = true;

  // Restore theme before anything paints a colour
  applyTheme(localStorage.getItem('theme'));

  // Restore filter preferences from localStorage. Older builds persisted four
  // independent flags; fold whichever was on into the matching tab.
  const savedTab = localStorage.getItem('sessionFilterTab')
    || (localStorage.getItem('showRunningOnly') === '1' && 'running')
    || (localStorage.getItem('showStarredOnly') === '1' && 'pinned')
    || (localStorage.getItem('showTodayOnly') === '1' && 'today')
    || (localStorage.getItem('showArchived') === '1' && 'archived')
    || 'recent';
  store.sessionFilterTab = FILTER_TABS.some(t => t.id === savedTab) ? savedTab : 'recent';
  store.showRunningOnly = store.sessionFilterTab === 'running';
  store.showStarredOnly = store.sessionFilterTab === 'pinned';
  store.showTodayOnly = store.sessionFilterTab === 'today';
  store.showArchived = store.sessionFilterTab === 'archived';
  store.sidebarViewMode = localStorage.getItem('sidebarViewMode') === 'grid' ? 'grid' : 'list';
  const savedSplit = Number(localStorage.getItem('boardSplitHeight'));
  if (Number.isFinite(savedSplit) && savedSplit > 0) store.boardSplitHeight = savedSplit;

  // Session side panel — the open pane and the width survive a restart.
  store.sidePanelTab = loadSidePanelTab();
  const savedPanelWidth = parseInt(localStorage.getItem('sessionSidePanelWidth'), 10);
  if (Number.isFinite(savedPanelWidth) && savedPanelWidth >= 280) store.sidePanelWidth = savedPanelWidth;

  // Plan viewer globals (migrated from plans-memory-view.js)
  window.cachedPlans = [];

  window.loadPlans = async () => {
    window.cachedPlans = await window.api.getPlans();
    window.vuePlans?.setPlans(window.cachedPlans);
  };
  window.renderPlans = (plans) => {
    window.vuePlans?.setPlans(plans || window.cachedPlans);
  };
  window.openPlan = async (plan) => {
    window.vuePlans?.setActive(plan.filename);
    const result = await window.api.readPlan(plan.filename);
    document.getElementById('placeholder').style.display = 'none';
    document.getElementById('terminal-area').style.display = 'none';
    document.getElementById('project-viewer').style.display = 'none';
    window.vueProjectViewer?.close();
    if (window.vueStore) {
      window.vueStore.settingsOpen = false;
      window.vueStore.showJsonl = false;
      window.vueStore.planViewerOpen = true;
    }
    window.vuePlanViewer?.open(plan.title || plan.filename, result.filePath, result.content);
  };
  window.hideAllViewers = () => {
    if (window.vueStore) {
      window.vueStore.planViewerOpen = false;
      window.vueStore.settingsOpen = false;
      // Opening a session calls through here; that must not close the board
      // when the board is the thing showing that session.
      if (!(window.vueStore.activeTab === 'board' && window.vueStore.boardPreviewId)) {
        window.vueStore.showBoard = false;
      }
      window.vueStore.showJsonl = false;
      window.vueStore.accountViewerOpen = false;
    }
    const pv = document.getElementById('project-viewer');
    if (pv) pv.style.display = 'none';
    window.vueProjectViewer?.close();
    const ta = document.getElementById('terminal-area');
    if (ta) ta.style.display = '';
  };
  window.hidePlanViewer = window.hideAllViewers;
});
</script>
