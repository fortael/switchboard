import { reactive } from 'vue';

export const store = reactive({
  // Project/session data
  projects: [],

  // Session runtime state
  activePtyIds: new Set(),
  activeSessionId: null,
  sessionBusyState: new Map(),
  attentionSessions: new Set(),
  responseReadySessions: new Set(),
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

  // Multi-account. In the merged view the sidebar lists every account's projects
  // at once, so a session has to say which account it belongs to; outside it the
  // list is one account's own and the badges stay off.
  mergedAccountView: false,
  accounts: [],
  activeAccountId: 'default',

  // Header state (active session context)
  headerSession: null,
  headerPtyTitle: null,
  headerShellProfile: null,
  headerAccount: null,
  headerAccounts: [],

  // App layout state
  activeTab: 'sessions',
  sidebarCollapsed: false,
  loadingStatus: '',
  accountSwitching: false,
  searchQuery: '',
  searchTitlesOnly: false,

  // Settings panel
  settingsOpen: false,
  settingsScope: 'global',       // 'global' | 'project'
  settingsProjectPath: null,

  // Main area panel visibility (Vue-owned — do not touch via innerHTML/style directly)
  showStats: false,
  showJsonl: false,
  planViewerOpen: false,
  memoryViewerOpen: false,
  gridViewActive: false,
  gridViewerCount: '',

  // Project avatars: projectPath → data: URL string
  avatarDataUrls: {},
});
