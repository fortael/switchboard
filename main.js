const { app, BrowserWindow, dialog, ipcMain, Menu, screen, shell } = require('electron');
const { Worker } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('node-pty');

if (!app.isPackaged) {
  const origUserData = app.getPath('userData');
  const devUserData = origUserData + '-dev';
  if (!fs.existsSync(devUserData) && fs.existsSync(origUserData)) {
    fs.cpSync(origUserData, devUserData, {
      recursive: true,
      filter: (src) => !/(SingletonLock|SingletonSocket|SingletonCookie)$/.test(src),
    });
  } else if (!fs.existsSync(devUserData)) {
    fs.mkdirSync(devUserData, { recursive: true });
  }
  app.setPath('userData', devUserData);
}

const log = require('electron-log');
// getFolderIndexMtimeMs moved to session-cache.js
const { startMcpServer, shutdownMcpServer, shutdownAll: shutdownAllMcp, resolvePendingDiff, rekeyMcpServer, cleanStaleLockFiles } = require('./mcp-bridge');
const { startHookServer, stopHookServer } = require('./hook-server');
const { buildHookSettings } = require('./hook-settings');
const { SessionStatusTracker } = require('./session-status');
const sdkSession = require('./sdk-session');
const { fetchAndTransformUsage, getOAuthToken, probeUsage } = require('./claude-auth');
log.transports.file.level = app.isPackaged ? 'info' : 'debug';
log.transports.console.level = app.isPackaged ? 'info' : 'debug';

try { require('electron-reloader')(module, { watchRenderer: false }); } catch {};
try {
  const chokidar = require('chokidar');
  let _reloadTimer;
  chokidar.watch(['public/vue-bundle.js', 'public/style.css'], { ignoreInitial: true })
    .on('change', () => {
      clearTimeout(_reloadTimer);
      _reloadTimer = setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.reloadIgnoringCache();
        }
      }, 400);
    });
} catch {}

// Clean env for child processes — strip Electron internals that cause nested
// Electron apps (or node-pty inside them) to malfunction.
const cleanPtyEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) =>
    !k.startsWith('ELECTRON_') &&
    !k.startsWith('GOOGLE_API_KEY') &&
    k !== 'NODE_OPTIONS' &&
    k !== 'ORIGINAL_XDG_CURRENT_DESKTOP' &&
    k !== 'WT_SESSION'
  )
);

// Shell profiles → shell-profiles.js
const {
  discoverShellProfiles, getShellProfiles, resolveShell, isWindows, isWslShell,
  windowsToWslPath, shellArgs,
  wslToWindowsPath, isPosixAbsolutePath, probeWslClaudeHome, discoverWslClaudeHomes, wslExecArgs,
  withWslEnv, wslDistroFromUncPath, projectJoin,
} = require('./shell-profiles');
const { startScheduler } = require('./schedule-runner');
const { encodeProjectPath } = require('./encode-project-path');



// --- Auto-updater (only in packaged builds) ---
let autoUpdater = null;
if (app.isPackaged || process.env.FORCE_UPDATER) {
  autoUpdater = require('electron-updater').autoUpdater;
  autoUpdater.logger = log;
  autoUpdater.autoDownload = false;
  if (!app.isPackaged) autoUpdater.forceDevUpdateConfig = true;

  function sendUpdaterEvent(type, data) {
    log.info(`[updater] ${type}`, data || '');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater-event', type, data);
    }
  }
  autoUpdater.on('checking-for-update', () => sendUpdaterEvent('checking'));
  autoUpdater.on('update-available', (info) => sendUpdaterEvent('update-available', info));
  autoUpdater.on('update-not-available', (info) => sendUpdaterEvent('update-not-available', info));
  autoUpdater.on('download-progress', (progress) => sendUpdaterEvent('download-progress', progress));
  autoUpdater.on('update-downloaded', (info) => sendUpdaterEvent('update-downloaded', info));
  autoUpdater.on('error', (err) => {
    log.error('[updater] Error:', err?.message || String(err));
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater-event', 'error', { message: err?.message || String(err) });
    }
  });
}
const {
  getMeta, getAllMeta, toggleStar, setName, setArchived, deleteSessionMeta,
  isCachePopulated, getAllCached, getCachedByFolder, getCachedFolder, getCachedSession, upsertCachedSessions,
  deleteCachedSession, deleteCachedFolder,
  getFolderMeta, getAllFolderMeta, setFolderMeta,
  getProjectGitCache, setProjectGitCache, getAllProjectGitCounts,
  upsertSearchEntries, updateSearchTitle, deleteSearchSession, deleteSearchFolder, deleteSearchType,
  searchByType, isSearchIndexPopulated, searchFtsRecreated,
  getSetting, setSetting, deleteSetting,
  getStoredAvatar, setStoredAvatar,
  closeDb,
} = require('./db');

const DEFAULT_CLAUDE_DIR = path.join(os.homedir(), '.claude');
const CLAUDE_DIR = DEFAULT_CLAUDE_DIR;
const STATS_CACHE_PATH = path.join(CLAUDE_DIR, 'stats-cache.json');
const MAX_BUFFER_SIZE = 256 * 1024;

// --- Multi-account helpers ---

const DEFAULT_ACCOUNT = { id: 'default', name: 'Default', configDir: DEFAULT_CLAUDE_DIR };

function getAccounts() {
  const stored = getSetting('accounts');
  if (!Array.isArray(stored) || stored.length === 0) return [DEFAULT_ACCOUNT];
  // Always ensure default account is present
  if (!stored.find(a => a.id === 'default')) return [DEFAULT_ACCOUNT, ...stored];
  return stored;
}

function getActiveAccount() {
  const global = getSetting('global') || {};
  const activeId = global.activeAccountId || 'default';
  return getAccounts().find(a => a.id === activeId) || DEFAULT_ACCOUNT;
}

function getProjectsDir(account) {
  return path.join(account.configDir, 'projects');
}

// Convenience: current active projects dir
function activeProjectsDir() {
  return getProjectsDir(getActiveAccount());
}

function activeConfigDir() {
  return getActiveAccount().configDir;
}

// Plans live next to the sessions they came from, so they follow the account
// rather than the Windows home.
function activePlansDir() {
  return path.join(activeConfigDir(), 'plans');
}

// --- WSL-backed accounts ---
// An account carrying `wslDistro` points at a Claude home living inside that
// distribution. Its project paths stay in POSIX form (that is what Claude wrote
// into the .jsonl files, and what the project folder name encodes from), so
// every Windows fs call goes through hostPath() and every command that has to
// run *in* the project goes through projectExecFile() — where its git, docker
// and toolchain actually are. On accounts without the field both are identity.

function accountWslDistro(account) {
  return (account && account.wslDistro) || null;
}

function activeWslDistro() {
  return accountWslDistro(getActiveAccount());
}

// Translate a canonical project path into one a Windows fs call can open.
// Identity on any account without a distribution, and on paths that are
// already Windows-shaped — so it is safe to wrap every fs call with it.
function accountHostPath(account, p) {
  if (!accountWslDistro(account) || !isPosixAbsolutePath(p)) return p;
  return wslToWindowsPath(p, account.wslDistro, account.wslUncPrefix);
}

// Request-scoped: the account is read per call, which is right for anything
// driven by the UI. Work that outlives the current selection — a running
// session pushing diffs at us — must bind accountHostPath to its own account
// instead, or an account switch would retarget it mid-session.
function hostPath(p) {
  return accountHostPath(getActiveAccount(), p);
}

// A Windows folder picker returns \\wsl.localhost\<distro>\… for a directory
// inside a distribution. Claude records the POSIX path and the project folder
// name is encoded from it, so that is the form the app stores.
function canonicalProjectPath(p) {
  return wslDistroFromUncPath(p) ? windowsToWslPath(p) : p;
}

// Run argv in `cwd`. For a WSL account this re-targets the call into the
// distribution instead of running it on the Windows side over the 9p share.
// `cwd` and any caller-supplied `env` are dropped when redirecting: both hold
// Windows-side values that mean nothing inside the distribution, which resolves
// the working directory via --cd and the command via the distro's own PATH.
// Returns [file, args, options] for execFile/execFileSync.
function projectExecFile(argv, cwd, options = {}) {
  const distro = activeWslDistro();
  if (!distro || !isPosixAbsolutePath(cwd)) {
    return [argv[0], argv.slice(1), { ...options, cwd }];
  }
  const { cwd: _cwd, env: _env, ...rest } = options;
  return ['wsl.exe', wslExecArgs(distro, cwd, argv), rest];
}

// Env additions a `claude` child needs to run as the *active* account rather
// than whatever ~/.claude happens to hold. Without this every headless CLI
// call authenticates as the default account, which fails outright once that
// one is signed out.
//
// WSL accounts are excluded on purpose, matching the PTY spawn: their
// configDir is the Windows view of a home that is already the default inside
// the distribution, so exporting it points the CLI at an unresolvable path.
function activeAccountClaudeEnv() {
  const account = getActiveAccount();
  if (accountWslDistro(account) || account.configDir === DEFAULT_CLAUDE_DIR) return {};
  return { CLAUDE_CONFIG_DIR: account.configDir };
}

// Build stats in the same format as stats-cache.json using Switchboard's own DB.
// This ensures all accounts see charts even before running `claude /stats`.
function computeStatsFromDb(accountId) {
  const sessions = getAllCached(accountId);
  const dailyMap = {};
  let totalMessages = 0;
  for (const s of sessions) {
    const date = (s.modified || s.created || '').slice(0, 10);
    if (!date || date < '2020-01-01') continue;
    if (!dailyMap[date]) dailyMap[date] = { date, messageCount: 0, toolCallCount: 0 };
    const mc = s.messageCount || 0;
    dailyMap[date].messageCount += mc;
    totalMessages += mc;
  }
  const dailyActivity = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));
  return {
    dailyActivity,
    dailyModelTokens: [],
    totalSessions: sessions.length,
    totalMessages,
    modelUsage: {},
    lastComputedDate: new Date().toISOString().slice(0, 10),
  };
}

// Active PTY sessions
const activeSessions = new Map();
let mainWindow = null;

// --- Session status ---
// Fed by Claude Code hooks (hook-server.js) and, only for sessions where no
// hook ever arrives, by the legacy OSC inference below. This replaces the
// `cli-busy-state` boolean: 'requires_action' is a third state that a boolean
// could not express, and the old channel's busy=false was ambiguous between
// "finished a turn" and "waiting for you".
const sessionStatus = new SessionStatusTracker({
  onChange: (sessionId, snapshot) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('session-status', sessionId, snapshot);
  },
});

// Started on the first session that needs it rather than at app ready: a user
// who never opens a session never opens a socket.
function hookServer() {
  return startHookServer({ log, onEvent: payload => sessionStatus.apply(payload) });
}

// --- SDK-backed sessions ---
// The same conversation as a PTY session, carried as structured messages
// instead of a rendered byte stream. Everything below routes by which map the
// id is in, so a session's transport stays an implementation detail of
// open-terminal and nothing downstream has to care.
function startSdkSessionFor(sessionId, projectPath, isNew, sessionOptions) {
  return sdkSession.startSdkSession(sessionId, {
    projectPath,
    isNew,
    forkFrom: sessionOptions?.forkFrom || null,
    permissionMode: sessionOptions?.dangerouslySkipPermissions
      ? 'bypassPermissions'
      : (sessionOptions?.permissionMode || undefined),
    model: sessionOptions?.model || undefined,
    // The same account resolution every other spawn path uses, so an SDK
    // session writes its transcript into the folder this account's cache
    // watches rather than the default home.
    env: activeAccountClaudeEnv(),

    // Lifecycle events arrive as callbacks here rather than over the HTTP
    // endpoint a PTY session needs, but they are the same payloads feeding the
    // same state machine — see session-status.js.
    onHook: (id, input) => sessionStatus.apply({ ...input, session_id: id }),

    // Only consulted when onHook is absent; kept wired so a future caller that
    // opts out of hooks still reports something.
    onState: (id, state) => {
      if (state === 'exited') sessionStatus.remove(id);
    },

    onSessionId: (oldId, newId) => {
      sessionStatus.rekey(oldId, newId);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('session-forked', oldId, newId);
      }
    },

    onMessage: (id, message) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('sdk-message', id, message);
      }
    },

    onStderr: (id, data) => log.debug(`[sdk] session=${id} stderr: ${String(data).trim().slice(0, 300)}`),
  });
}

// --- Single-instance: parse --project <path> from argv ---
function parseProjectArg(argv) {
  const idx = argv.indexOf('--project');
  if (idx !== -1 && argv[idx + 1]) return argv[idx + 1];
  return null;
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    const projectPath = parseProjectArg(argv);
    if (projectPath) mainWindow.webContents.send('launch-project-session', projectPath);
  });
}

// --- URL scheme IPC for external launchers ---
// macOS routes wootonpad:// URLs to the running app via Apple Events — no
// server, no polling, zero overhead. The OS resolves the handler from its
// Launch Services registry and delivers the URL whether the app is open or not.
//
// New session:      open wootonpad://{dir}
// Continue latest:  open wootonpad://+{dir}
//
// Events may arrive before the window is ready — queue them and flush after
// did-finish-load.
const pendingOpenPaths = [];

// In dev, Electron is the "default app" so we pass the script path explicitly.
if (process.defaultApp && process.argv.length >= 2) {
  app.setAsDefaultProtocolClient('wootonpad', process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient('wootonpad');
}

function dispatchProjectOpen(filePath, continueSession) {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    mainWindow.webContents.send('launch-project-session', filePath, continueSession);
  } else {
    pendingOpenPaths.push({ filePath, continueSession });
  }
}

app.on('open-url', (event, url) => {
  event.preventDefault();
  // wootonpad://+/path/to/project  →  continue last session
  // wootonpad:///path/to/project   →  new session
  const continueSession = url.startsWith('wootonpad://+');
  const prefix = continueSession ? 'wootonpad://+' : 'wootonpad://';
  const filePath = decodeURIComponent(url.slice(prefix.length));
  if (filePath) dispatchProjectOpen(filePath, continueSession);
});

