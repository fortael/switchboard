<template>
  <div class="sbx-shell">
  <!-- ── TOP NAV ────────────────────────────────────────────────── -->
  <TopNavApp
    :tabs="store.sidebarCollapsed ? [] : TABS"
    :active-id="store.activeTab"
    :theme="store.theme"
    :sidebar-collapsed="store.sidebarCollapsed"
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
         wherever you are. Renders nothing when nothing is running. -->
    <AttentionRail
      :items="attentionProjects"
      :active-name="attentionActiveName"
      @select="onSelectAttentionName"
    />

    <FilterTabs
      v-if="store.activeTab === 'sessions'"
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
          data-tooltip="Re-sort sessions"
          aria-label="Re-sort sessions"
          @click="onResort"
        >
          <SbIcon name="refresh-cw" :size="13" tone="muted" />
        </button>
      </template>
    </FilterTabs>

    <!-- Sidebar content panels (v-show keeps DOM alive for vanilla JS queries) -->
    <div id="sidebar-content" class="sbx-sidebar-panel" v-show="store.activeTab === 'sessions' && !store.accountSwitching">
      <SidebarApp :callbacks="sidebarCallbacks" />
    </div>
    <div v-if="store.accountSwitching && store.activeTab === 'sessions'" id="account-switch-overlay" class="account-switch-preloader">
      <div class="acct-spinner"></div><span>Switching account…</span>
    </div>
    <div id="plans-content" class="sbx-sidebar-panel" v-show="store.activeTab === 'plans'">
      <PlansApp ref="plansRef" :callbacks="planCallbacks" />
    </div>
    <div id="stats-content" class="sbx-sidebar-panel" v-show="store.activeTab === 'stats'">
      <div class="plans-empty">Click the Stats tab to view activity heatmap.</div>
    </div>
    <div id="memory-content" class="sbx-sidebar-panel" v-show="store.activeTab === 'memory'">
      <MemoryApp ref="memoryRef" :callbacks="memoryCallbacks" />
    </div>
    <div id="accounts-content" class="sbx-sidebar-panel" v-show="store.activeTab === 'accounts'">
      <AccountsApp ref="accountsRef" :callbacks="accountsCallbacks" />
    </div>
    <div id="projects-content" class="sbx-sidebar-panel" v-show="store.activeTab === 'projects'">
      <ProjectsApp ref="projectsRef" :callbacks="projectsCallbacks" />
    </div>
  </div>

  <!-- ── RESIZE HANDLE ──────────────────────────────────────────── -->
  <div id="sidebar-resize-handle" v-show="!store.sidebarCollapsed"></div>

  <!-- ── MAIN AREA ──────────────────────────────────────────────── -->
  <div id="main">
    <div id="placeholder">
      <p>Select a session from the sidebar to begin.</p>
    </div>
    <div id="stats-viewer" v-show="store.showStats">
      <div id="stats-viewer-header">
        <span id="stats-viewer-title">Activity</span>
        <button
          class="stats-refresh-btn"
          :class="{ 'stats-refresh-spinning': statsRef?.isRefreshing }"
          :disabled="statsRef?.isRefreshing"
          title="Refresh stats (runs claude /stats)"
          @click="statsRef?.refreshAll()"
          v-html="STATS_REFRESH_SVG"
        ></button>
      </div>
      <StatsApp ref="statsRef" />
    </div>
    <div id="memory-viewer" v-show="store.memoryViewerOpen">
      <ViewerContentApp
        ref="memoryViewerRef"
        language="markdown"
        storage-key="markdownPreviewMode"
        :show-copy-path="true"
        :show-copy-content="true"
        :on-save="memoryOnSave"
      />
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
    <div id="terminal-area">
      <div id="vue-session-header">
        <SessionHeaderApp />
      </div>
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
import { ref, computed, onMounted } from 'vue';
import { store } from '../store.js';
import SbIcon from './SbIcon.vue';
import TopNavApp from './TopNavApp.vue';
import CollapsedRailApp from './CollapsedRailApp.vue';
import CommandBar from './CommandBar.vue';
import FilterTabs from './FilterTabs.vue';
import AttentionRail from './AttentionRail.vue';
import SidebarApp from './SidebarApp.vue';
import SessionHeaderApp from './SessionHeaderApp.vue';
import PlansApp from './PlansApp.vue';
import MemoryApp from './MemoryApp.vue';
import AccountsApp from './AccountsApp.vue';
import AccountDropdownApp from './AccountDropdownApp.vue';
import ProjectsApp from './ProjectsApp.vue';
import StatusBarApp from './StatusBarApp.vue';
import GridCardsApp from './GridCardsApp.vue';
import SettingsPanelApp from './SettingsPanelApp.vue';
import ProjectViewerApp from './ProjectViewerApp.vue';
import StatsApp from './StatsApp.vue';
import JsonlViewerApp from './JsonlViewerApp.vue';
import AccountViewerApp from './AccountViewerApp.vue';
import ViewerContentApp from './ViewerContentApp.vue';
import DialogsApp from './DialogsApp.vue';

