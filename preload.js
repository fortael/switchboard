const { contextBridge, ipcRenderer, webUtils, webFrame } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Invoke (request-response)
  getPlans: () => ipcRenderer.invoke('get-plans'),
  readPlan: (filename) => ipcRenderer.invoke('read-plan', filename),
  savePlan: (filePath, content) => ipcRenderer.invoke('save-plan', filePath, content),
  getStats: () => ipcRenderer.invoke('get-stats'),
  refreshStats: () => ipcRenderer.invoke('refresh-stats'),
  getUsage: () => ipcRenderer.invoke('get-usage'),
  getCachedUsage: () => ipcRenderer.invoke('get-cached-usage'),
  getMemories: () => ipcRenderer.invoke('get-memories'),
  readMemory: (filePath) => ipcRenderer.invoke('read-memory', filePath),
  saveMemory: (filePath, content) => ipcRenderer.invoke('save-memory', filePath, content),
  getProjects: (showArchived) => ipcRenderer.invoke('get-projects', showArchived),
  getActiveSessions: () => ipcRenderer.invoke('get-active-sessions'),
  getActiveTerminals: () => ipcRenderer.invoke('get-active-terminals'),
  stopSession: (id) => ipcRenderer.invoke('stop-session', id),
  toggleStar: (id) => ipcRenderer.invoke('toggle-star', id),
  renameSession: (id, name) => ipcRenderer.invoke('rename-session', id, name),
  archiveSession: (id, archived) => ipcRenderer.invoke('archive-session', id, archived),
  openTerminal: (id, projectPath, isNew, sessionOptions) => ipcRenderer.invoke('open-terminal', id, projectPath, isNew, sessionOptions),
  search: (type, query, titleOnly) => ipcRenderer.invoke('search', type, query, titleOnly),
  readSessionJsonl: (sessionId) => ipcRenderer.invoke('read-session-jsonl', sessionId),

  // Settings
  getSetting: (key) => ipcRenderer.invoke('get-setting', key),
  setSetting: (key, value) => ipcRenderer.invoke('set-setting', key, value),
  deleteSetting: (key) => ipcRenderer.invoke('delete-setting', key),

  // Interface scale. Page zoom rather than a CSS transform: it changes the CSS
  // pixel size of the whole frame, so text, spacing, icons and the terminal
  // canvas all scale together and stay crisp at the new device pixel ratio.
  // Clamped here as well as in the renderer — this is the call that can leave
  // the window unusable if a stored value is ever garbage.
  setUiZoom: (factor) => {
    const f = Number(factor);
    webFrame.setZoomFactor(Number.isFinite(f) && f > 0 ? Math.min(1.5, Math.max(0.8, f)) : 1);
  },
  // Zoom costs CSS pixels, so the window's minimum size has to follow it. Takes the
  // same zoom factor as setUiZoom, not a percentage — one unit across the bridge.
  setUiScaleMinimum: (factor) => ipcRenderer.invoke('set-ui-scale-minimum', factor),

  // Tray. The tray lives in the main process, so switching it on or off is a request
  // rather than a stored value the renderer applies itself. Resolves to whether a
  // tray icon actually exists afterwards, which a desktop without a tray host can
  // refuse.
  setTrayEnabled: (enabled) => ipcRenderer.invoke('set-tray-enabled', enabled),
  // Which session the user is looking at, so the tray does not report an alert for a
  // session already on screen.
  sessionViewed: (sessionId) => ipcRenderer.send('session-viewed', sessionId),
  onFocusSession: (callback) => {
    ipcRenderer.on('focus-session', (_event, sessionId) => callback(sessionId));
  },

  // Multi-account
  getAccounts: () => ipcRenderer.invoke('get-accounts'),
  saveAccounts: (accounts) => ipcRenderer.invoke('save-accounts', accounts),
  createAccount: (name) => ipcRenderer.invoke('create-account', name),
  discoverWslClaudeHomes: () => ipcRenderer.invoke('discover-wsl-claude-homes'),
  listWslDistros: () => ipcRenderer.invoke('list-wsl-distros'),
  createWslAccount: (distro, name, claudePosix) =>
    ipcRenderer.invoke('create-wsl-account', distro, name, claudePosix),
  renameAccount: (id, name) => ipcRenderer.invoke('rename-account', id, name),
  deleteAccount: (id) => ipcRenderer.invoke('delete-account', id),
  restoreDefaultAccount: () => ipcRenderer.invoke('restore-default-account'),
  getActiveAccountId: () => ipcRenderer.invoke('get-active-account-id'),
  setActiveAccountId: (id) => ipcRenderer.invoke('set-active-account-id', id),
  getAccountsUsage: () => ipcRenderer.invoke('get-accounts-usage'),
  getHomedir: () => ipcRenderer.invoke('get-homedir'),
  getEffectiveSettings: (projectPath) => ipcRenderer.invoke('get-effective-settings', projectPath),
  getScheduleCreatorCommand: () => ipcRenderer.invoke('get-schedule-creator-command'),
  createScheduleSession: (projectPath) => ipcRenderer.invoke('create-schedule-session', projectPath),
  runScheduleNow: (filePath) => ipcRenderer.invoke('run-schedule-now', filePath),
  getShellProfiles: () => ipcRenderer.invoke('get-shell-profiles'),

  browseFolder: () => ipcRenderer.invoke('browse-folder'),
  addProject: (projectPath) => ipcRenderer.invoke('add-project', projectPath),
  removeProject: (projectPath) => ipcRenderer.invoke('remove-project', projectPath),
  getProjectInfo: (projectPath) => ipcRenderer.invoke('get-project-info', projectPath),
  getProjectDetail: (projectPath) => ipcRenderer.invoke('get-project-detail', projectPath),
  getProjectGitCache: (projectPath) => ipcRenderer.invoke('get-project-git-cache', projectPath),
  getFileDiff: (projectPath, filePath) => ipcRenderer.invoke('get-file-diff', projectPath, filePath),
  gitBranches: (projectPath) => ipcRenderer.invoke('git-branches', projectPath),
  gitCheckout: (projectPath, branch) => ipcRenderer.invoke('git-checkout', projectPath, branch),
  gitFetch: (projectPath) => ipcRenderer.invoke('git-fetch', projectPath),
  gitPull: (projectPath) => ipcRenderer.invoke('git-pull', projectPath),
  gitCommit: (projectPath, message) => ipcRenderer.invoke('git-commit', projectPath, message),
  gitPush: (projectPath) => ipcRenderer.invoke('git-push', projectPath),
  gitCreateBranch: (projectPath, branchName, checkout) => ipcRenderer.invoke('git-create-branch', projectPath, branchName, checkout),
  getProjectAvatar: (projectPath) => ipcRenderer.invoke('get-project-avatar', projectPath),
  fetchGitlabAvatar: (projectPath, remoteUrl) => ipcRenderer.invoke('fetch-gitlab-avatar', projectPath, remoteUrl),
  gitGenerateCommitMsg: (projectPath, style) => ipcRenderer.invoke('git-generate-commit-msg', projectPath, style),
  getGitUserInfo: (projectPath) => ipcRenderer.invoke('get-git-user-info', projectPath),
  deleteWorktree: (projectPath, worktreePath) => ipcRenderer.invoke('delete-worktree', projectPath, worktreePath),
  getFileTree: (projectPath) => ipcRenderer.invoke('get-file-tree', projectPath),
  getProjectSessions: (projectPath) => ipcRenderer.invoke('get-project-sessions', projectPath),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // Send (fire-and-forget)
  sendInput: (id, data) => ipcRenderer.send('terminal-input', id, data),
  resizeTerminal: (id, cols, rows) => ipcRenderer.send('terminal-resize', id, cols, rows),
  closeTerminal: (id) => ipcRenderer.send('close-terminal', id),

  // Listeners (main → renderer)
  onTerminalData: (callback) => {
    ipcRenderer.on('terminal-data', (_event, sessionId, data) => callback(sessionId, data));
  },
  onSessionDetected: (callback) => {
    ipcRenderer.on('session-detected', (_event, tempId, realId) => callback(tempId, realId));
  },
  onProcessExited: (callback) => {
    ipcRenderer.on('process-exited', (_event, sessionId, exitCode) => callback(sessionId, exitCode));
  },
  onTerminalNotification: (callback) => {
    // needsAttention is the main process's verdict on the message: whether the CLI is
    // asking the user for something rather than just reporting.
    ipcRenderer.on('terminal-notification', (_event, sessionId, message, needsAttention) => {
      callback(sessionId, message, needsAttention);
    });
  },
  onCliBusyState: (callback) => {
    ipcRenderer.on('cli-busy-state', (_event, sessionId, busy) => callback(sessionId, busy));
  },
  onSessionForked: (callback) => {
    ipcRenderer.on('session-forked', (_event, oldId, newId) => callback(oldId, newId));
  },
  onProjectsChanged: (callback) => {
    ipcRenderer.on('projects-changed', () => callback());
  },
  onProjectInfoUpdated: (callback) => {
    ipcRenderer.on('project-info-updated', (_event, path, data) => callback(path, data));
  },
  onProjectInfoLoading: (callback) => {
    ipcRenderer.on('project-info-loading', (_event, path) => callback(path));
  },
  onStatusUpdate: (callback) => {
    ipcRenderer.on('status-update', (_event, text, type) => callback(text, type));
  },

  // File drag-and-drop
  getPathForFile: (file) => webUtils.getPathForFile(file),

  // Platform
  platform: process.platform,

  // App version
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  // Auto-updater
  updaterCheck: () => ipcRenderer.invoke('updater-check'),
  updaterDownload: () => ipcRenderer.invoke('updater-download'),
  updaterInstall: () => ipcRenderer.invoke('updater-install'),
  onUpdaterEvent: (callback) => {
    ipcRenderer.on('updater-event', (_event, type, data) => callback(type, data));
  },

  // MCP bridge (main → renderer)
  onMcpOpenDiff: (callback) => {
    ipcRenderer.on('mcp-open-diff', (_event, sessionId, diffId, data) => callback(sessionId, diffId, data));
  },
  onMcpOpenFile: (callback) => {
    ipcRenderer.on('mcp-open-file', (_event, sessionId, data) => callback(sessionId, data));
  },
  onMcpCloseAllDiffs: (callback) => {
    ipcRenderer.on('mcp-close-all-diffs', (_event, sessionId) => callback(sessionId));
  },
  onMcpCloseTab: (callback) => {
    ipcRenderer.on('mcp-close-tab', (_event, sessionId, diffId) => callback(sessionId, diffId));
  },

  // MCP bridge (renderer → main)
  mcpDiffResponse: (sessionId, diffId, action, editedContent) => {
    ipcRenderer.send('mcp-diff-response', sessionId, diffId, action, editedContent);
  },
  readFileForPanel: (filePath) => ipcRenderer.invoke('read-file-for-panel', filePath),
  saveFileForPanel: (filePath, content) => ipcRenderer.invoke('save-file-for-panel', filePath, content),
  watchFile: (filePath) => ipcRenderer.invoke('watch-file', filePath),
  unwatchFile: (filePath) => ipcRenderer.invoke('unwatch-file', filePath),
  onFileChanged: (callback) => {
    ipcRenderer.on('file-changed', (_event, filePath) => callback(filePath));
  },
  onLaunchProjectSession: (callback) => {
    ipcRenderer.on('launch-project-session', (_event, projectPath, continueSession) => callback(projectPath, continueSession));
  },
});