function createWindow() {
  // Restore saved window bounds
  const savedBounds = getSetting('global')?.windowBounds;
  let bounds = { width: 1400, height: 900 };

  let restorePosition = null;
  if (savedBounds && savedBounds.width && savedBounds.height) {
    bounds.width = savedBounds.width;
    bounds.height = savedBounds.height;

    // Only restore position if it's on a visible display
    if (savedBounds.x != null && savedBounds.y != null) {
      const displays = screen.getAllDisplays();
      const onScreen = displays.some(d => {
        const b = d.bounds;
        return savedBounds.x >= b.x - 100 && savedBounds.x < b.x + b.width &&
               savedBounds.y >= b.y - 100 && savedBounds.y < b.y + b.height;
      });
      if (onScreen) {
        restorePosition = { x: savedBounds.x, y: savedBounds.y };
      }
    }
  }

  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 800,
    minHeight: 500,
    title: 'Wooton Pad',
    icon: path.join(__dirname, 'build', 'icon.png'),
    // macOS: drop the title bar and let the top nav run to the window's edge,
    // keeping the traffic lights inset over it. css/shell.css reserves room
    // for them and marks the bar draggable, which the OS chrome used to do.
    // Left alone elsewhere: Windows and Linux have no equivalent inset, and a
    // frameless window there means reimplementing minimise/maximise/close.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Set position after creation to prevent macOS from clamping size
  if (restorePosition) {
    mainWindow.setBounds({ ...restorePosition, width: bounds.width, height: bounds.height });
  }

  // macOS hides the traffic lights in full screen, so the gap css/shell.css
  // reserves for them has to go with them.
  const sendFullscreen = (on) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window-fullscreen', on);
    }
  };
  mainWindow.on('enter-full-screen', () => sendFullscreen(true));
  mainWindow.on('leave-full-screen', () => sendFullscreen(false));

  mainWindow.loadFile(path.join(__dirname, 'public', 'index.html'));

  // Open external links in the system browser instead of a child BrowserWindow
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    }
  });
  // Override window.open so xterm WebLinksAddon's default handler (which does
  // window.open() then sets location.href) routes through our IPC instead of
  // creating a child BrowserWindow.
  mainWindow.webContents.on('did-finish-load', () => {
    const startupProject = parseProjectArg(process.argv);
    if (startupProject) mainWindow.webContents.send('launch-project-session', startupProject);
    for (const { filePath, continueSession } of pendingOpenPaths.splice(0)) {
      mainWindow.webContents.send('launch-project-session', filePath, continueSession);
    }

    mainWindow.webContents.executeJavaScript(`
      window.open = function(url) {
        if (url && /^https?:\\/\\//i.test(url)) { window.api.openExternal(url); return null; }
        const proxy = {};
        Object.defineProperty(proxy, 'location', { get() {
          const loc = {};
          Object.defineProperty(loc, 'href', {
            set(u) { if (/^https?:\\/\\//i.test(u)) window.api.openExternal(u); }
          });
          return loc;
        }});
        return proxy;
      };
      void 0;
    `);
  });

  // Prevent Cmd+R / Ctrl+Shift+R from reloading the page (Chromium built-in).
  // Ctrl+R alone on macOS is NOT a reload shortcut and must pass through to xterm
  // for reverse-i-search.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    if (key === 'r' && input.meta) event.preventDefault();
    if (key === 'r' && input.control && input.shift) event.preventDefault();
  });

  // Save window bounds on move/resize (debounced)
  let boundsTimer = null;
  const saveBounds = () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
      const b = mainWindow.getBounds();
      const global = getSetting('global') || {};
      global.windowBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
      setSetting('global', global);
    }, 500);
  };
  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);

  // Also save immediately before close (debounce may not have flushed)
  mainWindow.on('close', () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    if (!mainWindow.isMinimized()) {
      const b = mainWindow.getBounds();
      const global = getSetting('global') || {};
      global.windowBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
      setSetting('global', global);
    }
  });

  mainWindow.on('closed', () => {
    // On macOS the app stays alive in the dock after the last window closes.
    // Kill all running PTY processes so orphaned `claude` processes don't
    // accumulate in the background with no way for the user to interact.
    for (const [id, session] of activeSessions) {
      if (!session.exited) {
        try { session.pty.kill(); } catch {}
      }
      activeSessions.delete(id);
    }
    mainWindow = null;
  });
}

function buildMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- Session cache helpers ---

const { deriveProjectPath } = require('./derive-project-path');

// Session cache → session-cache.js
const sessionCache = require('./session-cache');

function initSessionCache() {
  const account = getActiveAccount();
  sessionCache.init({
    PROJECTS_DIR: getProjectsDir(account),
    accountId: account.id,
    activeSessions,
    getMainWindow: () => mainWindow,
    log,
    db: {
      deleteCachedFolder, getCachedByFolder, upsertCachedSessions, deleteCachedSession,
      deleteSearchFolder, deleteSearchSession, upsertSearchEntries,
      setFolderMeta, getAllFolderMeta, getAllMeta, getAllCached, getSetting, getMeta, setName, getAllProjectGitCounts,
    },
  });
}

initSessionCache();
const { readSessionFile, readFolderFromFilesystem, refreshFolder, populateCacheFromFilesystem,
        buildProjectsFromCache, notifyRendererProjectsChanged, sendStatus, populateCacheViaWorker } = sessionCache;


// --- IPC: browse-folder ---
ipcMain.handle('browse-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Select Project Folder',
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// --- IPC: add-project ---
ipcMain.handle('add-project', (_event, rawProjectPath) => {
  const projectPath = canonicalProjectPath(rawProjectPath);
  // A folder picked inside a distribution only belongs to that distribution's
  // account: its Claude home is the one that would record the sessions. Say so,
  // rather than failing later on a path this account cannot resolve.
  const pickedDistro = wslDistroFromUncPath(rawProjectPath);
  const account = getActiveAccount();
  if (pickedDistro && accountWslDistro(account) !== pickedDistro) {
    return { error: `That folder is inside WSL (${pickedDistro}). Switch to the "${pickedDistro}" account to add it.` };
  }
  if (!pickedDistro && isPosixAbsolutePath(projectPath) && !accountWslDistro(account) && isWindows) {
    return { error: `Cannot add "${projectPath}" from a Windows account — switch to the WSL account that owns it.` };
  }
  try {
    // Validate the path exists and is a directory
    const stat = fs.statSync(hostPath(projectPath));
    if (!stat.isDirectory()) return { error: 'Path is not a directory' };

    // Unhide if previously hidden
    const global = getSetting('global') || {};
    if (global.hiddenProjects && global.hiddenProjects.includes(projectPath)) {
      global.hiddenProjects = global.hiddenProjects.filter(p => p !== projectPath);
      setSetting('global', global);
    }

    // Create the corresponding folder in ~/.claude/projects/ so it persists
    const folder = encodeProjectPath(projectPath);
    const folderPath = path.join(activeProjectsDir(), folder);
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
    }

    // Seed a minimal .jsonl so deriveProjectPath can read the cwd
    if (!fs.readdirSync(folderPath).some(f => f.endsWith('.jsonl'))) {
      const seedId = require('crypto').randomUUID();
      const seedFile = path.join(folderPath, seedId + '.jsonl');
      const now = new Date().toISOString();
      const line = JSON.stringify({ type: 'user', cwd: projectPath, sessionId: seedId, uuid: require('crypto').randomUUID(), timestamp: now, message: { role: 'user', content: 'New project' } });
      fs.writeFileSync(seedFile, line + '\n');
    }

    // Immediately index the new folder so it's in cache before frontend renders
    refreshFolder(folder);
    notifyRendererProjectsChanged();
    // Kick off du -sk once on add; subsequent refreshes use the long random TTL
    cacheProjectSize(projectPath);

    return { ok: true, folder, projectPath };
  } catch (err) {
    return { error: err.message };
  }
});

// --- IPC: remove-project ---
ipcMain.handle('remove-project', (_event, projectPath) => {
  try {
    // Add to hidden projects list
    const global = getSetting('global') || {};
    const hidden = global.hiddenProjects || [];
    if (!hidden.includes(projectPath)) hidden.push(projectPath);
    global.hiddenProjects = hidden;
    setSetting('global', global);

    // Clean up DB cache and search index for this folder
    const folder = encodeProjectPath(projectPath);
    deleteCachedFolder(folder);
    deleteSearchFolder(folder);
    deleteSetting('project:' + projectPath);

    notifyRendererProjectsChanged();
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

// --- IPC: get-project-info (git branch/diff + docker compose, cached with jittered TTL) ---
const PROJECT_INFO_TTL_MS = 60 * 1000;
// du -sk is expensive; cache with a random long TTL so projects don't all expire at once
const SIZE_TTL_OPTIONS_MS = [3 * 3600000, 20 * 3600000, 24 * 3600000];

const DOCKER_PATH = (process.env.PATH || '') + ':/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin';

// ±30 s jitter so projects cached at the same time don't all expire simultaneously
function infoJitter() {
  return PROJECT_INFO_TTL_MS + (Math.random() * 60000 - 30000);
}

function fetchProjectInfo(projectPath) {
  const { execFile } = require('child_process');
  // argv form: for a WSL account these run inside the distribution, where the
  // project's git and docker live, instead of over the 9p share.
  const run = (argv, opts = {}) => new Promise((resolve) => {
    const [file, args, options] = projectExecFile(argv, projectPath, { encoding: 'utf8', timeout: 10000, ...opts });
    execFile(file, args, options, (err, stdout) => {
      resolve(err ? null : (stdout || '').trim());
    });
  });
  const data = { branch: null, added: null, deleted: null, containers: null };
  return Promise.all([
    run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 5000 }),
    run(['git', 'diff', '--shortstat', 'HEAD'], { timeout: 5000 }),
    run(['docker', 'compose', 'ps', '--format', 'json'], {
      timeout: 8000,
      env: { ...process.env, PATH: DOCKER_PATH },
    }),
  ]).then(([branch, stat, dockerOut]) => {
    if (branch) data.branch = branch;
    if (stat) {
      const addM = stat.match(/(\d+) insertion/);
      const delM = stat.match(/(\d+) deletion/);
      if (addM) data.added = parseInt(addM[1]);
      if (delM) data.deleted = parseInt(delM[1]);
    }
    if (dockerOut) {
      data.containers = dockerOut.split('\n').filter(Boolean).map(line => {
        try {
          const c = JSON.parse(line);
          return { name: c.Service || c.Name, state: (c.State || '').toLowerCase(), status: c.Status || '' };
        } catch { return null; }
      }).filter(Boolean);
    }
    return data;
  });
}

// du -sk: only run on add-project and when the long-TTL size cache expires
function fetchProjectSize(projectPath) {
  const { execFile } = require('child_process');
  return new Promise((resolve) => {
    const [file, args, options] = projectExecFile(['du', '-sk', '.'], projectPath, { encoding: 'utf8', timeout: 15000 });
    execFile(file, args, options, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const kb = parseInt((stdout || '').split(/\s+/)[0]);
      resolve(isNaN(kb) ? null : Math.round(kb / 1024));
    });
  });
}

function cacheProjectSize(projectPath) {
  fetchProjectSize(projectPath).then(sizeMb => {
    if (sizeMb === null) return;
    const ttl = SIZE_TTL_OPTIONS_MS[Math.floor(Math.random() * SIZE_TTL_OPTIONS_MS.length)];
    setSetting('project-size:' + projectPath, { sizeMb, fetchedAt: Date.now(), ttl });
  }).catch(() => {});
}

ipcMain.handle('get-project-info', (_event, projectPath) => {
  if (!projectPath || !fs.existsSync(hostPath(projectPath))) return null;
  const cacheKey = 'project-info:' + projectPath;
  const cached = getSetting(cacheKey);
  const cachedSize = getSetting('project-size:' + projectPath);

  const gitFresh = cached && cached.fetchedAt && (Date.now() - cached.fetchedAt) < (cached.ttl || PROJECT_INFO_TTL_MS);
  const sizeFresh = cachedSize && cachedSize.fetchedAt && (Date.now() - cachedSize.fetchedAt) < (cachedSize.ttl || SIZE_TTL_OPTIONS_MS[0]);
  const sizeMb = cachedSize?.sizeMb ?? null;

  if (!gitFresh) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('project-info-loading', projectPath);
    }
    fetchProjectInfo(projectPath).then(data => {
      const merged = sizeMb !== null ? { ...data, sizeMb } : data;
      setSetting(cacheKey, { data: merged, fetchedAt: Date.now(), ttl: infoJitter() });
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('project-info-updated', projectPath, merged);
      }
    }).catch(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('project-info-updated', projectPath, null);
      }
    });
  }

  // Refresh size in background if its long-TTL has expired
  if (!sizeFresh) cacheProjectSize(projectPath);

  const base = cached?.data ?? null;
  return base && sizeMb !== null ? { ...base, sizeMb } : base;
});

// --- IPC: get-project-detail (full git log + docker details, no cache) ---
ipcMain.handle('get-project-detail', (_event, projectPath) => {
  if (!projectPath || !fs.existsSync(hostPath(projectPath))) return null;
  const { execFileSync } = require('child_process');
  // argv form so the project path never goes through shell quoting, and so a
  // WSL account runs these where the repository actually lives.
  const sh = (argv, opts = {}) => {
    const [file, args, options] = projectExecFile(argv, projectPath, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...opts,
    });
    return execFileSync(file, args, options).trim();
  };
  const detail = { branch: null, upstream: null, remoteUrl: null, tags: [], worktreePaths: [], commits: [], unpushedCommits: [], changedFiles: [], totalAdded: 0, totalDeleted: 0, containers: [], readmePath: null };
  for (const name of ['README.md', 'readme.md', 'Readme.md', 'README.rst', 'README']) {
    const fp = projectJoin(projectPath, name);
    if (fs.existsSync(hostPath(fp))) { detail.readmePath = fp; break; }
  }
  try {
    detail.branch = sh(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 5000 });
    const log = sh(['git', 'log', '--format=%h\x1f%s\x1f%an\x1f%ar', '-15'], { timeout: 5000 });
    if (log) {
      detail.commits = log.split('\n').filter(Boolean).map(line => {
        const [hash, message, author, date] = line.split('\x1f');
        return { hash, message, author, date };
      });
    }
    try {
      const unpushed = sh(['git', 'log', '--format=%h\x1f%s\x1f%an\x1f%ar', '@{u}..HEAD'], { timeout: 5000 });
      if (unpushed) {
        detail.unpushedCommits = unpushed.split('\n').filter(Boolean).map(line => {
          const [hash, message, author, date] = line.split('\x1f');
          return { hash, message, author, date };
        });
      }
      const upstream = sh(['git', 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { timeout: 3000 });
      detail.upstream = upstream;
      const remoteName = upstream.split('/')[0];
      try {
        detail.remoteUrl = sh(['git', 'remote', 'get-url', remoteName], { timeout: 3000 });
      } catch {}
    } catch {} // no upstream set — just leave empty
    // Always try origin as fallback even without upstream
    if (!detail.remoteUrl) {
      try {
        detail.remoteUrl = sh(['git', 'remote', 'get-url', 'origin'], { timeout: 3000 });
      } catch {}
    }
    try {
      const tagsRaw = sh(['git', 'tag', '--sort=-version:refname'], { timeout: 3000 });
      detail.tags = tagsRaw ? tagsRaw.split('\n').filter(Boolean).slice(0, 20) : [];
    } catch { detail.tags = []; }
    try {
      const wtRaw = sh(['git', 'worktree', 'list', '--porcelain'], { timeout: 3000 });
      // Each worktree block is separated by blank line; first entry is the main worktree
      detail.worktreePaths = wtRaw.split('\n\n').slice(1).map(block => {
        const match = block.match(/^worktree (.+)/m);
        return match ? match[1].trim() : null;
      }).filter(Boolean);
    } catch { detail.worktreePaths = []; }
    const numstat = sh(['git', 'diff', '--numstat', 'HEAD'], { timeout: 5000 });
    if (numstat) {
      detail.changedFiles = numstat.split('\n').filter(Boolean).map(line => {
        const [added, deleted, file] = line.split('\t');
        const a = parseInt(added) || 0;
        const d = parseInt(deleted) || 0;
        detail.totalAdded += a;
        detail.totalDeleted += d;
        return { file, added: a, deleted: d };
      }).sort((a, b) => (b.added + b.deleted) - (a.added + a.deleted));
    }
  } catch {}
  try {
    const raw = sh(['docker', 'compose', 'ps', '--format', 'json'], {
      timeout: 8000,
      env: { ...process.env, PATH: DOCKER_PATH },
    });
    if (raw) {
      detail.containers = raw.split('\n').filter(Boolean).map(line => {
        try {
          const c = JSON.parse(line);
          const ports = (c.Publishers || []).map(p => `${p.PublishedPort}→${p.TargetPort}/${p.Protocol}`).filter(p => !p.startsWith('0→')).join(', ');
          return { name: c.Service || c.Name, state: (c.State || '').toLowerCase(), status: c.Status || '', ports };
        } catch { return null; }
      }).filter(Boolean);
    }
  } catch {}
  try {
    setProjectGitCache(projectPath, detail);
    notifyRendererProjectsChanged();
  } catch {}
  return detail;
});