// ── Template refs ────────────────────────────────────────────────
const plansRef = ref(null);
const memoryRef = ref(null);
const accountsRef = ref(null);
const accountDropdownRef = ref(null);
const projectsRef = ref(null);
const statusBarRef = ref(null);
const gridCardsRef = ref(null);
const projectViewerRef = ref(null);
const statsRef = ref(null);
const jsonlRef = ref(null);
const accountViewerRef = ref(null);
const planViewerRef = ref(null);
const memoryViewerRef = ref(null);
const dialogsRef = ref(null);

const planOnSave = (filePath, content) => window.api.savePlan(filePath, content);
const memoryOnSave = (filePath, content) => window.api.saveMemory(filePath, content);

// ── Tab config ───────────────────────────────────────────────────
const TABS = [
  { id: 'sessions', icon: 'sparkles', label: 'Sessions' },
  { id: 'plans', icon: 'book-open', label: 'Plans' },
  { id: 'memory', icon: 'brain', label: 'Agent Files' },
  { id: 'stats', icon: 'chart-no-axes-column', label: 'Stats' },
  { id: 'projects', icon: 'folder', label: 'Projects' },
  { id: 'accounts', icon: 'users', label: 'Accounts' },
];

// ── Icons ────────────────────────────────────────────────────────
const STATS_REFRESH_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>';

// ── Search ───────────────────────────────────────────────────────
const searchPlaceholder = computed(() => {
  switch (store.activeTab) {
    case 'plans': return 'Search plans...';
    case 'memory': return 'Search agent files...';
    case 'projects': return 'Search projects…';
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
    window.__sb?.search?.(query, store.searchTitlesOnly);
  }, 200);
}

