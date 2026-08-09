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
const { fetchAndTransformUsage } = require('./claude-auth');
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
  wslToWindowsPath, isPosixAbsolutePath, probeWslClaudeHome, probeWslClaudeDir,
  discoverWslClaudeHomes, defaultClaudePosix, wslExecArgs,
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
  getMeta, getAllMeta, toggleStar, setName, setArchived,
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

// A WSL account attached before a distribution could hold more than one carries
// no `wslClaudePosix`: it is the distribution's default home by construction.
// Filling it in here means one shape reaches every reader, main and renderer
// alike, and the field is written back the next time accounts are saved.
function withWslClaudePosix(account) {
  if (!account.wslDistro || account.wslClaudePosix || !account.wslHome) return account;
  return { ...account, wslClaudePosix: defaultClaudePosix(account.wslHome) };
}

// Nothing stored at all is a fresh install, which starts on the local Claude
// home. A stored list is taken exactly as it stands — the default account is
// deletable like any other, and re-adding it here would quietly undo that.
function getAccounts() {
  const stored = getSetting('accounts');
  if (!Array.isArray(stored) || stored.length === 0) return [DEFAULT_ACCOUNT];
  return stored.map(withWslClaudePosix);
}

// The first account is the fallback rather than the default one, which may have
// been removed. getAccounts() never answers empty, so this always resolves.
function getActiveAccount() {
  const accounts = getAccounts();
  const activeId = (getSetting('global') || {}).activeAccountId || 'default';
  return accounts.find(a => a.id === activeId) || accounts[0];
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

// The POSIX config directory to hand the CLI for a WSL account, or null when
// there is nothing to say. A distribution resolves its own ~/.claude without
// being told, so only a sibling directory — a second Claude account inside the
// same distribution — has to be named. The account's `configDir` is the Windows
// view of that directory and means nothing inside the distribution, which is why
// it is never what crosses the boundary.
function accountWslConfigEnv(account) {
  const claudePosix = account && account.wslClaudePosix;
  if (!accountWslDistro(account) || !claudePosix || !account.wslHome) return null;
  return claudePosix === defaultClaudePosix(account.wslHome) ? null : claudePosix;
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

// --- Single-instance: parse --project <path> from argv ---
function parseProjectArg(argv) {
  const idx = argv.indexOf('--project');
  if (idx !== -1 && argv[idx + 1]) return argv[idx + 1];
  return null;
}

// Send to the renderer, waiting for the page when it has not finished loading yet —
// a message sent before that has no listener on the other side and is simply lost.
function sendToRenderer(channel, ...args) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const contents = mainWindow.webContents;
  const send = () => { try { contents.send(channel, ...args); } catch {} };
  if (contents.isLoading()) contents.once('did-finish-load', send);
  else send();
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    // The window may be hidden in the tray rather than merely minimised, or gone
    // altogether while the app lives on, and a second launch is the clearest possible
    // request to see it — so this must not be conditional on a window existing.
    showMainWindow();
    const projectPath = parseProjectArg(argv);
    if (projectPath) sendToRenderer('launch-project-session', projectPath);
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

// The window floor the app shipped with, i.e. the smallest frame the layout was
// drawn for at 100%. Page zoom makes a window of a given size worth fewer CSS
// pixels, so the floor has to grow with the interface scale — at 150% an 800 px
// window is 533 CSS px, which cannot hold the 340 px sidebar and a terminal
// beside it.
const MIN_WINDOW_WIDTH = 800;
const MIN_WINDOW_HEIGHT = 500;

// Same clamp as the renderer and the preload bridge, which keeps its own copy of the
// limits — a sandboxed preload can only require Electron and Node built-ins, not a
// shared module. A stored value that has been hand-edited must not be able to demand
// a window nobody can fit on screen, and a value that is not a usable number means
// no scaling at all.
function clampUiScaleFactor(factor) {
  const n = Number(factor);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(1.5, Math.max(0.8, n));
}

// Settings store the scale as a percentage; a missing or empty key means no scaling.
function uiScaleFactorFromPercent(percent) {
  if (percent == null || percent === '') return 1;
  return clampUiScaleFactor(Number(percent) / 100);
}

// The scale currently reflected in the window minimum, so a display change can
// recompute the floor without waiting for the renderer to ask again.
let uiScaleMinimumFactor = 1;

// Set when a scale bump grew the window mid-session: remembers the size the user
// had, so dropping the scale again — or cancelling a preview — can put it back.
// Cleared as soon as the user resizes the window themselves; the grown size is
// theirs then. Growth at window creation is deliberately not recorded: there is no
// user action to undo, and the size the window opened at is the size it has had all
// session, so shrinking it later would come out of nowhere.
let scaleGrowth = null;
let displayWatchInstalled = false;

// Window sizes are device-independent pixels, which is what the scale multiplies.
// Capped at the work area of the display the window is on: a minimum larger than
// the screen leaves a window that cannot be resized at all. `reference` names that
// display before the window exists, e.g. a restored position on a second monitor.
function minimumWindowSize(factor, reference) {
  const rect = reference
    || (mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : null);
  const display = rect ? screen.getDisplayMatching(rect) : screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;
  return {
    width: Math.min(Math.round(MIN_WINDOW_WIDTH * factor), width),
    height: Math.min(Math.round(MIN_WINDOW_HEIGHT * factor), height),
  };
}

// Keeps a rectangle inside the work area of the display it sits on. Growing a
// window to a new minimum moves its far edge, which without this pushes the window
// off screen instead of just making it bigger.
function fitBoundsToWorkArea(rect) {
  const area = screen.getDisplayMatching(rect).workArea;
  const width = Math.min(rect.width, area.width);
  const height = Math.min(rect.height, area.height);
  return {
    width,
    height,
    x: Math.round(Math.min(Math.max(rect.x, area.x), area.x + area.width - width)),
    y: Math.round(Math.min(Math.max(rect.y, area.y), area.y + area.height - height)),
  };
}

// Applies the floor for a given scale to the live window: grows it when it sits
// under the floor, and shrinks it back once the floor drops again while the window
// is still exactly the size we grew it to.
function applyWindowMinimum(factor) {
  if (!mainWindow || mainWindow.isDestroyed()) return null;

  const minimum = minimumWindowSize(factor);
  mainWindow.setMinimumSize(minimum.width, minimum.height);

  // The bounds of a minimised, maximised or full-screen window are not a size the
  // user picked, so leave them alone — the minimum applies again on restore.
  if (mainWindow.isMinimized() || mainWindow.isMaximized() || mainWindow.isFullScreen()) {
    return minimum;
  }

  const b = mainWindow.getBounds();
  if (scaleGrowth && (b.width !== scaleGrowth.width || b.height !== scaleGrowth.height)) {
    scaleGrowth = null;
  }

  if (b.width < minimum.width || b.height < minimum.height) {
    const before = scaleGrowth ? scaleGrowth.before : { width: b.width, height: b.height };
    mainWindow.setBounds(fitBoundsToWorkArea({
      ...b,
      width: Math.max(b.width, minimum.width),
      height: Math.max(b.height, minimum.height),
    }));
    const grown = mainWindow.getBounds();
    scaleGrowth = { before, width: grown.width, height: grown.height };
  } else if (scaleGrowth) {
    const width = Math.max(scaleGrowth.before.width, minimum.width);
    const height = Math.max(scaleGrowth.before.height, minimum.height);
    // Only when the floor has actually dropped far enough to give the size back.
    // Without this test, being called again at the same scale — a save right after
    // a preview, or a display-metrics event — resizes to the size the window
    // already has and forgets what it was grown from.
    if (width !== b.width || height !== b.height) {
      mainWindow.setBounds(fitBoundsToWorkArea({ ...b, width, height }));
      scaleGrowth = null;
    }
  }
  return minimum;
}

// A display change can leave the floor larger than the screen the window is now on
// — undocking from a big monitor — which makes the window unresizable and strands
// part of it off screen. Recompute it from the scale currently in effect.
function watchDisplayChanges() {
  if (displayWatchInstalled) return;
  displayWatchInstalled = true;
  const recompute = () => applyWindowMinimum(uiScaleMinimumFactor);
  screen.on('display-added', recompute);
  screen.on('display-removed', recompute);
  screen.on('display-metrics-changed', recompute);
}

function createWindow() {
  // Restore saved window bounds
  const globalSettings = getSetting('global');
  const savedBounds = globalSettings?.windowBounds;
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

  // Bounds saved at a smaller scale can be under the floor the current scale
  // needs; widen them here rather than opening a window the user cannot restore
  // to its own size once they touch the frame.
  uiScaleMinimumFactor = uiScaleFactorFromPercent(globalSettings?.uiScale);
  const minimum = minimumWindowSize(
    uiScaleMinimumFactor,
    restorePosition ? { ...restorePosition, width: bounds.width, height: bounds.height } : null,
  );
  const grownByFloor = bounds.width < minimum.width || bounds.height < minimum.height;
  bounds.width = Math.max(bounds.width, minimum.width);
  bounds.height = Math.max(bounds.height, minimum.height);

  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: minimum.width,
    minHeight: minimum.height,
    title: 'Wooton Pad',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Closing hides the window while a tray icon exists — sessions keep running and
  // the app is reached from the tray. Conditional on the tray actually existing:
  // on a desktop with no status-notifier host there would be nothing left to click,
  // and the window would be gone for good.
  mainWindow.on('close', (event) => {
    if (isQuitting || !trayIcon.isTrayActive()) return;
    event.preventDefault();
    mainWindow.hide();
  });

  // The alert for the session on screen is cleared by the renderer; coming back to
  // the window is the other half of that, since the user is now looking at it.
  mainWindow.on('focus', () => clearSessionAttention(viewedSessionId));

  // Set position after creation to prevent macOS from clamping size
  if (restorePosition) {
    const restored = { ...restorePosition, width: bounds.width, height: bounds.height };
    // Re-clamp only when the floor grew the window: an untouched restore keeps the
    // slack the on-screen check above deliberately allows.
    mainWindow.setBounds(grownByFloor ? fitBoundsToWorkArea(restored) : restored);
  }

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

  watchDisplayChanges();
}

// Keeps the window's floor in step with the interface scale, including while the
// settings slider is only previewing — so what the preview shows is what saving
// gives, and cancelling gives the window back. Growing is deliberate: a window
// already under the new floor cannot be dragged back to the size it currently has,
// which reads as a bug.
ipcMain.handle('set-ui-scale-minimum', (_event, factor) => {
  uiScaleMinimumFactor = clampUiScaleFactor(factor);
  return applyWindowMinimum(uiScaleMinimumFactor);
});

// --- Tray ---------------------------------------------------------------------
const trayIcon = require('./tray');

// Which session the renderer is showing, so an alert about the session the user is
// already watching does not light the tray up.
let viewedSessionId = null;

// Same classification the renderer applies to an OSC 9 message (public/app.js), for
// the four shapes the CLI emits: attention, plan approval, tool permission, and
// entering plan mode.
const ATTENTION_MESSAGE = /attention|approval|permission|needs your|wants to enter/i;

let isQuitting = false;

function trayEnabledSetting() {
  const value = getSetting('global')?.showTray;
  return value === undefined || value === null ? true : !!value;
}

// True only while the user can actually see the session in question.
function isWatchingSession(sessionId) {
  return sessionId === viewedSessionId
    && !!mainWindow && !mainWindow.isDestroyed()
    && mainWindow.isVisible() && mainWindow.isFocused();
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

function traySnapshot() {
  const attention = [];
  const busy = [];
  // A re-keyed session replaces its old entry in activeSessions, so every session
  // appears exactly once here, under the id the renderer also knows it by.
  for (const [key, session] of activeSessions) {
    if (session.exited) continue;
    const sessionId = session.realSessionId || key;
    const entry = { sessionId, projectPath: session.projectPath, sessionSlug: session.sessionSlug };
    if (session._attention) attention.push(entry);
    else if (session._cliBusy) busy.push(entry);
  }
  return { attention, busy, accounts: getAccounts(), usage: accountsUsageSnapshot() };
}

function refreshTray() {
  if (!trayIcon.isTrayActive()) return;
  const state = traySnapshot();
  trayIcon.updateTray(state);
  // macOS and Unity; a no-op on Windows, where the equivalent is an overlay icon.
  try { app.setBadgeCount(state.attention.length); } catch {}
}

// A session the CLI has asked something of is marked on the session object itself
// rather than in a set of ids: a fork or plan-accept re-keys the session under a new
// id, and a mark carried by the object survives that on its own. The mark is kept
// here rather than in the renderer, which keeps its own set for the sidebar, because
// the tray has to be right exactly when the window is hidden and the renderer is not
// being looked at.
function noteSessionNotification(session, sessionId, message) {
  if (!ATTENTION_MESSAGE.test(message) || isWatchingSession(sessionId)) return;
  session._attention = true;
  refreshTray();
}

function clearSessionAttention(sessionId) {
  if (!sessionId) return;
  // Either id resolves: activeSessions is keyed by the temporary id until a fork or
  // plan-accept re-keys it, and by the real one afterwards.
  const session = activeSessions.get(sessionId);
  if (!session?._attention) return;
  session._attention = false;
  refreshTray();
}

function startTray() {
  const created = trayIcon.createTray({
    onShow: showMainWindow,
    onQuit: () => { isQuitting = true; app.quit(); },
    onFocusSession: (sessionId) => {
      showMainWindow();
      clearSessionAttention(sessionId);
      sendToRenderer('focus-session', sessionId);
    },
  });
  if (created) {
    refreshTray();
    startUsagePolling();
  } else {
    log.warn('[tray] no tray icon could be created; the window will keep closing to quit');
    // Deferred while the page is still loading: the tray is started during
    // whenReady, before the renderer has a listener for this.
    sendToRenderer(
      'status-update',
      'No tray icon available on this desktop — closing the window still quits',
      'warn',
    );
  }
  return created;
}

function stopTray() {
  trayIcon.destroyTray();
  stopUsagePolling();
  try { app.setBadgeCount(0); } catch {}
}

// The renderer reports which session it is showing; that is also the moment its own
// attention marker is cleared, so the two stay in step.
ipcMain.on('session-viewed', (_event, sessionId) => {
  viewedSessionId = sessionId || null;
  clearSessionAttention(sessionId);
});

ipcMain.handle('set-tray-enabled', (_event, enabled) => {
  if (enabled) {
    if (!trayIcon.isTrayActive()) startTray();
  } else {
    stopTray();
  }
  return trayIcon.isTrayActive();
});

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

    // Clean up DB cache and search index for this folder. The cache is keyed by
    // account, and deleteCachedFolder defaults its second argument to 'default'
    // — so leaving it off deleted another account's row and kept the one being
    // hidden, which then still answered searches. The search index itself has no
    // account column, so it is folder-wide by construction.
    const folder = encodeProjectPath(projectPath);
    deleteCachedFolder(folder, getActiveAccount().id);
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
      const [file, args, options] = projectExecFile(
        ['claude', '-p', prompt, '--no-session-persistence'], projectPath, {}
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

ipcMain.handle('get-project-sessions', (_event, projectPath) => {
  try {
    const { buildProjectsFromCache } = require('./session-cache');
    const projects = buildProjectsFromCache(false);
    const proj = projects.find(p => p.projectPath === projectPath);
    const sessions = (proj?.sessions || []).slice(0, 10).map(s => ({
      id: s.sessionId, name: s.name || s.aiTitle || s.summary?.slice(0, 40) || s.sessionId?.slice(0, 8), updatedAt: s.modified, running: false,
    }));
    return { ok: true, sessions };
  } catch (e) { return { ok: false, sessions: [] }; }
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

// --- IPC: get-stats ---
ipcMain.handle('get-stats', () => {
  const activeAccount = getActiveAccount();
  const dbStats = computeStatsFromDb(activeAccount.id);
  try {
    const statsPath = path.join(activeConfigDir(), 'stats-cache.json');
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
});

// --- IPC: refresh-stats (run /stats + /usage via PTY) ---
ipcMain.handle('refresh-stats', async () => {
  // For stats, use the configured shell profile — unless the account lives in a
  // distribution, in which case that is where its `claude` binary and its
  // credentials are, and a Windows shell could reach neither.
  const globalSettings = getSetting('global') || {};
  const statsDistro = activeWslDistro();
  const statsWslConfigEnv = accountWslConfigEnv(getActiveAccount());
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
  };
  // For a WSL account the Windows configDir is meaningless inside the
  // distribution, so what crosses is the POSIX directory — and only for an
  // account that is not the distribution's default Claude home.
  //
  // Deleted rather than merely left unset: cleanPtyEnv is a copy of the app's own
  // environment, so a CLAUDE_CONFIG_DIR the user happened to export before
  // launching would otherwise survive here and outrank the active account. For a
  // WSL session it is worse than wrong — WSLENV names it below, so a Windows path
  // would cross into a distribution that cannot resolve it at all.
  delete ptyEnv.CLAUDE_CONFIG_DIR;
  const statsConfigEnv = statsDistro
    ? statsWslConfigEnv
    : (configDir !== DEFAULT_CLAUDE_DIR ? configDir : null);
  if (statsConfigEnv) ptyEnv.CLAUDE_CONFIG_DIR = statsConfigEnv;
  if (statsInWsl) {
    Object.assign(ptyEnv, withWslEnv(ptyEnv, [
      'CLAUDE_CONFIG_DIR',
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

// --- IPC: get-usage (lightweight, API-only, no PTY) ---
ipcMain.handle('get-usage', async () => {
  const cacheKey = 'usage:' + getActiveAccount().id;
  try {
    const usage = await fetchAndTransformUsage(activeConfigDir()) || {};
    if (!usage._error && !usage._rateLimited && Object.keys(usage).length) {
      setSetting(cacheKey, usage);
      return usage;
    }
    const cached = getSetting(cacheKey);
    return cached ? { ...cached, _cached: true } : usage;
  } catch (err) {
    log.error('Error fetching usage:', err);
    const cached = getSetting(cacheKey);
    return cached ? { ...cached, _cached: true } : {};
  }
});

// --- IPC: get-cached-usage (DB-only, no Keychain/API access) ---
ipcMain.handle('get-cached-usage', () => {
  const cacheKey = 'usage:' + getActiveAccount().id;
  const cached = getSetting(cacheKey);
  return cached ? { ...cached, _cached: true } : {};
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

// --- IPC: read-memory ---
ipcMain.handle('read-memory', (_event, filePath) => {
  try {
    const resolved = path.resolve(hostPath(filePath));
    // Allow paths under the active account's Claude home, or any .md that exists
    if (!resolved.endsWith('.md')) return '';
    if (!resolved.startsWith(activeConfigDir()) && !fs.existsSync(resolved)) return '';
    return fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    console.error('Error reading memory file:', err);
    return '';
  }
});

// --- IPC: save-memory ---
ipcMain.handle('save-memory', (_event, filePath, content) => {
  try {
    const resolved = path.resolve(hostPath(filePath));
    if (!resolved.endsWith('.md')) return { ok: false, error: 'not a .md file' };
    if (!fs.existsSync(resolved)) return { ok: false, error: 'file does not exist' };
    fs.writeFileSync(resolved, content, 'utf8');
    return { ok: true };
  } catch (err) {
    console.error('Error saving memory file:', err);
    return { ok: false, error: err.message };
  }
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
  // The default account is no longer forced back into the list — an install
  // running everything inside WSL is allowed not to have one. What is not
  // allowed is an empty list, which would leave the app with nothing to show.
  if (!Array.isArray(accounts) || accounts.length === 0) {
    return { ok: false, error: 'At least one account is required' };
  }
  setSetting('accounts', accounts);
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

// Claude homes reachable inside WSL, for the "add account" UI. One entry per
// config directory, so a distribution holding several accounts contributes one
// row each rather than only its default home.
ipcMain.handle('discover-wsl-claude-homes', async () => {
  try { return await discoverWslClaudeHomes(); } catch { return []; }
});

// Installed distributions, so a config directory discovery cannot see — one
// outside $HOME, or one Claude has not written a projects/ into yet — can still
// be named by hand. Read off the cached shell profiles rather than by calling
// listWslDistros() again: that is a *synchronous* `wsl.exe --list` with a five
// second timeout, and the renderer asks for this alongside
// discover-wsl-claude-homes, which runs the same exec of its own. Two blocking
// child processes on the main process freeze every terminal in the window.
ipcMain.handle('list-wsl-distros', () => {
  try {
    return getShellProfiles()
      .filter(p => p.id.startsWith('wsl:'))
      .map(p => p.id.slice('wsl:'.length));
  } catch { return []; }
});

// The account already attached to a config directory inside a distribution, if
// there is one. Identity is the directory rather than the distribution: several
// Claude accounts can live in one distribution, told apart only by which config
// directory they read.
function findWslAccount(distro, claudePosix) {
  return getAccounts().find(a => a.wslDistro === distro && a.wslClaudePosix === claudePosix);
}

// A second account in the same distribution needs a name that says which one it
// is; the default home keeps the plain distribution name it has always had.
function wslAccountName(probe) {
  return probe.isDefault
    ? `WSL — ${probe.distro}`
    : `WSL — ${probe.distro} (${probe.claudePosix.split('/').pop()})`;
}

// Attach an account to a Claude home inside a WSL distribution. `claudePosix`
// names which config directory; without it the distribution's default ~/.claude
// is used, which is what the single-account form of this call always meant.
ipcMain.handle('create-wsl-account', async (_event, distro, name, claudePosix) => {
  // Re-attaching a directory already known costs no exec, which is what the UI
  // does every time the accounts list is redrawn behind a stale button.
  if (claudePosix) {
    const known = findWslAccount(distro, claudePosix);
    if (known) return known;
  }
  const probe = claudePosix
    ? await probeWslClaudeDir(distro, claudePosix)
    : await probeWslClaudeHome(distro);
  if (!probe) {
    return {
      error: claudePosix
        ? `No directory "${claudePosix}" in WSL distribution "${distro}"`
        : `No reachable Claude home in WSL distribution "${distro}"`,
    };
  }
  const existing = findWslAccount(probe.distro, probe.claudePosix);
  if (existing) return existing;

  const { randomUUID } = require('crypto');
  const id = 'wsl-' + randomUUID().replace(/-/g, '').slice(0, 12);
  const account = {
    id,
    name: name || wslAccountName(probe),
    configDir: probe.configDir,
    wslDistro: probe.distro,
    wslUncPrefix: probe.uncPrefix,
    wslHome: probe.home,
    // What CLAUDE_CONFIG_DIR has to say inside the distribution. `configDir`
    // above is the Windows view of this same directory and cannot stand in for
    // it — the distribution has no idea what a UNC path is.
    wslClaudePosix: probe.claudePosix,
  };
  setSetting('accounts', [...getAccounts(), account]);
  return account;
});

ipcMain.handle('rename-account', (_event, id, name) => {
  const updated = getAccounts().map(a => a.id === id ? { ...a, name } : a);
  setSetting('accounts', updated);
  return { ok: true };
});

// Any account can go, including the default one — an install that only ever
// uses Claude inside WSL has no reason to keep a Windows home it never opens.
// The one thing that cannot happen is having nothing to look at, so the last
// account stays. Only the settings row is removed; no Claude directory on disk
// is touched, and re-attaching the same directory brings the sessions back.
ipcMain.handle('delete-account', (_event, id) => {
  // Read before the list shrinks, and through getActiveAccount() rather than off
  // the stored id: that id can name an account that is not there, in which case
  // the account actually in effect is the first survivor — and that is the id the
  // renderer is holding, so it is the one the answer has to be comparable with.
  const activeId = getActiveAccount().id;
  const remaining = getAccounts().filter(a => a.id !== id);
  if (!remaining.length) {
    return { ok: false, error: 'The last account cannot be removed' };
  }
  setSetting('accounts', remaining);

  // Deleting the account on screen would otherwise leave every per-account
  // directory pointing at one that no longer exists.
  if (activeId === id) {
    activateAccount(remaining[0].id);
    return { ok: true, activeAccountId: remaining[0].id };
  }
  return { ok: true, activeAccountId: activeId };
});

// Put the local Claude home back after it has been deleted. Without this the
// removal is a one-way door: create-account makes a fresh empty config under
// ~/.wootonpad rather than re-attaching ~/.claude.
ipcMain.handle('restore-default-account', () => {
  const existing = getAccounts();
  const already = existing.find(a => a.id === 'default');
  if (already) return already;
  setSetting('accounts', [DEFAULT_ACCOUNT, ...existing]);
  return DEFAULT_ACCOUNT;
});

ipcMain.handle('get-homedir', () => os.homedir());

// Reports the account actually in effect rather than the stored id, which can
// name an account that is no longer there — getActiveAccount() resolves that to
// the first survivor and the renderer has to agree with it.
ipcMain.handle('get-active-account-id', () => getActiveAccount().id);

// Point everything that holds a per-account directory at `accountId`. Shared
// with delete-account, which has to do exactly this when the account being
// removed is the one on screen.
function activateAccount(accountId) {
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
}

ipcMain.handle('set-active-account-id', (_event, accountId) => {
  activateAccount(accountId);
  return { ok: true };
});

// --- Account usage (limits) ---
// One fetch loop for the whole app. Every account costs a network call, the API
// answers 429 with a retry-after, and both the tray and the renderer want the same
// numbers — so they share this result rather than each asking for their own.
const USAGE_POLL_MS = 5 * 60 * 1000;
// How stale a result the renderer will accept before a request refreshes it.
const USAGE_FRESH_MS = 2 * 60 * 1000;
// A 429 does not have to carry a usable retry-after, and without a floor of its own
// the poll would keep asking a limited API every interval.
const USAGE_RATE_LIMIT_MIN_MS = 60 * 1000;

let usageByAccount = {};
let usageFetchedAt = 0;
let usageInFlight = null;
let usagePollTimer = null;
// Set from a 429's retry-after: no fetch is attempted before this moment.
let usageBlockedUntil = 0;

function accountsUsageSnapshot() {
  return usageByAccount;
}

async function fetchAccountsUsage() {
  const accounts = getAccounts();
  const results = {};
  let rateLimited = false;
  let retryAfterSeconds = 0;

  await Promise.all(accounts.map(async (account) => {
    const cacheKey = 'usage:' + account.id;
    try {
      const usage = await fetchAndTransformUsage(account.configDir);
      if (usage && !usage._error && !usage._rateLimited && Object.keys(usage).length) {
        setSetting(cacheKey, usage);
        results[account.id] = usage;
      } else {
        if (usage?._rateLimited) {
          rateLimited = true;
          retryAfterSeconds = Math.max(retryAfterSeconds, usage.retryAfterSeconds || 0);
        }
        const cached = getSetting(cacheKey);
        results[account.id] = cached ? { ...cached, _cached: true } : (usage || {});
      }
    } catch {
      const cached = getSetting(cacheKey);
      results[account.id] = cached ? { ...cached, _cached: true } : {};
    }
  }));

  usageByAccount = results;
  usageFetchedAt = Date.now();
  // A rate limit applies to the token, not to one call, so hold off every account.
  if (rateLimited) {
    const holdMs = Math.max(retryAfterSeconds * 1000 || 0, USAGE_RATE_LIMIT_MIN_MS);
    usageBlockedUntil = Date.now() + holdMs;
    log.warn(`[usage] rate limited; not fetching again for ${Math.round(holdMs / 1000)}s`);
  }
  return results;
}

// Never runs two fetches at once: a slow request would otherwise pile up behind the
// poll interval and the renderer's own request.
function refreshAccountsUsage() {
  if (usageInFlight) return usageInFlight;
  if (Date.now() < usageBlockedUntil) return Promise.resolve(usageByAccount);

  usageInFlight = fetchAccountsUsage()
    .catch((err) => {
      log.error('[usage] refresh failed:', err?.message || String(err));
      return usageByAccount;
    })
    .finally(() => { usageInFlight = null; });

  usageInFlight.then(() => refreshTray()).catch(() => {});
  return usageInFlight;
}

let resumeWatchInstalled = false;

function startUsagePolling() {
  if (usagePollTimer) return;
  refreshAccountsUsage();
  usagePollTimer = setInterval(() => refreshAccountsUsage(), USAGE_POLL_MS);
  // Numbers from before a suspend are worthless, and the interval does not fire
  // while the machine is asleep. Installed once: the tray can be switched off and
  // on again, and a listener per switch would stack up.
  if (!resumeWatchInstalled) {
    try {
      const { powerMonitor } = require('electron');
      powerMonitor.on('resume', () => refreshAccountsUsage());
      resumeWatchInstalled = true;
    } catch {}
  }
}

function stopUsagePolling() {
  if (!usagePollTimer) return;
  clearInterval(usagePollTimer);
  usagePollTimer = null;
}

ipcMain.handle('get-accounts-usage', async () => {
  // The last result only counts as fresh while it still covers every account: an
  // account added since then has no figures in it, and the renderer asks precisely
  // because it has just added one.
  const ids = getAccounts().map((account) => account.id);
  const covers = ids.length > 0 && ids.every((id) => id in usageByAccount);
  if (covers && Date.now() - usageFetchedAt < USAGE_FRESH_MS) return usageByAccount;
  return refreshAccountsUsage();
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
  terminalTheme: 'switchboard',
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
    if (!session.exited) active.push(sessionId);
  }
  return active;
});

// --- IPC: get-active-terminals --- (plain terminal sessions for renderer restore)
ipcMain.handle('get-active-terminals', () => {
  const terminals = [];
  for (const [sessionId, session] of activeSessions) {
    if (!session.exited && session.isPlainTerminal) {
      terminals.push({ sessionId, projectPath: session.projectPath });
    }
  }
  return terminals;
});

// --- IPC: stop-session ---
ipcMain.handle('stop-session', (_event, sessionId) => {
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

// --- IPC: open-terminal ---
ipcMain.handle('open-terminal', async (_event, sessionId, projectPath, isNew, sessionOptions) => {
  if (!mainWindow) return { ok: false, error: 'no window' };

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
      // A WSL account's configDir is the Windows view of a directory inside the
      // distribution — meaningless as CLAUDE_CONFIG_DIR there, and setting it
      // would point Claude at a path it cannot resolve. What crosses instead is
      // the POSIX directory, and only when it is not the ~/.claude the
      // distribution would have picked on its own.
      //
      // Deleted rather than merely left unset: cleanPtyEnv is a copy of the app's
      // own environment, so a CLAUDE_CONFIG_DIR the user happened to export before
      // launching would otherwise survive here and outrank the active account. For
      // a WSL session it is worse than wrong — WSLENV names it below, so a Windows
      // path would cross into a distribution that cannot resolve it at all.
      delete ptyEnv.CLAUDE_CONFIG_DIR;
      const wslConfigEnv = accountWslConfigEnv(activeAccount);
      if (wslConfigEnv) {
        ptyEnv.CLAUDE_CONFIG_DIR = wslConfigEnv;
      } else if (activeAccount.id !== 'default' && !accountWslDistro(activeAccount)) {
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
          // Only present for an account that is not the distribution's default
          // Claude home; withWslEnv skips a name the environment does not carry.
          'CLAUDE_CONFIG_DIR',
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
    isPlainTerminal, forkFrom: sessionOptions?.forkFrom || null,
    mcpServer, _openedAt: Date.now(),
  };
  activeSessions.set(sessionId, session);

  ptyProcess.onData(data => {
    const currentId = session.realSessionId || sessionId;

    // Parse OSC sequences (title changes, progress, notifications, etc.)
    if (data.includes('\x1b]')) {
      const oscMatches = data.matchAll(/\x1b\](\d+);([^\x07\x1b]*)(?:\x07|\x1b\\)/g);
      for (const m of oscMatches) {
        const code = m[1];
        const payload = m[2].slice(0, 120);
        // Detect Claude CLI busy state from OSC 0 title (spinner chars = busy, ✳ = idle)
        if (code === '0') {
          const firstChar = payload.charAt(0);
          const isBusy = firstChar.charCodeAt(0) >= 0x2800 && firstChar.charCodeAt(0) <= 0x28FF;
          const isIdle = firstChar === '\u2733'; // ✳
          log.debug(`[OSC 0] session=${currentId} char=U+${firstChar.charCodeAt(0).toString(16).toUpperCase()} busy=${isBusy} idle=${isIdle} wasBusy=${!!session._cliBusy}`);
          if (isBusy && !session._cliBusy) {
            session._cliBusy = true;
            session._oscIdle = false;
            log.debug(`[OSC 0] session=${currentId} → BUSY`);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('cli-busy-state', currentId, true);
            }
            refreshTray();
          } else if (isIdle && session._cliBusy) {
            session._cliBusy = false;
            session._oscIdle = true;
            log.debug(`[OSC 0] session=${currentId} → IDLE`);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('cli-busy-state', currentId, false);
            }
            refreshTray();
          }
        }
      }
      // Parse iTerm2 OSC 9 sequences (terminated by BEL \x07 or ST \x1b\\)
      const osc9Matches = data.matchAll(/\x1b\]9;([^\x07\x1b]*)(?:\x07|\x1b\\)/g);
      for (const osc9 of osc9Matches) {
        const payload = osc9[1];
        // OSC 9;4 progress: 4;0; = clear/done, 4;1;N = running at N%, 4;2;N = error, 4;3; = indeterminate
        if (payload.startsWith('4;')) {
          const level = payload.split(';')[1];
          if (level === '0') continue; // 4;0 is also used for clearing, making it unreliable as an idle signal
          log.debug(`[OSC 9;4] session=${currentId} level=${level} payload="${payload}" wasBusy=${!!session._cliBusy}`);
          if ((level === '1' || level === '2' || level === '3') && !session._cliBusy) {
            session._cliBusy = true;
            session._oscIdle = false;
            log.debug(`[OSC 9;4] session=${currentId} → BUSY`);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('cli-busy-state', currentId, true);
            }
            refreshTray();
          }
        } else {
          // Regular notification (attention, permission, etc.)
          log.info(`[OSC 9] session=${currentId} message="${payload}"`);
          // Classified once, here, and the verdict travels with the message: the
          // renderer used to run its own copy of this test, and two copies of the
          // rule drift apart in the one direction that matters — the sidebar marking
          // a session the tray does not.
          const wantsUser = ATTENTION_MESSAGE.test(payload);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('terminal-notification', currentId, payload, wantsUser);
          }
          noteSessionNotification(session, currentId, payload);
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
    // An exited session cannot be waiting for anything, and traySnapshot skips it
    // on both counts now — it is gone from the map and marked exited.
    session._attention = false;
    refreshTray();
  });

  if (sessionOptions?.forkFrom) {
    log.info(`[fork-spawn] tempId=${sessionId} forkFrom=${sessionOptions.forkFrom} folder=${projectFolder} knownFiles=${knownJsonlFiles.size}`);
  }

  return { ok: true, reattached: false, mcpActive: !!mcpServer };
});

// --- IPC: terminal-input (fire-and-forget) ---
ipcMain.on('terminal-input', (_event, sessionId, data) => {
  const session = activeSessions.get(sessionId);
  if (session && !session.exited) {
    session.pty.write(data);
  }
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
sessionTransitions.init({ PROJECTS_DIR: activeProjectsDir(), activeSessions, getMainWindow: () => mainWindow, log, rekeyMcpServer });
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

  if (trayEnabledSetting()) startTray();

  app.on('activate', () => {
    // A hidden window is still a window, so getAllWindows() cannot decide this.
    showMainWindow();
  });
});

app.on('window-all-closed', () => {
  // With a tray icon the app deliberately outlives its window on every platform;
  // quitting is the tray's Quit item.
  if (process.platform !== 'darwin' && !trayIcon.isTrayActive()) app.quit();
});

// A quit started by autoUpdater.quitAndInstall() closes the windows first and only
// emits before-quit afterwards, so without this the close handler would hide the
// window and the update would never be installed.
app.on('before-quit-for-update', () => { isQuitting = true; });

app.on('before-quit', () => {
  isQuitting = true;
  stopTray();
  // Shut down all MCP servers
  shutdownAllMcp();

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