ipcMain.handle('get-project-git-cache', (_event, projectPath) => {
  try { return getProjectGitCache(projectPath); } catch { return null; }
});

ipcMain.handle('open-external', (_event, url) => {
  log.info('[open-external IPC]', url);
  if (/^https?:\/\//i.test(url)) return shell.openExternal(url);
});

// --- IPC: MCP bridge ---
ipcMain.on('mcp-diff-response', (_event, sessionId, diffId, action, editedContent) => {
  resolvePendingDiff(sessionId, diffId, action, editedContent);
});

// --- IPC: git operations ---
// Every git call goes through projectGit so it runs where the repository is —
// inside the distribution for a WSL-backed project, on Windows otherwise — and
// so branch names and messages travel as argv rather than in a shell string.
function projectGit(projectPath, argv, opts = {}) {
  const { execFileSync } = require('child_process');
  const [file, args, options] = projectExecFile(['git', ...argv], projectPath, {
    encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'], ...opts,
  });
  return execFileSync(file, args, options);
}

ipcMain.handle('git-branches', (_event, projectPath) => {
  try {
    const current = projectGit(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 5000 }).trim();
    const all = projectGit(projectPath, ['branch'], { timeout: 5000 }).trim();
    const branches = all.split('\n').map(b => b.replace(/^[*+]\s*/, '').trim()).filter(Boolean);
    let remotes = [];
    try {
      const raw = projectGit(projectPath, ['branch', '-r'], { timeout: 5000 }).trim();
      remotes = raw.split('\n').map(b => b.trim().replace(/^origin\//, '')).filter(b => b && b !== 'HEAD' && !b.includes('->') && !branches.includes(b));
    } catch {}
    return { ok: true, current, branches, remotes };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('git-checkout', (_event, projectPath, branch) => {
  try {
    projectGit(projectPath, ['checkout', branch]);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.stderr || e.message }; }
});

ipcMain.handle('git-fetch', (_event, projectPath) => {
  try {
    return { ok: true, output: projectGit(projectPath, ['fetch', '--prune'], { timeout: 30000 }) };
  } catch (e) { return { ok: false, error: e.stderr || e.message }; }
});

ipcMain.handle('git-pull', (_event, projectPath) => {
  try {
    return { ok: true, output: projectGit(projectPath, ['pull'], { timeout: 30000 }) };
  } catch (e) { return { ok: false, error: e.stderr || e.message }; }
});

ipcMain.handle('git-commit', (_event, projectPath, message) => {
  try {
    projectGit(projectPath, ['add', '-A']);
    projectGit(projectPath, ['commit', '-m', message]);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.stderr || e.message }; }
});

ipcMain.handle('git-push', (_event, projectPath) => {
  try {
    return { ok: true, output: projectGit(projectPath, ['push'], { timeout: 30000 }) };
  } catch (e) {
    // try push with set-upstream
    try {
      const branch = projectGit(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD'], {
        timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      const out2 = projectGit(projectPath, ['push', '--set-upstream', 'origin', branch], { timeout: 30000 });
      return { ok: true, output: out2 };
    } catch (e2) { return { ok: false, error: e2.stderr || e2.message }; }
  }
});

ipcMain.handle('git-create-branch', (_event, projectPath, branchName, checkout) => {
  try {
    projectGit(projectPath, checkout ? ['checkout', '-b', branchName] : ['branch', branchName]);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.stderr || e.message }; }
});

// --- IPC: project avatar (GitLab) ---
ipcMain.handle('get-project-avatar', (_event, projectPath) => {
  const result = getStoredAvatar(projectPath);
  if (!result) return null;
  return `data:${result.mimeType};base64,${result.avatarData.toString('base64')}`;
});

ipcMain.handle('fetch-gitlab-avatar', async (_event, projectPath, remoteUrl) => {
  let base = remoteUrl.trim();
  const ssh = base.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  let host, projectApiPath;
  if (ssh) {
    host = `https://${ssh[1]}`;
    projectApiPath = ssh[2];
  } else {
    base = base.replace(/\.git$/, '');
    const m = base.match(/^(https?:\/\/[^/]+)\/(.+)$/);
    if (!m) throw new Error('Cannot parse remote URL');
    host = m[1];
    projectApiPath = m[2];
  }
  const globalSettings = getSetting('global') || {};
  const token = globalSettings.gitlabToken;
  const headers = token ? { 'PRIVATE-TOKEN': token } : {};
  const apiUrl = `${host}/api/v4/projects/${encodeURIComponent(projectApiPath)}`;
  const resp = await fetch(apiUrl, { headers });
  if (!resp.ok) throw new Error(`GitLab API error: ${resp.status}`);
  const data = await resp.json();
  if (!data.avatar_url) {
    setStoredAvatar(projectPath, null, null);
    return null;
  }
  // Use the API avatar endpoint (authenticated) instead of downloading avatar_url directly
  // (avatar_url points to CDN/storage that may reject PRIVATE-TOKEN header).
  const avatarApiUrl = `${host}/api/v4/projects/${data.id}/avatar`;
  const imgResp = await fetch(avatarApiUrl, { headers });
  if (!imgResp.ok) throw new Error(`Avatar download error: ${imgResp.status}`);
  const contentType = imgResp.headers.get('content-type') || 'image/png';
  const buffer = Buffer.from(await imgResp.arrayBuffer());
  setStoredAvatar(projectPath, buffer, contentType);
  return `data:${contentType};base64,${buffer.toString('base64')}`;
});

ipcMain.handle('git-generate-commit-msg', async (_event, projectPath, style = 'short') => {
  const { spawn } = require('child_process');
  try {
    const diff = projectGit(projectPath, ['diff', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] });
    if (!diff.trim()) return { ok: false, error: 'No changes to describe' };
    const globalSettings = getSetting('global') || {};
    const baseInstruction = globalSettings.commitMessagePrompt || COMMIT_MSG_PROMPT_DEFAULT;
    const styleSuffix = style === 'descriptive'
      ? ' Write a short title line followed by a blank line and a concise bullet list of key changes (3-5 bullets max). Use conventional commit format.'
      : ' Write a single short sentence (max 72 chars). Use conventional commit format (feat/fix/refactor/docs/chore).';
    const prompt = `${baseInstruction}${styleSuffix}\n\nOutput ONLY the commit message, no explanation:\n\n${diff.slice(0, 8000)}`;
    const msg = await new Promise((resolve, reject) => {
      // The claude binary lives wherever the project does — inside the
      // distribution for a WSL-backed one, so this call is routed there too.
      // Absolute path, not a bare name: see resolveClaudeBinary — a packaged
      // macOS app has no shell PATH, so `claude` alone is ENOENT there. A WSL
      // account keeps the bare name: the binary that matters lives inside the
      // distribution, and a host path would be meaningless there.
      const claudeBin = activeWslDistro() ? 'claude' : resolveClaudeBinary();
      const [file, args, options] = projectExecFile(
        [claudeBin, '-p', prompt, '--no-session-persistence'], projectPath,
        { env: { ...process.env, PATH: claudeChildPath(), ...activeAccountClaudeEnv() } }
      );
      const child = spawn(file, args, options);
      let stdout = '', stderr = '';
      child.stdout.on('data', d => { stdout += d; });
      child.stderr.on('data', d => { stderr += d; });
      const timer = setTimeout(() => { child.kill(); reject(new Error('Timed out after 60s')); }, 60000);
      child.on('close', code => {
        clearTimeout(timer);
        if (code !== 0 && !stdout.trim()) reject(new Error(stderr.trim() || `claude exited with code ${code}`));
        else resolve(stdout.trim());
      });
      child.on('error', err => { clearTimeout(timer); reject(err); });
    });
    if (!msg) return { ok: false, error: 'No output from claude' };
    const clean = msg.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim();
    return { ok: true, message: clean };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── Board summaries ───────────────────────────────────────────────────────
// One headless `claude` call for the whole board rather than one per session:
// N sessions would be N cold CLI starts, N authentications and N timeouts to
// wait out, and the model reads the transcripts faster together than apart.
// Same plumbing as git-generate-commit-msg above — resolved binary, child PATH,
// active-account env, hard timeout, { ok } result.
const BOARD_SUMMARY_MAX_SESSIONS = 12;
const BOARD_SUMMARY_MAX_PROMPT = 8000;      // the budget the commit diff gets
const BOARD_SUMMARY_MAX_PER_SESSION = 1200;

// The last few assistant turns of a transcript. "What did this session just
// finish" needs the end of the conversation and nothing else, and the whole
// file would blow the prompt budget on the first session.
function sessionTranscriptTail(sessionId, limit = BOARD_SUMMARY_MAX_PER_SESSION) {
  const folder = getCachedFolder(sessionId);
  if (!folder) return '';
  let content;
  try {
    content = fs.readFileSync(path.join(activeProjectsDir(), folder, sessionId + '.jsonl'), 'utf-8');
  } catch { return ''; }
  const lines = content.split('\n');
  const turns = [];
  for (let i = lines.length - 1; i >= 0 && turns.length < 3; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== 'assistant' && !(entry.type === 'message' && entry.role === 'assistant')) continue;
    const blocks = entry.message?.content;
    // Text blocks only: a tool_use block is an argument dump, and its result
    // arrives as a separate user entry that says nothing about intent.
    const text = typeof blocks === 'string' ? blocks
      : (Array.isArray(blocks)
        ? blocks.filter(b => b?.type === 'text').map(b => b.text || '').join('\n')
        : (typeof entry.message === 'string' ? entry.message : ''));
    const trimmed = text.trim();
    if (trimmed) turns.unshift(trimmed);
  }
  // Tail, not head: the closing sentences are the ones that say what landed.
  return turns.join('\n---\n').slice(-limit);
}

// The child of the summarize run currently in flight, so the sidebar's Stop
// button has something to kill. One at a time: the renderer disables Summarize
// while a run is pending, and a second run would only queue behind this one on
// the same account anyway.
let boardSummaryChild = null;
let boardSummaryCancelled = false;

ipcMain.handle('board-summarize-abort', () => {
  if (!boardSummaryChild) return { ok: false, error: 'nothing running' };
  boardSummaryCancelled = true;
  try { boardSummaryChild.kill(); } catch {}
  return { ok: true };
});

ipcMain.handle('board-summarize-sessions', async (_event, sessions, options) => {
  const { spawn } = require('child_process');
  // One session asked for from a session's own menu, rather than the board's
  // whole set: the whole prompt budget goes to it and the answer gets room to
  // name what the last few turns actually did.
  const detail = !!options?.detail;
  const list = (Array.isArray(sessions) ? sessions : []).slice(0, BOARD_SUMMARY_MAX_SESSIONS);
  if (!list.length) return { ok: false, error: 'No sessions on the board to summarize' };
  try {
    let budget = BOARD_SUMMARY_MAX_PROMPT;
    const blocks = [];
    for (const session of list) {
      if (budget <= 0) break;
      // Passed as the limit rather than sliced afterwards: sessionTranscriptTail
      // cuts from the front, and the last thing a session said is the point.
      const perSession = detail ? budget : Math.min(BOARD_SUMMARY_MAX_PER_SESSION, budget);
      const tail = sessionTranscriptTail(session.sessionId, perSession);
      if (!tail) continue;
      budget -= tail.length;
      const title = String(session.title || '').replace(/"/g, "'").slice(0, 120);
      blocks.push(`<session id="${session.sessionId}" title="${title}">\n${tail}\n</session>`);
    }
    if (!blocks.length) return { ok: false, error: 'No readable transcripts for these sessions' };

    const prompt = 'Each <session> below is the tail of a Claude Code transcript.\n'
      + (detail
        ? 'Write 2-3 sentences in past tense describing what the last few turns of that session accomplished. '
        : 'For each one, write 1-2 sentences in past tense saying what that session just finished doing. ')
      + 'Name the concrete files or features the transcript names. Do not mention the transcript, the session id, or yourself.\n'
      // It reads in a sidebar column: left to itself the model writes a
      // paragraph of clause-joined detail that has to be scrolled to finish.
      + (detail
        ? 'Hard limit of 70 words — cut detail rather than run long.\n\n'
        : 'Hard limit of 35 words per summary — cut detail rather than run long.\n\n')
      + 'Reply with ONLY a JSON array, no prose and no code fence, one object per session in the order given:\n'
      + '[{"id": "<the session id exactly as given>", "summary": "<1-2 sentences>"}]\n\n'
      + blocks.join('\n\n');

    // Nothing here is project work, but the CLI still runs somewhere: anchor it
    // to a project on the board so a WSL-backed account resolves inside its own
    // distribution rather than on the Windows side.
    const anchor = list.find(s => s.projectPath)?.projectPath;

    const raw = await new Promise((resolve, reject) => {
      const claudeBin = activeWslDistro() ? 'claude' : resolveClaudeBinary();
      const [file, args, options] = projectExecFile(
        // json envelope, not bare text: it is the only way to report what the
        // summary actually cost. The prose lands in `result`.
        [claudeBin, '-p', prompt, '--no-session-persistence', '--output-format', 'json'], anchor,
        { env: { ...process.env, PATH: claudeChildPath(), ...activeAccountClaudeEnv() } }
      );
      const child = spawn(file, args, options);
      // Published so board-summarize-abort can reach it. Cleared on close, so
      // Stop after the run has finished is a no-op rather than a kill of
      // whatever spawned next.
      boardSummaryChild = child;
      boardSummaryCancelled = false;
      let stdout = '', stderr = '';
      child.stdout.on('data', d => { stdout += d; });
      child.stderr.on('data', d => { stderr += d; });
      // Longer than the commit message's 60s: this prompt carries a dozen
      // transcripts and answers with a dozen summaries.
      const timer = setTimeout(() => { child.kill(); reject(new Error('Timed out after 120s')); }, 120000);
      child.on('close', code => {
        clearTimeout(timer);
        boardSummaryChild = null;
        if (boardSummaryCancelled) reject(Object.assign(new Error('Stopped'), { cancelled: true }));
        else if (code !== 0 && !stdout.trim()) reject(new Error(stderr.trim() || `claude exited with code ${code}`));
        else resolve(stdout.trim());
      });
      child.on('error', err => { clearTimeout(timer); boardSummaryChild = null; reject(err); });
    });

    if (!raw) return { ok: false, error: 'No output from claude' };

    // Unwrap the CLI envelope. If it is not there — an older CLI, or a wrapper
    // that printed something else — fall back to treating stdout as the answer
    // and report no usage rather than failing.
    let body = raw;
    let usage = null;
    try {
      const envelope = JSON.parse(raw);
      if (envelope && typeof envelope.result === 'string') {
        body = envelope.result;
        const u = envelope.usage || {};
        usage = {
          inputTokens: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
          outputTokens: u.output_tokens || 0,
          costUSD: envelope.total_cost_usd || 0,
        };
      }
    } catch {}

    // Models fence JSON even when told not to, and sometimes prefix a sentence.
    const unfenced = body.replace(/^```[a-z]*\n?/i, '').replace(/\n?```\s*$/, '').trim();
    const start = unfenced.indexOf('[');
    const end = unfenced.lastIndexOf(']');
    let parsed;
    try {
      parsed = JSON.parse(start !== -1 && end > start ? unfenced.slice(start, end + 1) : unfenced);
    } catch {
      return { ok: false, error: 'claude did not return JSON' };
    }
    if (!Array.isArray(parsed)) return { ok: false, error: 'claude did not return a JSON array' };
    const summaries = parsed
      .filter(item => item && item.id && typeof item.summary === 'string' && item.summary.trim())
      .map(item => ({ sessionId: String(item.id), summary: item.summary.trim() }));
    if (!summaries.length) return { ok: false, error: 'claude returned no summaries' };
    return { ok: true, summaries, usage };
  } catch (e) { return { ok: false, error: e.message, cancelled: !!e.cancelled }; }
});

ipcMain.handle('delete-worktree', (_event, projectPath, worktreePath) => {
  const { setProjectGitCache } = require('./db');
  let branch = null;
  // `-C <worktree>` is kept, but the whole call is routed through the project so
  // a WSL-backed worktree path stays POSIX and is resolved by the distribution.
  try {
    branch = projectGit(projectPath, ['-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {}
  // Remove the worktree — idempotent: ignore "not a working tree" error
  try {
    projectGit(projectPath, ['worktree', 'remove', worktreePath, '--force']);
  } catch (e) {
    if (!e.message.includes('is not a working tree') && !e.message.includes('not a git')) {
      return { ok: false, error: e.message };
    }
  }
  // Prune stale worktree refs
  try { projectGit(projectPath, ['worktree', 'prune'], { timeout: 5000 }); } catch {}
  // Delete the branch
  if (branch && branch !== 'HEAD' && branch !== 'main' && branch !== 'master') {
    try { projectGit(projectPath, ['branch', '-D', branch], { timeout: 5000 }); } catch {}
  }
  // Clear project git cache for the worktree path so stale data doesn't show
  try { setProjectGitCache(worktreePath, { branch: null, upstream: null, remoteUrl: null, tags: [], commits: [], unpushedCommits: [], changedFiles: [], totalAdded: 0, totalDeleted: 0, containers: [] }); } catch {}
  return { ok: true, branch };
});

ipcMain.handle('get-git-user-info', (_event, projectPath) => {
  try {
    const name = projectGit(projectPath, ['config', 'user.name']).trim();
    const email = projectGit(projectPath, ['config', 'user.email']).trim();
    return { ok: true, name, email };
  } catch { return { ok: false, name: '', email: '' }; }
});

ipcMain.handle('get-file-tree', (_event, projectPath) => {
  const IGNORE = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '__pycache__', '.venv', 'venv', '.DS_Store', 'target', '.cache', 'coverage', '.turbo']);
  function walk(dir, rel, depth) {
    if (depth > 5) return [];
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    return entries
      .filter(e => !IGNORE.has(e.name) && !e.name.startsWith('.'))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .map(e => {
        const relPath = rel ? `${rel}/${e.name}` : e.name;
        const isDir = e.isDirectory();
        return { name: e.name, path: relPath, isDir, children: isDir ? walk(path.join(dir, e.name), relPath, depth + 1) : null };
      });
  }
  // Only the walk root is translated: entry paths below it are built relative
  // with forward slashes, which is what the renderer joins back onto the
  // canonical project path.
  try { return { ok: true, tree: walk(hostPath(projectPath), '', 0) }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('get-file-diff', (_event, projectPath, filePath) => {
  const { execFileSync } = require('child_process');
  let oldContent = '';
  try {
    const [file, args, options] = projectExecFile(['git', 'show', `HEAD:${filePath}`], projectPath, {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    oldContent = execFileSync(file, args, options);
  } catch {}
  try {
    const newContent = fs.readFileSync(hostPath(projectJoin(projectPath, filePath)), 'utf8');
    return { ok: true, oldContent, newContent, filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('read-file-for-panel', async (_event, filePath) => {
  try {
    const content = fs.readFileSync(hostPath(filePath), 'utf8');
    return { ok: true, content };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('save-file-for-panel', async (_event, filePath, content) => {
  try {
    const resolved = path.resolve(hostPath(filePath));
    if (!fs.existsSync(resolved)) return { ok: false, error: 'File does not exist' };
    fs.writeFileSync(resolved, content, 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── File Watching (for viewer panels) ────────────────────────────────
const fileWatchers = new Map(); // filePath → FSWatcher

ipcMain.handle('watch-file', (_event, filePath) => {
  const resolved = path.resolve(hostPath(filePath));
  if (fileWatchers.has(resolved)) return { ok: true };
  try {
    let debounce = null;
    const watcher = fs.watch(resolved, (eventType) => {
      if (eventType !== 'change') return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('file-changed', resolved);
        }
      }, 300);
    });
    fileWatchers.set(resolved, watcher);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('unwatch-file', (_event, filePath) => {
  const resolved = path.resolve(hostPath(filePath));
  const watcher = fileWatchers.get(resolved);
  if (watcher) {
    watcher.close();
    fileWatchers.delete(resolved);
  }
  return { ok: true };
});

ipcMain.handle('get-projects', (_event, showArchived) => {
  try {
    const needsPopulate = !isCachePopulated(getActiveAccount().id) || !isSearchIndexPopulated();

    if (needsPopulate) {
      populateCacheViaWorker();
      return [];
    }

    return buildProjectsFromCache(showArchived);
  } catch (err) {
    console.error('Error listing projects:', err);
    return [];
  }
});

// --- IPC: get-plans ---
ipcMain.handle('get-plans', () => {
  try {
    const plansDir = activePlansDir();
    if (!fs.existsSync(plansDir)) return [];
    const files = fs.readdirSync(plansDir).filter(f => f.endsWith('.md'));
    const plans = [];
    for (const file of files) {
      const filePath = path.join(plansDir, file);
      try {
        const stat = fs.statSync(filePath);
        const content = fs.readFileSync(filePath, 'utf8');
        const firstLine = content.split('\n').find(l => l.trim());
        const title = firstLine && firstLine.startsWith('# ')
          ? firstLine.slice(2).trim()
          : file.replace(/\.md$/, '');
        plans.push({ filename: file, title, modified: stat.mtime.toISOString() });
      } catch {}
    }
    plans.sort((a, b) => new Date(b.modified) - new Date(a.modified));

    // Index plans for FTS
    try {
      deleteSearchType('plan');
      upsertSearchEntries(plans.map(p => ({
        id: p.filename, type: 'plan', folder: null,
        title: p.title,
        body: fs.readFileSync(path.join(plansDir, p.filename), 'utf8'),
      })));
    } catch {}

    return plans;
  } catch (err) {
    console.error('Error reading plans:', err);
    return [];
  }
});

// --- IPC: get-plans-dir ---
// The plans list is account-scoped; the renderer needs the resolved path so an
// empty list can say which directory it actually looked in.
ipcMain.handle('get-plans-dir', () => {
  const account = getActiveAccount();
  const dir = activePlansDir();
  return { dir, exists: fs.existsSync(dir), accountName: account.name, accountId: account.id };
});

// --- IPC: read-plan ---
ipcMain.handle('read-plan', (_event, filename) => {
  try {
    const filePath = path.join(activePlansDir(), path.basename(filename));
    const content = fs.readFileSync(filePath, 'utf8');
    return { content, filePath };
  } catch (err) {
    console.error('Error reading plan:', err);
    return { content: '', filePath: '' };
  }
});

// --- IPC: save-plan ---
ipcMain.handle('save-plan', (_event, filePath, content) => {
  try {
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(activePlansDir())) {
      return { ok: false, error: 'path outside plans directory' };
    }
    fs.writeFileSync(resolved, content, 'utf8');
    return { ok: true };
  } catch (err) {
    console.error('Error saving plan:', err);
    return { ok: false, error: err.message };
  }
});

// Stats for one account: its own rows in the session cache, enriched with the
// stats-cache.json `claude /stats` wrote into that account's config dir. The
// accounts panel is the only reader — there is one stats data path.
function buildStatsForAccount(account) {
  const dbStats = computeStatsFromDb(account.id);
  try {
    const statsPath = path.join(account.configDir, 'stats-cache.json');
    if (fs.existsSync(statsPath)) {
      const fileStats = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
      // Prefer file stats (has rich token data) but fall back to DB for activity data
      if (!fileStats.dailyActivity?.length && dbStats.dailyActivity.length) {
        fileStats.dailyActivity = dbStats.dailyActivity;
      }
      if (!fileStats.totalSessions) fileStats.totalSessions = dbStats.totalSessions;
      if (!fileStats.totalMessages) fileStats.totalMessages = dbStats.totalMessages;
      return fileStats;
    }
  } catch (err) {
    console.error('Error reading stats cache:', err);
  }
  // No file cache — return DB-computed stats so charts always render
  return dbStats;
}

// --- IPC: refresh-stats (run /stats + /usage via PTY) ---
ipcMain.handle('refresh-stats', async () => {
  // For stats, use the configured shell profile — unless the account lives in a
  // distribution, in which case that is where its `claude` binary and its
  // credentials are, and a Windows shell could reach neither.
  const globalSettings = getSetting('global') || {};
  const statsDistro = activeWslDistro();
  const statsProfileId = globalSettings.shellProfile || SETTING_DEFAULTS.shellProfile;
  const statsShellProfile = resolveShell(statsDistro ? 'wsl:' + statsDistro : statsProfileId);
  const statsShell = statsShellProfile.path;
  const statsShellExtraArgs = statsShellProfile.args || [];
  const statsInWsl = isWslShell(statsShell);
  if (statsDistro && !statsInWsl) {
    // Same shape as the handler's other failure path — the renderer reads
    // .stats/.usage and would silently ignore anything else.
    log.error(`[stats] WSL distribution "${statsDistro}" is not available`);
    return { stats: null, usage: {} };
  }
  const configDir = activeConfigDir();
  const ptyEnv = {
    ...cleanPtyEnv,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'iTerm.app',
    TERM_PROGRAM_VERSION: '3.6.6',
    FORCE_COLOR: '3',
    // No ITERM_SESSION_ID: without it Claude CLI won't try to reach iTerm2 via AppleScript,
    // which avoids the macOS "would like to access data from other apps" permission prompt.
    // CLAUDE_CONFIG_DIR is skipped for a WSL account: its configDir is the
    // Windows view of a home that is already the default inside the distro.
    ...(configDir !== DEFAULT_CLAUDE_DIR && !statsDistro ? { CLAUDE_CONFIG_DIR: configDir } : {}),
  };
  if (statsInWsl) {
    Object.assign(ptyEnv, withWslEnv(ptyEnv, [
      'TERM', 'COLORTERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'FORCE_COLOR',
    ]));
  }

  // Helper: spawn claude with args, collect output, auto-accept trust, kill when idle
  // waitFor: optional regex tested against stripped output — finish only when matched
  function runClaude(args, { timeoutMs = 15000, waitFor = null } = {}) {
    return new Promise((resolve) => {
      let output = '';
      let settled = false;
      let trustAccepted = false;
      // Track idle: ✳ in OSC title means Claude is idle and waiting for input
      let sawActivity = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        try { p.kill(); } catch {}
        resolve(output);
      };

      const claudeCmd = `claude ${args}`;
      const p = pty.spawn(statsShell, shellArgs(statsShell, claudeCmd, statsShellExtraArgs), {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: os.homedir(),
        env: ptyEnv,
      });

      const strip = (s) => s
        .replace(/\x1b\[[^@-~]*[@-~]/g, '')
        .replace(/\x1b\][^\x07]*\x07/g, '')
        .replace(/\x1b[^[\]].?/g, '');

      p.onData((data) => {
        output += data;

        // Auto-accept trust directory prompt (Enter selects "1. Yes")
        if (!trustAccepted) {
          if (/trust\s*this\s*folder/i.test(strip(output))) {
            trustAccepted = true;
            try { p.write('\r'); } catch {}
            return;
          }
        }

        // If waitFor is set, finish when that pattern appears in stripped output
        if (waitFor) {
          if (waitFor.test(strip(output))) {
            finish();
          }
          return;
        }

        // Default: detect busy→idle transition via OSC title containing ✳
        if (!sawActivity) {
          const oscTitle = data.match(/\x1b\]0;([^\x07\x1b]*)/);
          if (oscTitle) {
            const first = oscTitle[1].charAt(0);
            if (first.charCodeAt(0) >= 0x2800 && first.charCodeAt(0) <= 0x28FF) {
              sawActivity = true;
            }
          }
        } else if (data.includes('\u2733')) {
          finish();
        }
      });

      p.onExit(() => finish());
      setTimeout(finish, timeoutMs);
    });
  }

  try {
    // Run /stats via PTY (for heatmap/chart data) and fetch usage via API in parallel
    const [, usage] = await Promise.all([
      runClaude('"/stats"', { waitFor: /streak/i, timeoutMs: 10000 }),
      fetchAndTransformUsage(configDir).catch(() => ({})),
    ]);

    // Read refreshed stats cache (written to active account's config dir)
    const activeAccount = getActiveAccount();
    const dbStats = computeStatsFromDb(activeAccount.id);
    let stats = dbStats;
    try {
      const statsPath = path.join(configDir, 'stats-cache.json');
      if (fs.existsSync(statsPath)) {
        const fileStats = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
        if (!fileStats.dailyActivity?.length && dbStats.dailyActivity.length) {
          fileStats.dailyActivity = dbStats.dailyActivity;
        }
        if (!fileStats.totalSessions) fileStats.totalSessions = dbStats.totalSessions;
        if (!fileStats.totalMessages) fileStats.totalMessages = dbStats.totalMessages;
        stats = fileStats;
      }
    } catch {}

    return { stats, usage: usage || {} };
  } catch (err) {
    log.error('Error refreshing stats:', err);
    return { stats: null, usage: {} };
  }
});

// --- IPC: get-memories ---
function folderToShortPath(folder) {
  // Convert "-Users-home-dev-MyClaude" → "dev/MyClaude"
  const parts = folder.replace(/^-/, '').split('-');
  const meaningful = parts.filter(Boolean);
  return meaningful.slice(-2).join('/');
}

/** Scan a directory for .md files (non-recursive). Returns array of { filename, filePath, modified }. */
// `dir` is canonical: a Windows path, or the POSIX path of a WSL-backed
// project. Reported filePaths keep that same flavour; only the fs calls are
// translated.
function scanMdFiles(dir) {
  const results = [];
  try {
    if (!fs.existsSync(hostPath(dir))) return results;
    const entries = fs.readdirSync(hostPath(dir), { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.md')) {
        const fp = projectJoin(dir, e.name);
        const content = fs.readFileSync(hostPath(fp), 'utf8').trim();
        if (content) {
          const stat = fs.statSync(hostPath(fp));
          results.push({ filename: e.name, filePath: fp, modified: stat.mtime.toISOString() });
        }
      }
    }
  } catch {}
  return results;
}

ipcMain.handle('get-memories', () => {
  const global = getSetting('global') || {};
  const hiddenProjects = new Set(global.hiddenProjects || []);

  // --- Global files ---
  // The active account's Claude home, not the Windows one: a WSL account's
  // global CLAUDE.md lives inside the distribution.
  const globalFiles = scanMdFiles(activeConfigDir()).map(f => ({ ...f, displayPath: '~/.claude' }));

  // --- Per-project files ---
  const projects = [];
  try {
    const memoriesProjectsDir = activeProjectsDir();
    if (fs.existsSync(memoriesProjectsDir)) {
      const folders = fs.readdirSync(memoriesProjectsDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name !== '.git')
        .map(d => d.name);

      for (const folder of folders) {
        const folderPath = path.join(memoriesProjectsDir, folder);
        const projectPath = deriveProjectPath(folderPath, folder);
        if (projectPath && hiddenProjects.has(projectPath)) continue;

        // Use same 2-deep short path as Sessions tab (e.g. "dev/MyClaude")
        const shortName = projectPath
          ? projectPath.split('/').filter(Boolean).slice(-2).join('/')
          : folderToShortPath(folder);
        const files = [];
        const seenPaths = new Set();

        // 1. ~/.claude/projects/{folder}/ — claude-home .md files
        const claudeHomeFiles = scanMdFiles(folderPath);
        for (const f of claudeHomeFiles) {
          files.push({ ...f, displayPath: '~/.claude', source: 'claude-home' });
          seenPaths.add(f.filePath);
        }
        // memory/MEMORY.md
        const memoryDir = path.join(folderPath, 'memory');
        const memoryFiles = scanMdFiles(memoryDir);
        for (const f of memoryFiles) {
          files.push({ ...f, displayPath: '~/.claude', source: 'claude-home' });
          seenPaths.add(f.filePath);
        }

        // 2. {projectPath}/ — project root CLAUDE.md, agents.md
        if (projectPath) {
          for (const name of ['CLAUDE.md', 'GEMINI.md', 'agents.md']) {
            const fp = projectJoin(projectPath, name);
            try {
              if (fs.existsSync(hostPath(fp))) {
                const content = fs.readFileSync(hostPath(fp), 'utf8').trim();
                if (content && !seenPaths.has(fp)) {
                  const stat = fs.statSync(hostPath(fp));
                  files.push({ filename: name, filePath: fp, modified: stat.mtime.toISOString(), displayPath: shortName + '/', source: 'project' });
                  seenPaths.add(fp);
                }
              }
            } catch {}
          }

          // 3. {projectPath}/.claude/ — commands/*.md and other .md files
          const dotClaudeDir = projectJoin(projectPath, '.claude');
          const dotClaudeFiles = scanMdFiles(dotClaudeDir);
          for (const f of dotClaudeFiles) {
            if (!seenPaths.has(f.filePath)) {
              files.push({ ...f, displayPath: shortName + '/.claude/', source: 'project' });
              seenPaths.add(f.filePath);
            }
          }
          // commands/*.md
          const commandsDir = projectJoin(dotClaudeDir, 'commands');
          const commandFiles = scanMdFiles(commandsDir);
          for (const f of commandFiles) {
            if (!seenPaths.has(f.filePath)) {
              files.push({ ...f, displayPath: shortName + '/.claude/commands/', source: 'project' });
              seenPaths.add(f.filePath);
            }
          }
        }

        if (files.length > 0) {
          projects.push({ folder, projectPath: projectPath || '', shortName, files });
        }
      }
    }
  } catch (err) {
    console.error('Error scanning memories:', err);
  }

  // Sort projects by most recent file modified date
  projects.sort((a, b) => {
    const aMax = Math.max(...a.files.map(f => new Date(f.modified).getTime()));
    const bMax = Math.max(...b.files.map(f => new Date(f.modified).getTime()));
    return bMax - aMax;
  });

  const result = { global: { files: globalFiles }, projects };

  // Index all files for FTS
  try {
    deleteSearchType('memory');
    const allFiles = [
      ...globalFiles.map(f => ({ ...f, label: 'Global' })),
      ...projects.flatMap(p => p.files.map(f => ({ ...f, label: p.shortName }))),
    ];
    // filePath is canonical; one unreadable file would otherwise throw out of
    // the whole batch and leave memory search unindexed entirely.
    upsertSearchEntries(allFiles.map(f => {
      let body = '';
      try { body = fs.readFileSync(hostPath(f.filePath), 'utf8'); } catch {}
      return {
        id: f.filePath, type: 'memory', folder: null,
        title: f.label + ' ' + f.filename,
        body,
      };
    }));
  } catch {}

  return result;
});

// --- IPC: search ---
ipcMain.handle('search', (_event, type, query, titleOnly) => {
  return searchByType(type, query, 50, !!titleOnly);
});

// --- IPC: settings ---
ipcMain.handle('get-setting', (_event, key) => {
  return getSetting(key);
});

ipcMain.handle('set-setting', (_event, key, value) => {
  setSetting(key, value);
  return { ok: true };
});

ipcMain.handle('delete-setting', (_event, key) => {
  deleteSetting(key);
  return { ok: true };
});

// --- Multi-account IPCs ---

ipcMain.handle('get-accounts', () => getAccounts());

ipcMain.handle('save-accounts', (_event, accounts) => {
  const withDefault = accounts.find(a => a.id === 'default')
    ? accounts
    : [DEFAULT_ACCOUNT, ...accounts];
  setSetting('accounts', withDefault);
  return { ok: true };
});

ipcMain.handle('create-account', (_event, name) => {
  const { randomUUID } = require('crypto');
  const id = 'acc-' + randomUUID().replace(/-/g, '').slice(0, 12);
  const configDir = path.join(os.homedir(), '.wootonpad', 'accounts', id);
  fs.mkdirSync(configDir, { recursive: true });
  const account = { id, name, configDir };
  const existing = getAccounts();
  setSetting('accounts', [...existing, account]);
  return account;
});

// Distributions that hold a reachable Claude home, for the "add account" UI.
ipcMain.handle('discover-wsl-claude-homes', async () => {
  try { return await discoverWslClaudeHomes(); } catch { return []; }
});

// Attach an account to the Claude home inside a WSL distribution. Additive:
// accounts without `wslDistro` keep behaving exactly as before.
ipcMain.handle('create-wsl-account', async (_event, distro, name) => {
  const existingForDistro = getAccounts().find(a => a.wslDistro === distro);
  if (existingForDistro) return existingForDistro;
  const probe = await probeWslClaudeHome(distro);
  if (!probe) return { error: `No reachable Claude home in WSL distribution "${distro}"` };
  const { randomUUID } = require('crypto');
  const id = 'wsl-' + randomUUID().replace(/-/g, '').slice(0, 12);
  const account = {
    id,
    name: name || `WSL — ${distro}`,
    configDir: probe.configDir,
    wslDistro: probe.distro,
    wslUncPrefix: probe.uncPrefix,
    wslHome: probe.home,
  };
  setSetting('accounts', [...getAccounts(), account]);
  return account;
});

ipcMain.handle('rename-account', (_event, id, name) => {
  const updated = getAccounts().map(a => a.id === id ? { ...a, name } : a);
  setSetting('accounts', updated);
  return { ok: true };
});

ipcMain.handle('delete-account', (_event, id) => {
  if (id === 'default') return { ok: false };
  const updated = getAccounts().filter(a => a.id !== id);
  setSetting('accounts', updated);
  return { ok: true };
});

ipcMain.handle('get-homedir', () => os.homedir());

ipcMain.handle('get-active-account-id', () => {
  return (getSetting('global') || {}).activeAccountId || 'default';
});

ipcMain.handle('set-active-account-id', (_event, accountId) => {
  const global = getSetting('global') || {};
  global.activeAccountId = accountId;
  setSetting('global', global);

  // Re-init session cache for new account and trigger re-scan. Fork/plan-accept
  // detection holds its own copy of the projects directory, so it has to be
  // re-pointed too — otherwise it keeps watching the previous account's folder.
  initSessionCache();
  require('./session-transitions').init({
    PROJECTS_DIR: activeProjectsDir(), activeSessions, getMainWindow: () => mainWindow, log, rekeyMcpServer,
  });
  restartProjectsWatcher();
  populateCacheViaWorker();
  return { ok: true };
});

ipcMain.handle('get-accounts-usage', async () => {
  const accounts = getAccounts();
  const results = {};
  await Promise.all(accounts.map(async (account) => {
    const cacheKey = 'usage:' + account.id;
    try {
      const usage = await fetchAndTransformUsage(account.configDir);
      if (usage && !usage._error && !usage._rateLimited && Object.keys(usage).length) {
        setSetting(cacheKey, usage);
        results[account.id] = usage;
      } else {
        const cached = getSetting(cacheKey);
        results[account.id] = cached ? { ...cached, _cached: true } : (usage || {});
      }
    } catch {
      const cached = getSetting(cacheKey);
      results[account.id] = cached ? { ...cached, _cached: true } : {};
    }
  }));
  return results;
});

// --- Account detail panel ---
// Everything below reads one account's own Claude home. An account's configDir
// is already host-usable (the WSL flavour stores the UNC view), so plain fs
// calls are correct here — but nothing composes a project path, and nothing
// builds a shell string, so rules 2 and 3 of the WSL contract stay intact.

// Files the panel is willing to open, all directly inside configDir. This is an
// allowlist, not a hint: `.credentials.json` deliberately never appears, and no
// name here contains a separator. `.claude.json` only lives in configDir for a
// non-default account — for the default one Claude keeps it at ~/.claude.json,
// outside the config dir, so it is surfaced as a path and never read here.
const ACCOUNT_CONFIG_FILES = ['settings.json', 'settings.local.json', '.claude.json', '.mcp.json'];
const ACCOUNT_FILE_MAX_BYTES = 2 * 1024 * 1024;

function findAccount(accountId) {
  return getAccounts().find(a => a.id === accountId) || null;
}

// Resolve `name` inside the account's config dir, or null if it escapes it.
// The allowlist already forbids separators; the resolve check is the backstop
// that makes that guarantee independent of the list.
function resolveAccountFile(account, name) {
  if (!ACCOUNT_CONFIG_FILES.includes(name)) return null;
  const root = path.resolve(account.configDir);
  const resolved = path.resolve(root, name);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

function statAccountFile(account, name) {
  const filePath = resolveAccountFile(account, name);
  if (!filePath) return null;
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) return null;
    return { name, path: filePath, size: st.size, mtime: st.mtime.toISOString() };
  } catch {
    return null;
  }
}

// The OAuth record, minus anything secret. accessToken/refreshToken never leave
// the main process — the renderer only needs to know a token is there and when
// it lapses.
function accountTokenInfo(account) {
  let oauth = null;
  try { oauth = getOAuthToken(account.configDir); } catch { oauth = null; }
  if (!oauth?.accessToken) return { present: false };
  const expiresAt = typeof oauth.expiresAt === 'number'
    ? (oauth.expiresAt > 1e12 ? oauth.expiresAt : oauth.expiresAt * 1000)
    : null;
  return {
    present: true,
    // Where the credential came from, so the panel can explain a missing file.
    source: fs.existsSync(path.join(account.configDir, '.credentials.json'))
      ? 'credentials file'
      : (process.platform === 'darwin' ? 'macOS Keychain' : 'credentials file'),
    expiresAt,
    expired: expiresAt != null ? expiresAt <= Date.now() : false,
    scopes: Array.isArray(oauth.scopes) ? oauth.scopes : [],
    subscriptionType: oauth.subscriptionType || null,
  };
}

// One round trip for the panel's static half: paths, which config files exist,
// whether a token is on file, and the last usage figures already in the DB.
// Nothing here touches the network.
// Resolving `claude` to an absolute path is not optional. An app launched from
// Finder or the Dock inherits launchd's minimal PATH — /usr/bin:/bin:/usr/sbin:
// /sbin — not the shell's, so `spawn('claude')` fails with ENOENT in a packaged
// build while working fine under `npm start`, which is launched from a terminal.
// Same reason DOCKER_PATH exists above.
//
// Order: ask a login shell first, since that is where nvm/mise/asdf/bun put the
// binary, then fall back to the locations the installers actually use.
const CLAUDE_EXTRA_PATH = [
  path.join(os.homedir(), '.local', 'bin'),
  path.join(os.homedir(), '.claude', 'local'),
  path.join(os.homedir(), '.bun', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
];

let _claudeBinary;
function resolveClaudeBinary() {
  if (_claudeBinary !== undefined) return _claudeBinary;
  const { execFileSync } = require('child_process');
  const opts = { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] };
  _claudeBinary = null;

  if (process.platform === 'win32') {
    try {
      const out = execFileSync('where', ['claude'], opts);
      _claudeBinary = out.split(/\r?\n/).map(s => s.trim()).find(Boolean) || null;
    } catch {}
  } else {
    // -l so the profile that sets up the version manager is sourced. SHELL can
    // be absent under launchd, hence the explicit default.
    for (const args of [['-lc', 'command -v claude'], ['-c', 'command -v claude']]) {
      try {
        const out = execFileSync(process.env.SHELL || '/bin/zsh', args, opts);
        const hit = out.split('\n').map(s => s.trim()).find(Boolean);
        if (hit && fs.existsSync(hit)) { _claudeBinary = hit; break; }
      } catch {}
    }
    if (!_claudeBinary) {
      for (const dir of CLAUDE_EXTRA_PATH) {
        const candidate = path.join(dir, 'claude');
        try { fs.accessSync(candidate, fs.constants.X_OK); _claudeBinary = candidate; break; } catch {}
      }
    }
  }

  // Nothing found: keep the bare name so the failure is an honest ENOENT rather
  // than a path we invented.
  if (!_claudeBinary) _claudeBinary = 'claude';
  return _claudeBinary;
}

// The CLI shells out to git, node and friends, which are equally missing from
// launchd's PATH.
function claudeChildPath() {
  const extra = process.platform === 'win32' ? [] : CLAUDE_EXTRA_PATH;
  return [process.env.PATH || '', ...extra].filter(Boolean).join(path.delimiter);
}

// The SDK would otherwise use the `claude` it bundles — a second copy of the
// CLI, on its own release cadence, resolving its own account. Point it at the
// same binary every PTY session already runs.
sdkSession.configure({ log, resolveClaudeBinary, claudeChildPath });

function posixQuote(value) {
  return /^[A-Za-z0-9_./:@%+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

// Mirrors what the PTY spawn actually does (see the CLAUDE_CONFIG_DIR block in
// open-terminal): inside a WSL distribution that home is already the default
// and the Windows view of it is not a path Claude could resolve there.
function accountLaunchCommand(account) {
  const distro = accountWslDistro(account);
  if (distro) return `wsl.exe -d ${distro} -- claude`;
  return `CLAUDE_CONFIG_DIR=${posixQuote(account.configDir)} ${posixQuote(resolveClaudeBinary())}`;
}

ipcMain.handle('get-account-detail', (_event, accountId) => {
  const account = findAccount(accountId);
  if (!account) return { ok: false, error: 'unknown account' };

  let configDirExists = false;
  try { configDirExists = fs.statSync(account.configDir).isDirectory(); } catch {}

  const files = ACCOUNT_CONFIG_FILES.map(n => statAccountFile(account, n)).filter(Boolean);

  // ~/.claude.json for the default account: outside configDir, so read-only as
  // a path. Offered because it is the file people actually want to point at.
  const externalFiles = [];
  if (account.configDir === DEFAULT_CLAUDE_DIR) {
    const homeJson = path.join(os.homedir(), '.claude.json');
    try {
      const st = fs.statSync(homeJson);
      if (st.isFile()) {
        externalFiles.push({ name: '.claude.json', path: homeJson, size: st.size, mtime: st.mtime.toISOString() });
      }
    } catch {}
  }

  const cached = getSetting('usage:' + account.id);

  return {
    ok: true,
    account: {
      id: account.id,
      name: account.name,
      configDir: account.configDir,
      wslDistro: account.wslDistro || null,
      wslHome: account.wslHome || null,
    },
    isActive: getActiveAccount().id === account.id,
    configDirExists,
    launchCommand: accountLaunchCommand(account),
    files,
    externalFiles,
    token: accountTokenInfo(account),
    usage: cached ? { ...cached, _cached: true } : {},
  };
});

// Read one allowlisted config file out of the account's own config dir.
ipcMain.handle('read-account-config-file', (_event, accountId, name) => {
  const account = findAccount(accountId);
  if (!account) return { ok: false, error: 'unknown account' };
  const filePath = resolveAccountFile(account, name);
  if (!filePath) return { ok: false, error: 'file not readable for this account' };
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) return { ok: false, error: 'not a file' };
    const truncated = st.size > ACCOUNT_FILE_MAX_BYTES;
    const content = truncated
      ? fs.readFileSync(filePath, 'utf8').slice(0, ACCOUNT_FILE_MAX_BYTES)
      : fs.readFileSync(filePath, 'utf8');
    return { ok: true, name, path: filePath, size: st.size, truncated, content };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// "Am I still signed in?" — asks the usage API and reports what the status code
// means. 401/403 is the reachable case the CLI logs today: the token is on disk
// but the server has stopped accepting it.
ipcMain.handle('check-account-auth', async (_event, accountId) => {
  const account = findAccount(accountId);
  if (!account) return { ok: false, state: 'unknown', message: 'unknown account' };
  try {
    const probe = await probeUsage(account.configDir);
    if (!probe.tokenPresent) {
      return { ok: true, state: 'missing', status: 0, message: 'No OAuth token found for this account.' };
    }
    if (probe.ok) {
      const usage = probe.usage || {};
      if (Object.keys(usage).length) setSetting('usage:' + account.id, usage);
      return { ok: true, state: 'authorized', status: probe.status, message: 'Token accepted by the usage API.', usage };
    }
    if (probe.status === 401 || probe.status === 403) {
      return { ok: true, state: 'expired', status: probe.status, message: 'The API rejected this token — sign in again with `claude` in this account.' };
    }
    if (probe.status === 429) {
      const mins = Math.ceil((probe.retryAfterSeconds || 0) / 60);
      return {
        ok: true,
        state: 'rate-limited',
        status: 429,
        message: mins > 0 ? `Usage API rate limited — retry in ~${mins} min.` : 'Usage API rate limited — retry later.',
      };
    }
    return { ok: true, state: 'error', status: probe.status, message: `Usage API returned ${probe.status}.` };
  } catch (err) {
    return { ok: true, state: 'network', status: 0, message: err.message || 'Could not reach the usage API.' };
  }
});

// Same stats data path as the active-account Stats tab, pointed at one account.
ipcMain.handle('get-account-stats', (_event, accountId) => {
  const account = findAccount(accountId);
  if (!account) return null;
  return buildStatsForAccount(account);
});

// --- Scheduled tasks ---
const scheduleIpc = require('./schedule-ipc');

const COMMIT_MSG_PROMPT_DEFAULT = `Write a concise git commit message (max 72 chars for first line) for these changes. Use conventional commit format (feat/fix/refactor/docs/chore). Output ONLY the commit message, no explanation:`;

const SETTING_DEFAULTS = {
  permissionMode: null,
  dangerouslySkipPermissions: false,
  worktree: false,
  worktreeName: '',
  chrome: false,
  preLaunchCmd: '',
  addDirs: '',
  visibleSessionCount: 5,
  sidebarWidth: 340,
  terminalTheme: 'wootonpadDark',
  mcpEmulation: false,
  shellProfile: 'auto',
  showAvatars: true,
  commitMessagePrompt: '',
};

ipcMain.handle('get-shell-profiles', () => {
  _shellProfiles = null; // refresh on each request
  return getShellProfiles();
});

ipcMain.handle('get-effective-settings', (_event, projectPath) => {
  const global = getSetting('global') || {};
  const project = projectPath ? (getSetting('project:' + projectPath) || {}) : {};
  const effective = { ...SETTING_DEFAULTS };
  for (const key of Object.keys(SETTING_DEFAULTS)) {
    if (global[key] !== undefined && global[key] !== null) {
      effective[key] = global[key];
    }
    if (project[key] !== undefined && project[key] !== null) {
      effective[key] = project[key];
    }
  }
  return effective;
});

// --- IPC: get-active-sessions ---
ipcMain.handle('get-active-sessions', () => {
  const active = [];
  for (const [sessionId, session] of activeSessions) {
    // Ephemeral shells belong to the session side panel, which owns their whole
    // lifecycle. They are not sessions the sidebar or the grid may know about.
    if (!session.exited && !session.isEphemeral) active.push(sessionId);
  }
  // SDK sessions are just as live; the sidebar's green dot must not depend on
  // which transport a session happens to use.
  for (const id of sdkSession.activeSdkSessions()) {
    if (!active.includes(id)) active.push(id);
  }
  return active;
});

// --- IPC: get-session-statuses ---
// Status lives in the main process, so a renderer reload can recover it instead
// of starting blank and waiting for the next lifecycle event — which, for a
// session sitting idle, may never come.
ipcMain.handle('get-session-statuses', () => sessionStatus.all());

// --- IPC: get-active-terminals --- (plain terminal sessions for renderer restore)
ipcMain.handle('get-active-terminals', () => {
  const terminals = [];
  for (const [sessionId, session] of activeSessions) {
    if (!session.exited && session.isPlainTerminal && !session.isEphemeral) {
      terminals.push({ sessionId, projectPath: session.projectPath });
    }
  }
  return terminals;
});

// --- IPC: stop-session ---
ipcMain.handle('stop-session', (_event, sessionId) => {
  if (sdkSession.isSdkSession(sessionId)) {
    sessionStatus.remove(sessionId);
    return sdkSession.stopSdkSession(sessionId);
  }
  const session = activeSessions.get(sessionId);
  if (!session || session.exited) return { ok: false, error: 'not running' };
  session.pty.kill();
  return { ok: true };
});

// --- IPC: toggle-star ---
ipcMain.handle('toggle-star', (_event, sessionId) => {
  const starred = toggleStar(sessionId);
  return { starred };
});

// --- IPC: rename-session ---
ipcMain.handle('rename-session', (_event, sessionId, name) => {
  setName(sessionId, name || null);
  // Update search index title to include the new name
  const cached = getCachedSession(sessionId);
  const summary = cached?.summary || '';
  updateSearchTitle(sessionId, 'session', (name ? name + ' ' : '') + summary);
  return { name: name || null };
});

// --- IPC: archive-session ---
ipcMain.handle('read-session-jsonl', (_event, sessionId) => {
  const folder = getCachedFolder(sessionId);
  if (!folder) return { error: 'Session not found in cache' };
  const jsonlPath = path.join(activeProjectsDir(), folder, sessionId + '.jsonl');
  try {
    const content = fs.readFileSync(jsonlPath, 'utf-8');
    const entries = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch {}
    }
    return { entries };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('archive-session', (_event, sessionId, archived) => {
  const val = archived ? 1 : 0;
  setArchived(sessionId, val);
  return { archived: val };
});

// --- IPC: get-session-meta ---
// Everything about a session that is worth knowing but not worth caching: the
// session menu asks for it when it opens, once per session. Reading the whole
// .jsonl here rather than widening session_cache keeps this out of the indexer
// and off the startup path — nothing on screen depends on it.
ipcMain.handle('get-session-meta', (_event, sessionId) => {
  const folder = getCachedFolder(sessionId);
  if (!folder) return { ok: false, error: 'Session not found in cache' };
  // activeProjectsDir() is already the host's view of the account's home — for
  // a WSL account, the UNC path. Same composition read-session-jsonl uses.
  const jsonlPath = path.join(activeProjectsDir(), folder, sessionId + '.jsonl');
  let content, stat;
  try {
    stat = fs.statSync(jsonlPath);
    content = fs.readFileSync(jsonlPath, 'utf-8');
  } catch (err) {
    return { ok: false, error: err.message };
  }

  let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheCreateTokens = 0;
  let userTurns = 0, assistantTurns = 0, toolCalls = 0;
  let firstTimestamp = null, lastTimestamp = null;
  let firstPrompt = '', gitBranch = null, cwd = null, version = null, effort = null;
  let costUSD = 0;
  const models = new Set();
  const tools = new Map();
  const touchedFiles = new Set();
  let linesAdded = 0, linesRemoved = 0;

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }

    if (entry.timestamp) {
      if (!firstTimestamp) firstTimestamp = entry.timestamp;
      lastTimestamp = entry.timestamp;
    }
    if (entry.gitBranch) gitBranch = entry.gitBranch;
    if (entry.cwd) cwd = entry.cwd;
    if (entry.version) version = entry.version;
    if (entry.effort) effort = entry.effort;
    // Written at the end of a stretch and not always present — taken as the
    // best available figure rather than the authority. See read-session-file.js.
    if (entry.type === 'cost-state' && typeof entry.totalCostUSD === 'number') costUSD = entry.totalCostUSD;

    const isUser = entry.type === 'user' || (entry.type === 'message' && entry.role === 'user');
    const isAssistant = entry.type === 'assistant' || (entry.type === 'message' && entry.role === 'assistant');
    if (isUser) userTurns++;
    if (isAssistant) assistantTurns++;

    const msg = entry.message;
    if (msg && typeof msg === 'object') {
      if (msg.model) models.add(msg.model);
      const u = msg.usage;
      if (u) {
        inputTokens += u.input_tokens || 0;
        outputTokens += u.output_tokens || 0;
        cacheReadTokens += u.cache_read_input_tokens || 0;
        cacheCreateTokens += u.cache_creation_input_tokens || 0;
      }
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block?.type !== 'tool_use') continue;
          toolCalls++;
          tools.set(block.name, (tools.get(block.name) || 0) + 1);
          if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(block.name)) {
            const target = block.input?.file_path || block.input?.notebook_path;
            if (target) touchedFiles.add(target);
          }
        }
      }
    }

    const result = entry.toolUseResult;
    if (result && typeof result === 'object') {
      if (Array.isArray(result.structuredPatch) && result.structuredPatch.length) {
        for (const hunk of result.structuredPatch) {
          for (const patchLine of hunk.lines || []) {
            if (patchLine.startsWith('+')) linesAdded++;
            else if (patchLine.startsWith('-')) linesRemoved++;
          }
        }
      } else if (typeof result.content === 'string' && result.filePath) {
        linesAdded += result.content.split('\n').length;
      }
    }

    if (!firstPrompt && isUser) {
      const text = typeof msg === 'string' ? msg
        : (typeof msg?.content === 'string' ? msg.content : (msg?.content?.[0]?.text || ''));
      if (text && !/<bash-input>|<bash-stdout>|<local-command-caveat>/.test(text)) {
        firstPrompt = text.slice(0, 600);
      }
    }
  }

  return {
    ok: true,
    sessionId,
    projectPath: getCachedSession(sessionId)?.projectPath || null,
    created: firstTimestamp || stat.birthtime.toISOString(),
    lastActivity: lastTimestamp || stat.mtime.toISOString(),
    userTurns, assistantTurns, toolCalls,
    topTools: [...tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, count]) => ({ name, count })),
    inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens,
    costUSD,
    models: [...models],
    effort, version, gitBranch, cwd,
    changedFiles: touchedFiles.size, linesAdded, linesRemoved,
    fileBytes: stat.size,
  };
});

// --- IPC: delete-session ---
// Removes the transcript itself, not just the row: a session deleted here is
// gone from ~/.claude/projects too, so the next scan cannot bring it back.
// Destructive and unrecoverable — the renderer confirms before calling.
ipcMain.handle('delete-session', async (_event, sessionId) => {
  const folder = getCachedFolder(sessionId);
  if (!folder) return { ok: false, error: 'Session not found in cache' };

  // A live PTY holds the file open and would keep writing to it.
  const live = activeSessions.get(sessionId);
  if (live && !live.exited) {
    try { live.pty.kill(); } catch {}
    await new Promise(r => setTimeout(r, 150));
  }

  const jsonlPath = path.join(activeProjectsDir(), folder, sessionId + '.jsonl');
  try {
    fs.unlinkSync(jsonlPath);
  } catch (err) {
    // Already gone on disk is not a failure — the cache rows still have to go.
    if (err.code !== 'ENOENT') return { ok: false, error: err.message };
  }
  deleteCachedSession(sessionId);
  deleteSearchSession(sessionId);
  deleteSessionMeta(sessionId);
  return { ok: true };
});

// --- IPC: open-terminal ---
ipcMain.handle('open-terminal', async (_event, sessionId, projectPath, isNew, sessionOptions) => {
  if (!mainWindow) return { ok: false, error: 'no window' };

  // An SDK session has no PTY and no terminal to reattach to — the renderer
  // rebuilds its view from the transcript, which is the same .jsonl the cache
  // already indexes. Reattaching is therefore a no-op that must not fall
  // through into the spawn path below and start a second one.
  if (sdkSession.isSdkSession(sessionId)) {
    return { ok: true, mode: 'sdk', reattached: true };
  }

  if (sessionOptions?.mode === 'sdk' && !sessionOptions?.isPlainTerminal) {
    const result = await startSdkSessionFor(sessionId, projectPath, isNew, sessionOptions);
    return result.ok ? { ok: true, mode: 'sdk' } : result;
  }

  // Reattach to existing session
  if (activeSessions.has(sessionId)) {
    const session = activeSessions.get(sessionId);
    session.rendererAttached = true;
    session.firstResize = !session.isPlainTerminal;

    // If TUI is in alternate screen mode, send escape to switch into it
    if (session.altScreen && !session.isPlainTerminal) {
      mainWindow.webContents.send('terminal-data', sessionId, '\x1b[?1049h');
    }

    // Send buffered output for reattach
    for (const chunk of session.outputBuffer) {
      mainWindow.webContents.send('terminal-data', sessionId, chunk);
    }

    if (!session.isPlainTerminal) {
      // Hide cursor after buffer replay — the live PTY stream or resize nudge
      // will re-show it at the correct position, avoiding a stale cursor artifact
      mainWindow.webContents.send('terminal-data', sessionId, '\x1b[?25l');
    }

    return { ok: true, reattached: true, mcpActive: !!session.mcpServer };
  }

  // Spawn new PTY
  if (!fs.existsSync(hostPath(projectPath))) {
    return { ok: false, error: `project directory no longer exists: ${projectPath}` };
  }

  const isPlainTerminal = sessionOptions?.type === 'terminal';
  // The session side panel's scratch shell: created when the panel opens,
  // killed when it closes. Exactly one may exist, so a renderer reload — which
  // never gets to run the panel's own teardown — cannot leak a PTY: the next
  // panel to open reaps whatever the previous document left behind.
  const isEphemeral = !!sessionOptions?.ephemeral;
  if (isEphemeral) {
    for (const [, s] of activeSessions) {
      if (s.isEphemeral && !s.exited) {
        try { s.pty.kill(); } catch {}
      }
    }
  }

  // Resolve shell profile from effective settings
  const effectiveProfileId = (() => {
    const global = getSetting('global') || {};
    const project = projectPath ? (getSetting('project:' + projectPath) || {}) : {};
    let profileId = SETTING_DEFAULTS.shellProfile;
    if (global.shellProfile !== undefined && global.shellProfile !== null) profileId = global.shellProfile;
    if (project.shellProfile !== undefined && project.shellProfile !== null) profileId = project.shellProfile;
    return profileId;
  })();
  const activeAccount = getActiveAccount();
  const accountDistro = accountWslDistro(activeAccount);

  // A WSL-backed account holds both Claude and the projects inside the
  // distribution, so its sessions must run there whatever shell the settings
  // name — a Windows shell cannot even chdir into a POSIX project path.
  const requestedProfile = resolveShell(accountDistro ? 'wsl:' + accountDistro : effectiveProfileId);
  if (accountDistro && !isWslShell(requestedProfile.path)) {
    return { ok: false, error: `WSL distribution "${accountDistro}" is not available` };
  }
  const shellProfile = (!accountDistro && isWslShell(requestedProfile.path) && !isPlainTerminal)
    ? resolveShell('auto')
    : requestedProfile;
  const shell = shellProfile.path;
  const shellExtraArgs = [...(shellProfile.args || [])];
  const isWsl = isWslShell(shell);
  // --cd takes the path as the distribution sees it: already POSIX for a
  // WSL-backed project, /mnt/<drive>/… for one on a Windows volume. The spawn
  // cwd itself must stay a valid Windows path, for wsl.exe rather than for the
  // shell inside it.
  if (isWsl) {
    shellExtraArgs.unshift('--cd', isPosixAbsolutePath(projectPath) ? projectPath : windowsToWslPath(projectPath));
  }
  log.info(`[shell] profile=${shellProfile.id} shell=${shell} args=${JSON.stringify(shellExtraArgs)}`);

  let knownJsonlFiles = new Set();
  let sessionSlug = null;
  let projectFolder = null;

  if (!isPlainTerminal) {
    // Snapshot existing .jsonl files before spawning (for new session + fork/plan detection)
    projectFolder = encodeProjectPath(projectPath);
    const claudeProjectDir = path.join(getProjectsDir(activeAccount), projectFolder);
    if (fs.existsSync(claudeProjectDir)) {
      try {
        knownJsonlFiles = new Set(
          fs.readdirSync(claudeProjectDir).filter(f => f.endsWith('.jsonl'))
        );
      } catch {}
    }

    // Read slug from the session's jsonl file (for plan-accept detection)
    if (!isNew) {
      try {
        const jsonlPath = path.join(claudeProjectDir, sessionId + '.jsonl');
        const head = fs.readFileSync(jsonlPath, 'utf8').slice(0, 8000);
        const firstLines = head.split('\n').filter(Boolean);
        for (const line of firstLines) {
          const entry = JSON.parse(line);
          if (entry.slug) { sessionSlug = entry.slug; break; }
        }
      } catch {}
    }
  }

  let ptyProcess;
  let mcpServer = null;
  try {
    if (isPlainTerminal) {
      // Plain terminal: interactive login shell, no claude command
      // Inject a shell function to override `claude` with a helpful message
      const claudeShim = 'claude() { echo "\\033[33mTo start a Claude session, use the + button in the sidebar.\\033[0m"; return 1; }; export -f claude 2>/dev/null;';
      ptyProcess = pty.spawn(shell, shellArgs(shell, undefined, shellExtraArgs), {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: isWsl ? os.homedir() : projectPath,
        env: {
          ...cleanPtyEnv,
          TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.6.6', FORCE_COLOR: '3', ITERM_SESSION_ID: '1',
          CLAUDECODE: '1',
          // ZDOTDIR trick won't work reliably; instead inject via ENV (sh/bash) or precmd
          ENV: claudeShim,
          BASH_ENV: claudeShim,
        },
      });
      // For zsh, ENV/BASH_ENV don't apply — write the function after shell starts
      setTimeout(() => {
        if (!ptyProcess._isDisposed) {
          try {
            ptyProcess.write(claudeShim + ' clear\n');
          } catch {}
        }
      }, 300);
    } else {
      // Build claude command with session options
      let claudeCmd;
      if (sessionOptions?.forkFrom) {
        claudeCmd = `claude --resume "${sessionOptions.forkFrom}" --fork-session`;
      } else if (isNew) {
        claudeCmd = `claude --session-id "${sessionId}"`;
      } else {
        claudeCmd = `claude --resume "${sessionId}"`;
      }

      if (sessionOptions) {
        if (sessionOptions.dangerouslySkipPermissions) {
          claudeCmd += ' --dangerously-skip-permissions';
        } else if (sessionOptions.permissionMode) {
          claudeCmd += ` --permission-mode "${sessionOptions.permissionMode}"`;
        }
        if (sessionOptions.worktree) {
          // Ensure .claude/worktrees/ is in .gitignore so worktree dirs aren't tracked
          try {
            const gitignorePath = hostPath(projectJoin(projectPath, '.gitignore'));
            const entry = '.claude/worktrees/';
            let content = '';
            try { content = fs.readFileSync(gitignorePath, 'utf8'); } catch {}
            const lines = content.split('\n').map(l => l.trim());
            const alreadyCovered = lines.some(l => l === entry || l === '.claude/' || l === '.claude');
            if (!alreadyCovered) {
              const addition = (content.length && !content.endsWith('\n') ? '\n' : '') + entry + '\n';
              fs.appendFileSync(gitignorePath, addition, 'utf8');
            }
          } catch {}
          claudeCmd += ' --worktree';
          if (sessionOptions.worktreeName) {
            claudeCmd += ` "${sessionOptions.worktreeName}"`;
          }
        }
        if (sessionOptions.chrome) {
          claudeCmd += ' --chrome';
        }
        if (sessionOptions.addDirs) {
          const dirs = sessionOptions.addDirs.split(',').map(d => d.trim()).filter(Boolean);
          for (const dir of dirs) {
            claudeCmd += ` --add-dir "${dir}"`;
          }
        }
      }

      if (sessionOptions?.appendSystemPrompt) {
        // Write to a temp file and use shell substitution to avoid quoting issues.
        // The `cat` runs inside the distribution for a WSL session, so it needs
        // the /mnt/<drive>/… view of the Windows temp file.
        const tmpPrompt = path.join(os.tmpdir(), `switchboard-prompt-${sessionId}.md`);
        fs.writeFileSync(tmpPrompt, sessionOptions.appendSystemPrompt);
        const promptPathForShell = isWsl ? windowsToWslPath(tmpPrompt) : tmpPrompt;
        claudeCmd += ` --append-system-prompt "$(cat '${promptPathForShell}')"`;
      }

      // Subscribe this session to lifecycle hooks. `--settings` loads in
      // addition to the user's own settings files rather than replacing them,
      // so nothing the user owns is touched and there is no cleanup that has to
      // survive a crash. The temp file mirrors the --append-system-prompt
      // pattern above, including the /mnt/<drive>/… view a WSL session needs.
      try {
        const hooks = await hookServer();
        const hookUrl = hooks.urlFor(isWsl);
        if (hookUrl) {
          const tmpSettings = path.join(os.tmpdir(), `switchboard-hooks-${sessionId}.json`);
          fs.writeFileSync(tmpSettings, JSON.stringify(buildHookSettings({ url: hookUrl, token: hooks.token })));
          const settingsPathForShell = isWsl ? windowsToWslPath(tmpSettings) : tmpSettings;
          claudeCmd += ` --settings '${settingsPathForShell}'`;
        } else {
          // WSL with no reachable vEthernet address. Rather than hand the CLI a
          // URL that will time out on every event, leave the session on the OSC
          // fallback — SessionStatusTracker keeps honouring it while no hook
          // has ever arrived.
          log.warn(`[hooks] session=${sessionId} no reachable host address for WSL — falling back to OSC detection`);
        }
      } catch (err) {
        log.error(`[hooks] session=${sessionId} could not start hook server: ${err.message}`);
      }

      if (sessionOptions?.preLaunchCmd) {
        claudeCmd = sessionOptions.preLaunchCmd + ' ' + claudeCmd;
      }

      // Start MCP server for this session so Claude CLI sends diffs/file opens to Switchboard
      // (skip if user disabled IDE emulation in global settings)
      if (sessionOptions?.mcpEmulation !== false) {
        try {
          // From inside a distribution the CLI resolves the IDE host itself: it
          // reads `runningInWindows` from the lock file, takes the default
          // gateway from `ip route show` and TCP-probes it. So the workspace
          // folder is reported the way a Windows IDE would (UNC), and the
          // server binds somewhere that gateway actually reaches.
          mcpServer = await startMcpServer(sessionId, [hostPath(projectPath)], mainWindow, log, {
            runningInWindows: isWsl,
            // File paths arrive from the CLI in the distribution's own form.
            // Bound to the account this session was launched under: the session
            // keeps running across an account switch, and a diff arriving after
            // one must still resolve against its own distribution.
            hostPath: (p) => accountHostPath(activeAccount, p),
          });
          claudeCmd += ' --ide';
        } catch (err) {
          log.error(`[mcp] Failed to start MCP server for ${sessionId}: ${err.message}`);
        }
      }

      const ptyEnv = {
        ...cleanPtyEnv,
        TERM: 'xterm-256color', COLORTERM: 'truecolor',
        TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.6.6', FORCE_COLOR: '3', ITERM_SESSION_ID: '1',
      };
      // A WSL account's configDir is the Windows view of ~/.claude inside the
      // distribution — meaningless as CLAUDE_CONFIG_DIR there, where that home
      // is already the default. Setting it would point Claude at a path it
      // cannot resolve.
      if (activeAccount.id !== 'default' && !accountWslDistro(activeAccount)) {
        ptyEnv.CLAUDE_CONFIG_DIR = activeAccount.configDir;
      }
      if (mcpServer) {
        ptyEnv.CLAUDE_CODE_SSE_PORT = String(mcpServer.port);
      }
      // wsl.exe hands nothing but WSLENV-listed variables to the distribution,
      // so everything the CLI reads is named there explicitly — the IDE port,
      // and the terminal identification Claude checks before emitting OSC 9
      // notifications, which would otherwise be silently dropped at the
      // boundary. USERPROFILE is deliberately absent: the CLI only scans the
      // Windows %USERPROFILE%\.claude\ide for lock files while it is unset.
      if (isWsl) {
        Object.assign(ptyEnv, withWslEnv(ptyEnv, [
          'CLAUDE_CODE_SSE_PORT',
          'TERM', 'COLORTERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'FORCE_COLOR', 'ITERM_SESSION_ID',
        ]));
      }

      ptyProcess = pty.spawn(shell, shellArgs(shell, claudeCmd, shellExtraArgs), {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: isWsl ? os.homedir() : projectPath,
        // TERM_PROGRAM=iTerm.app: Claude Code checks this to decide whether to emit
        // OSC 9 notifications (e.g. "needs your attention"). Without it, the packaged
        // app's minimal Electron environment won't trigger those sequences.
        env: ptyEnv,
      });

    }
  } catch (err) {
    return { ok: false, error: `Error spawning PTY: ${err.message}` };
  }

  const session = {
    pty: ptyProcess, rendererAttached: true, exited: false,
    outputBuffer: [], outputBufferSize: 0, altScreen: false,
    projectPath, firstResize: true,
    projectFolder, knownJsonlFiles, sessionSlug,
    isPlainTerminal, isEphemeral, forkFrom: sessionOptions?.forkFrom || null,
    mcpServer, _openedAt: Date.now(),
  };
  activeSessions.set(sessionId, session);
  // The CLI is at its prompt, not mid-turn. Say so before any terminal output
  // can suggest otherwise — see SessionStatusTracker#seed.
  if (!isPlainTerminal) sessionStatus.seed(sessionId);

  ptyProcess.onData(data => {
    const currentId = session.realSessionId || sessionId;

    // Parse OSC sequences (title changes, progress, notifications, etc.)
    //
    // The PTY hands over arbitrary chunks, so a sequence can be split across
    // two of them. Matching per chunk dropped those silently — and since the
    // ✳ title was the only signal that could return a session to idle, one
    // unlucky split left a spinner running forever. Carry the trailing
    // fragment over to the next chunk instead.
    if (data.includes('\x1b]') || session._oscCarry) {
      const stream = (session._oscCarry || '') + data;
      session._oscCarry = '';
      const lastStart = stream.lastIndexOf('\x1b]');
      if (lastStart !== -1) {
        const tail = stream.slice(lastStart);
        // No terminator yet: hold it back, capped so a stream that never
        // terminates one cannot grow without bound.
        if (!tail.includes('\x07') && !tail.includes('\x1b\\')) {
          session._oscCarry = tail.length > 4096 ? '' : tail;
        }
      }
      const oscMatches = stream.matchAll(/\x1b\](\d+);([^\x07\x1b]*)(?:\x07|\x1b\\)/g);
      for (const m of oscMatches) {
        const code = m[1];
        const payload = m[2].slice(0, 120);
        // Detect Claude CLI busy state from OSC 0 title (spinner chars = busy, ✳ = idle)
        if (code === '0') {
          const firstChar = payload.charAt(0);
          const isBusy = firstChar.charCodeAt(0) >= 0x2800 && firstChar.charCodeAt(0) <= 0x28FF;
          const isIdle = firstChar === '\u2733'; // ✳
          log.debug(`[OSC 0] session=${currentId} char=U+${firstChar.charCodeAt(0).toString(16).toUpperCase()} busy=${isBusy} idle=${isIdle}`);
          // Fallback only, and the only fallback: unlike OSC 9;4 below, this
          // signal is symmetric — it can return a session to idle as well as
          // mark it busy. The tracker ignores it the moment a real hook
          // arrives for the session.
          if (isBusy) sessionStatus.applyOsc(currentId, true);
          else if (isIdle) sessionStatus.applyOsc(currentId, false);
        }
      }
      // Parse iTerm2 OSC 9 sequences (terminated by BEL \x07 or ST \x1b\\).
      // Same carried stream: an attention notification split across chunks was
      // being dropped for the same reason.
      const osc9Matches = stream.matchAll(/\x1b\]9;([^\x07\x1b]*)(?:\x07|\x1b\\)/g);
      for (const osc9 of osc9Matches) {
        const payload = osc9[1];
        // OSC 9;4 progress: 4;0; = clear/done, 4;1;N = running at N%, 4;2;N = error, 4;3; = indeterminate
        if (payload.startsWith('4;')) {
          const level = payload.split(';')[1];
          if (level === '0') continue; // 4;0 is also used for clearing, making it unreliable as an idle signal
          // Logged, not acted on. This branch can only ever *set* busy — 4;0
          // is documented as unreliable for the clear, so it is skipped above,
          // leaving no path back to idle. A session that emitted one of these
          // and then never took a turn stayed "In progress" forever, because
          // hooks are turn-scoped and had nothing to correct it with.
          // OSC 0 is the only symmetric fallback signal, so it is the only one.
          log.debug(`[OSC 9;4] session=${currentId} level=${level} payload="${payload}" (not used for status)`);
        } else {
          // Regular notification (attention, permission, etc.)
          log.info(`[OSC 9] session=${currentId} message="${payload}"`);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('terminal-notification', currentId, payload);
          }
        }
      }
    }

    // Standalone BEL (not part of an OSC sequence)
    if (data.includes('\x07') && !data.includes('\x1b]')) {
      log.info(`[BEL] session=${currentId}`);
    }

    // Track alternate screen mode (only if data contains the marker)
    if (data.includes('\x1b[?')) {
      if (data.includes('\x1b[?1049h') || data.includes('\x1b[?47h')) {
        session.altScreen = true;
        log.info(`[altscreen] session=${currentId} ON`);
      }
      if (data.includes('\x1b[?1049l') || data.includes('\x1b[?47l')) {
        session.altScreen = false;
        log.info(`[altscreen] session=${currentId} OFF`);
      }
    }

    // Buffer output (skip resize-triggered redraws for plain terminals)
    if (!session._suppressBuffer) {
      session.outputBuffer.push(data);
      session.outputBufferSize += data.length;
      while (session.outputBufferSize > MAX_BUFFER_SIZE && session.outputBuffer.length > 1) {
        session.outputBufferSize -= session.outputBuffer.shift().length;
      }
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal-data', currentId, data);
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    session.exited = true;
    // Clean up MCP server
    const mcpId = session.realSessionId || sessionId;
    shutdownMcpServer(mcpId);
    session.mcpServer = null;

    const realId = session.realSessionId || sessionId;
    // The old pipeline never cleared busy on exit — it left that to the
    // renderer's 3s poll, which only reaches sessions the sidebar has currently
    // rendered. A session that exited while its row was scrolled out kept its
    // spinner indefinitely.
    sessionStatus.remove(realId);
    if (realId !== sessionId) sessionStatus.remove(sessionId);
    try { fs.unlinkSync(path.join(os.tmpdir(), `switchboard-hooks-${sessionId}.json`)); } catch {}
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('process-exited', realId, exitCode);
      // If a fork/plan-accept transition re-keyed this session under realId
      // but the PTY exited before transition detection ran, also notify the
      // renderer for the original sessionId so it doesn't stay stuck as "Running".
      if (realId !== sessionId && activeSessions.has(sessionId)) {
        mainWindow.webContents.send('process-exited', sessionId, exitCode);
      }
    }
    activeSessions.delete(realId);
    // Clean up the original key too in case transition detection hasn't run yet
    activeSessions.delete(sessionId);
  });

  if (sessionOptions?.forkFrom) {
    log.info(`[fork-spawn] tempId=${sessionId} forkFrom=${sessionOptions.forkFrom} folder=${projectFolder} knownFiles=${knownJsonlFiles.size}`);
  }

  return { ok: true, reattached: false, mcpActive: !!mcpServer };
});

// --- IPC: terminal-input (fire-and-forget) ---
ipcMain.on('terminal-input', (_event, sessionId, data) => {
  // An SDK session takes whole prompts, not keystrokes: there is no terminal
  // to echo into and no line discipline to run. The renderer's composer sends
  // one message per submit.
  if (sdkSession.isSdkSession(sessionId)) {
    sdkSession.sendSdkInput(sessionId, data);
    return;
  }
  const session = activeSessions.get(sessionId);
  if (session && !session.exited) {
    session.pty.write(data);
  }
});

// --- IPC: sdk-interrupt ---
// The Escape key of an SDK session: stops the turn, keeps the session.
ipcMain.handle('sdk-interrupt', async (_event, sessionId) => {
  return sdkSession.interruptSdkSession(sessionId);
});

// --- IPC: sdk-set-permission-mode ---
ipcMain.handle('sdk-set-permission-mode', async (_event, sessionId, mode) => {
  return sdkSession.setSdkPermissionMode(sessionId, mode);
});

// --- IPC: terminal-resize (fire-and-forget) ---
ipcMain.on('terminal-resize', (_event, sessionId, cols, rows) => {
  const session = activeSessions.get(sessionId);
  if (session && !session.exited) {
    // For plain terminals, suppress buffering during resize to avoid
    // accumulating prompt redraws that pollute reattach replay
    if (session.isPlainTerminal) session._suppressBuffer = true;

    session.pty.resize(cols, rows);

    if (session.isPlainTerminal) {
      setTimeout(() => { session._suppressBuffer = false; }, 200);
    }

    // First resize: nudge to force TUI redraw on reattach (skip for plain terminals — causes duplicate prompts)
    if (session.firstResize && !session.isPlainTerminal) {
      session.firstResize = false;
      setTimeout(() => {
        try {
          session.pty.resize(cols + 1, rows);
          setTimeout(() => {
            try { session.pty.resize(cols, rows); } catch {}
          }, 50);
        } catch {}
      }, 50);
    }
  }
});

// --- IPC: close-terminal ---
ipcMain.on('close-terminal', (_event, sessionId) => {
  // Closing the view does not end an SDK session, exactly as it does not kill
  // a PTY: stop-session is what ends either of them.
  if (sdkSession.isSdkSession(sessionId)) return;
  const session = activeSessions.get(sessionId);
  if (session) {
    session.rendererAttached = false;
    if (session.exited) {
      activeSessions.delete(sessionId);
    }
  }
});

// Session transitions → session-transitions.js
const sessionTransitions = require('./session-transitions');
sessionTransitions.init({
  PROJECTS_DIR: activeProjectsDir(), activeSessions, getMainWindow: () => mainWindow, log,
  // A fork or a plan-accept gives the session a new UUID. The tracker has to
  // follow it, or it keeps reporting under an id the renderer has retired —
  // and the hooks arriving from the forked CLI would open a second entry.
  rekeyMcpServer: (oldId, newId) => {
    rekeyMcpServer(oldId, newId);
    sessionStatus.rekey(oldId, newId);
  },
});
const { detectSessionTransitions } = sessionTransitions;

// --- fs.watch on projects directory ---
let projectsWatcher = null;
let projectsPoller = null;

// How often the polling fallback sweeps the projects directory. Only used when
// a recursive fs.watch cannot be trusted — see startProjectsWatcher.
const PROJECTS_POLL_MS = 5000;

// A WSL account's projects directory is reached over the 9p share, which does
// not deliver Windows change notifications: fs.watch there succeeds and then
// stays silent, so the absence of events is not something we can detect. Sweep
// folder mtimes instead, reusing the same signal the incremental cache uses.
function startProjectsPolling(watchDir, queueFolder) {
  const { getFolderIndexMtimeMs } = require('./folder-index-state');
  let previous = null;
  let warnedSlow = false;

  const sweep = () => {
    const startedAt = Date.now();
    const current = new Map();
    let entries;
    try {
      entries = fs.readdirSync(watchDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '.git') continue;
      current.set(entry.name, getFolderIndexMtimeMs(path.join(watchDir, entry.name)));
    }

    if (previous) {
      for (const [folder, mtime] of current) {
        if (previous.get(folder) !== mtime) queueFolder(folder);
      }
      for (const folder of previous.keys()) {
        if (!current.has(folder)) queueFolder(folder);
      }
    }
    previous = current;

    // The per-folder cost over 9p is the open question here; report it once
    // instead of assuming the interval is comfortable.
    const elapsed = Date.now() - startedAt;
    if (!warnedSlow && elapsed > PROJECTS_POLL_MS / 2) {
      warnedSlow = true;
      log.warn(`[watcher] polling sweep of ${current.size} folders took ${elapsed}ms (interval ${PROJECTS_POLL_MS}ms)`);
    }
  };

  // The seeding sweep is deferred rather than run inline: it stats every folder
  // over the 9p share, and startProjectsWatcher is called during app startup.
  setTimeout(sweep, 0);
  return setInterval(sweep, PROJECTS_POLL_MS);
}

function startProjectsWatcher() {
  const watchDir = activeProjectsDir();
  if (!fs.existsSync(watchDir)) return;

  const pendingFolders = new Set();
  let debounceTimer = null;

  function flushChanges() {
    debounceTimer = null;
    const folders = new Set(pendingFolders);
    pendingFolders.clear();

    let changed = false;
    for (const folder of folders) {
      const folderPath = path.join(watchDir, folder);
      if (fs.existsSync(folderPath)) {
        detectSessionTransitions(folder);
        refreshFolder(folder);
      } else {
        deleteCachedFolder(folder, getActiveAccount().id);
      }
      changed = true;
    }

    if (changed) {
      notifyRendererProjectsChanged();
    }
  }

  function queueFolder(folder) {
    if (!folder || folder === '.git') return;
    pendingFolders.add(folder);
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flushChanges, 500);
  }

  if (activeWslDistro()) {
    projectsPoller = startProjectsPolling(watchDir, queueFolder);
    log.info(`[watcher] WSL-backed account: polling ${watchDir} every ${PROJECTS_POLL_MS}ms`);
    return;
  }

  try {
    projectsWatcher = fs.watch(watchDir, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;

      // filename is relative, e.g. "folder-name/sessions-index.json" or "folder-name/abc.jsonl"
      const parts = filename.split(path.sep);
      const folder = parts[0];

      // Only care about .jsonl changes or top-level folder add/remove
      const basename = parts[parts.length - 1];
      if (parts.length !== 1 && !basename.endsWith('.jsonl')) return;

      queueFolder(folder);
    });

    projectsWatcher.on('error', (err) => {
      console.error('Projects watcher error:', err);
      if (!projectsPoller) projectsPoller = startProjectsPolling(watchDir, queueFolder);
    });
  } catch (err) {
    console.error('Failed to start projects watcher:', err);
    projectsPoller = startProjectsPolling(watchDir, queueFolder);
  }
}

function restartProjectsWatcher() {
  if (projectsWatcher) {
    projectsWatcher.close();
    projectsWatcher = null;
  }
  if (projectsPoller) {
    clearInterval(projectsPoller);
    projectsPoller = null;
  }
  startProjectsWatcher();
}

// --- IPC: app version ---
ipcMain.handle('get-app-version', () => app.getVersion());

// --- IPC: auto-updater ---
ipcMain.handle('updater-check', () => {
  if (!autoUpdater) return { available: false, dev: true };
  return autoUpdater.checkForUpdates();
});
ipcMain.handle('updater-download', () => {
  if (!autoUpdater) return;
  return autoUpdater.downloadUpdate();
});
ipcMain.handle('updater-install', () => {
  if (!autoUpdater) return;
  autoUpdater.quitAndInstall();
});

// --- App lifecycle ---
app.whenReady().then(() => {
  buildMenu();
  createWindow();
  startProjectsWatcher();

  // Both schedule modules resolve their directories per call, so schedules
  // follow the active account instead of the Windows home, and project paths
  // recorded inside a distribution are translated before any fs call. This has
  // to happen before the first use below, which writes the creator command.
  const scheduleDirs = {
    getProjectsDir: () => activeProjectsDir(),
    getCommandsDir: () => path.join(activeConfigDir(), 'commands'),
    hostPath,
    projectJoin,
  };
  scheduleIpc.configure(scheduleDirs);
  require('./schedule-runner').configure(scheduleDirs);

  scheduleIpc.ensureScheduleCreatorCommand();

  // Shared runCommand for both cron scheduler and manual "run now"
  const { spawn: cpSpawn } = require('child_process');
  function runScheduleCommand(cmd, cwd, name, onDone) {
    const globalSettings = getSetting('global') || {};
    const profileId = globalSettings.shellProfile || SETTING_DEFAULTS.shellProfile;
    // A scheduled command belongs to its project, so one in a distribution runs
    // there — the shell setting cannot chdir into a POSIX path from Windows.
    const distro = activeWslDistro();
    const inWsl = Boolean(distro) && isPosixAbsolutePath(cwd);
    const profile = resolveShell(inWsl ? 'wsl:' + distro : profileId);
    const shell = profile.path;
    const extraArgs = [...(profile.args || [])];
    if (inWsl) extraArgs.unshift('--cd', cwd);
    const args = shellArgs(shell, cmd, extraArgs);

    log.info(`[schedule] Running: ${shell} ${args.join(' ')}`);
    const child = cpSpawn(shell, args, {
      cwd: inWsl ? os.homedir() : cwd,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...cleanPtyEnv, FORCE_COLOR: '0' },
    });

    let stderr = '';
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('exit', (code) => {
      if (stderr.trim()) log.error(`[schedule] ${name} stderr:\n${stderr.trim()}`);
      log.info(`[schedule] ${name} finished (exit ${code})`);
      if (onDone) onDone();
    });

    child.on('error', (err) => {
      log.error(`[schedule] ${name} error:`, err.message);
      if (onDone) onDone();
    });
  }

  scheduleIpc.init(log, runScheduleCommand);
  startScheduler(log, runScheduleCommand);

  // Re-index search if FTS table was recreated (e.g. tokenizer config change)
  if (searchFtsRecreated) populateCacheViaWorker();

  // Check for updates after launch
  if (autoUpdater) {
    setTimeout(() => autoUpdater.checkForUpdates().catch(e => log.error('[updater] check failed:', e?.message || String(e))), 5000);
    // Re-check every 4 hours for long-running sessions
    setInterval(() => autoUpdater.checkForUpdates().catch(e => log.error('[updater] check failed:', e?.message || String(e))), 4 * 60 * 60 * 1000);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  // Shut down all MCP servers
  shutdownAllMcp();
  stopHookServer();
  sdkSession.stopAllSdkSessions();

  // Close filesystem watcher
  if (projectsWatcher) {
    projectsWatcher.close();
    projectsWatcher = null;
  }


  // Kill all PTY processes on quit
  for (const [, session] of activeSessions) {
    if (!session.exited) {
      try { session.pty.kill(); } catch {}
    }
  }
});

// Close SQLite after all windows are closed to avoid "connection is not open" errors
app.on('will-quit', () => {
  closeDb();
});