function doClearSearch() {
  store.searchQuery = '';
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
  if (store.searchQuery.trim()) {
    window.__sb?.search?.(store.searchQuery.trim(), store.searchTitlesOnly);
  }
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
// One entry per project that currently has a live PTY, worst status first so
// the projects wanting attention sit at the front of the rail.
const ATTENTION_ORDER = { waiting: 0, done: 1, running: 2, idle: 3 };

const attentionProjects = computed(() => {
  const out = [];
  for (const p of store.projects) {
    const live = p.sessions.filter(s => store.activePtyIds.has(s.sessionId));
    if (!live.length) continue;
    // Everything in this list has a live PTY, so 'running' is the floor —
    // 'idle' would contradict the session header, which says Running.
    let status = 'running';
    let reason = 'running';
    if (live.some(s => store.attentionSessions.has(s.sessionId))) {
      status = 'waiting'; reason = 'needs input';
    } else if (live.some(s => store.responseReadySessions.has(s.sessionId))) {
      status = 'done'; reason = 'response ready';
    } else if (live.some(s => store.sessionBusyState.get(s.sessionId))) {
      reason = 'working';
    }
    out.push({
      projectPath: p.projectPath,
      name: p.projectPath.split('/').filter(Boolean).pop() || p.projectPath,
      status,
      reason,
      count: live.length,
    });
  }
  return out.sort((a, b) => ATTENTION_ORDER[a.status] - ATTENTION_ORDER[b.status]);
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
  const newest = live.reduce((a, b) => (new Date(b.modified || 0) > new Date(a.modified || 0) ? b : a));
  window.__sb?.openSession?.(newest);
}

// ── Tab switching ────────────────────────────────────────────────
function setTab(tabId) {
  if (tabId === store.activeTab) return;
  store.activeTab = tabId;
  // Clear search on tab switch
  store.searchQuery = '';
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

// ── Sidebar action callbacks ──────────────────────────────────────
function onGlobalSettings() { window.__sb?.openGlobalSettings?.(); }
function onResort() { window.__sb?.resort?.(); }
function onAddProject() { window.__sb?.addProject?.(); }

// ── Component callbacks ───────────────────────────────────────────
const sidebarCallbacks = {
  openSession: (s) => window.__sb?.openSession?.(s),
  stopSession: (id) => window.__sb?.stopSession?.(id),
  toggleStar: (id) => window.__sb?.toggleStar?.(id),
  archiveSession: (id) => window.__sb?.archiveSession?.(id),
  forkSession: (id) => window.__sb?.forkSession?.(id),
  showJsonl: (id) => window.__sb?.showJsonl?.(id),
  launchConfig: (id) => window.__sb?.launchConfig?.(id),
  renameSession: (id, name) => window.__sb?.renameSession?.(id, name),
  newSession: (project, btn) => window.__sb?.newSession?.(project, btn),
  openSettings: (path) => window.__sb?.openSettings?.(path),
  archiveSessions: (sessions) => window.__sb?.archiveSessions?.(sessions),
  removeProject: (path) => window.__sb?.removeProject?.(path),
};

const planCallbacks = {
  openPlan: (plan) => window.__sb?.openPlan?.(plan),
};

const memoryCallbacks = {
  openMemory: (file) => window.__sb?.openMemory?.(file),
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
  Object.assign(window.vueMemory, {
    setMemories: (data, ids) => memoryRef.value?.setMemories(data, ids),
    setFilter: (ids) => memoryRef.value?.setFilter(ids),
    setActive: (f) => memoryRef.value?.setActive(f),
    clearActive: () => memoryRef.value?.clearActive(),
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
  window.vueStats = {
    load: () => statsRef.value?.load(),
    invalidate: () => statsRef.value?.invalidate(),
  };
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
  Object.assign(window.vueMemoryViewer, {
    open: (...args) => memoryViewerRef.value?.open(...args),
  });

  // Settings panel — exposed so app.js and vanilla JS callers can open it.
  // Hides all vanilla-managed main-area content so the xterm canvas can't
  // intercept pointer events while settings is showing.
  window.openSettingsViewer = (scope, projectPath) => {
    store.planViewerOpen = false;
    store.memoryViewerOpen = false;
    const hide = ['terminal-area', 'placeholder', 'project-viewer'];
    for (const id of hide) {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    }
    store.showStats = false;
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

  // Plans & memory viewer globals (migrated from plans-memory-view.js)
  let cachedMemoryData = { global: { files: [] }, projects: [] };
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
      window.vueStore.memoryViewerOpen = false;
      window.vueStore.settingsOpen = false;
      window.vueStore.showStats = false;
      window.vueStore.showJsonl = false;
      window.vueStore.planViewerOpen = true;
    }
    window.vuePlanViewer?.open(plan.title || plan.filename, result.filePath, result.content);
  };
  window.loadMemories = async () => {
    cachedMemoryData = await window.api.getMemories();
    window.vueMemory?.setMemories(cachedMemoryData, null);
  };
  window.renderMemories = (filterIds) => {
    window.vueMemory?.setMemories(cachedMemoryData, filterIds || null);
  };
  window.openMemory = async (file) => {
    window.vueMemory?.setActive(file.filePath);
    const content = await window.api.readMemory(file.filePath);
    document.getElementById('placeholder').style.display = 'none';
    document.getElementById('terminal-area').style.display = 'none';
    document.getElementById('project-viewer').style.display = 'none';
    window.vueProjectViewer?.close();
    if (window.vueStore) {
      window.vueStore.planViewerOpen = false;
      window.vueStore.settingsOpen = false;
      window.vueStore.showStats = false;
      window.vueStore.showJsonl = false;
      window.vueStore.memoryViewerOpen = true;
    }
    window.vueMemoryViewer?.open(file.filename, file.filePath, content);
  };
  window.hideAllViewers = () => {
    if (window.vueStore) {
      window.vueStore.planViewerOpen = false;
      window.vueStore.memoryViewerOpen = false;
      window.vueStore.settingsOpen = false;
      window.vueStore.showStats = false;
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
