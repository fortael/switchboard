import { reactive } from 'vue';

export const store = reactive({
  // Project/session data. `projects` is what the sidebar's filter tab selected
  // — archived sessions are simply absent while the Archived tab is not the
  // one showing. `allProjects` is the unfiltered set, for views that are not
  // downstream of that filter (a project's own page).
  projects: [],
  allProjects: [],

  // Session runtime state
  activePtyIds: new Set(),
  activeSessionId: null,
  sessionBusyState: new Map(),
  attentionSessions: new Set(),
  responseReadySessions: new Set(),
  // Sessions whose finished turn the user has already opened but not yet left.
  // The sidebar's blue dot clears the instant you click a session, so
  // responseReadySessions alone would yank a board card out of DONE under the
  // cursor. app.js parks the id here instead and drops it when the active
  // session changes, which is the moment the board calls "read and left".
  readPendingSessions: new Set(),
  lastActivityTime: new Map(),
  pendingSessions: new Set(),

  // Filter state
  showStarredOnly: false,
  showRunningOnly: false,
  showTodayOnly: false,
  showArchived: false,
  searchMatchIds: null,
  searchMatchProjectPaths: null,

  // Visibility settings
  visibleSessionCount: 10,
  sessionMaxAgeDays: 3,

  // Header state (active session context)
  headerSession: null,
  headerPtyTitle: null,
  headerShellProfile: null,
  headerAccount: null,
  headerAccounts: [],

  // App layout state
  activeTab: 'sessions',
  sidebarCollapsed: false,
  theme: 'dark',                 // 'dark' | 'light' — mirrored onto <html data-theme>
  sessionFilterTab: 'recent',    // FilterTabs selection: recent | running | pinned
  sidebarViewMode: 'list',       // 'list' | 'grid'
  attentionProject: null,        // projectPath highlighted in the active-sessions rail
  loadingStatus: '',
  accountSwitching: false,
  searchQuery: '',
  searchTitlesOnly: false,

  // Settings panel
  settingsOpen: false,
  settingsScope: 'global',       // 'global' | 'project'
  settingsProjectPath: null,

  // Main area panel visibility (Vue-owned — do not touch via innerHTML/style directly)
  showBoard: false,
  // Session previewed in the board's bottom split — the real terminal, not a
  // copy. null = board full height.
  boardPreviewId: null,
  boardHighlightFresh: false,     // fade board cards by age
  boardSplitHeight: 380,          // px, height of the session pane under the board
  // projectPath the board is scoped to, or null for every project. It lives
  // here rather than in SessionBoardApp because the control is in the board's
  // sidebar and the rendering is in the board — two siblings, one truth.
  boardProjectFilter: null,
  showJsonl: false,
  planViewerOpen: false,
  gridViewActive: false,
  gridViewerCount: '',
  accountViewerOpen: false,      // Accounts tab detail panel in the main area
  accountViewerId: null,         // which account it is showing

  // Session side panel — uncommitted changes / containers / scratch shell for
  // the session that is open in the main area. Scoped to that session's own
  // projectPath, which may be a worktree the Projects tab is not showing.
  sidePanelOpen: false,
  sidePanelWidth: 380,

  // Project avatars: projectPath → data: URL string
  avatarDataUrls: {},
});
