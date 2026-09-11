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
  // Sessions driven by the Agent SDK rather than a PTY. They carry the same
  // conversation and write the same transcript; only the transport and the
  // component that renders them differ. app.js records this from what
  // open-terminal reports.
  sdkSessionIds: new Set(),
  activeSessionId: null,
  sessionBusyState: new Map(),
  attentionSessions: new Set(),
  responseReadySessions: new Set(),
  // Sessions whose finished turn the user has already seen but not yet left.
  // The sidebar's blue dot clears the instant you click a session, so
  // responseReadySessions alone would yank a board card out of DONE under the
  // cursor. app.js parks the id here instead and drops it when focus moves to
  // another session or the view is closed — the two gestures that mean "done
  // with it".
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
  // Board cards fly between columns unless this, or the OS setting, says no.
  reduceMotion: false,
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
  // Fade session cards by how long ago they last did anything. One flag, not
  // one per view: the board and a project's Sessions tab show the same button
  // with the same label over the same ladder (freshness.js), so remembering two
  // different answers for it would only ever read as a bug. Persisted into
  // `ui_state` — see the watcher in App.vue.
  highlightFresh: true,
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
  //
  // One pane at a time, named rather than a boolean: the tab is what persists
  // across a session switch. Keeping the shell open and stepping through
  // sessions is the point — the pane stays, its contents re-scope to whatever
  // session is now in front. null means closed.
  sidePanelTab: null,            // null | 'changes' | 'containers' | 'shell'
  sidePanelWidth: 380,
  // Last get-project-detail the panel loaded, published so the rail can badge
  // its buttons without issuing a second call — get-project-detail broadcasts
  // `projects-changed`, which re-renders the whole sidebar, so it is not free.
  sidePanelDetail: null,

  // Project avatars: projectPath → data: URL string
  avatarDataUrls: {},
});
