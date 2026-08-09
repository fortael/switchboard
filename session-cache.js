const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');
const { getFolderIndexMtimeMs } = require('./folder-index-state');
const { deriveProjectPath } = require('./derive-project-path');
const { readSessionFile } = require('./read-session-file');
const { encodeProjectPath } = require('./encode-project-path');

/**
 * Session cache module.
 * Call init(ctx) once with the shared context object.
 *
 * Accounts are resolved per call rather than pinned at init: in the merged view
 * every account's sessions are read at once, and the account an incremental
 * refresh belongs to is the one whose watcher saw the change — not whichever
 * account happens to be active at that moment.
 */
let getActiveAccount, getProjectsDir, accountsInView;
let activeSessions, getMainWindow, log;
let deleteCachedFolder, getCachedByFolder, upsertCachedSessions, deleteCachedSession;
let deleteSearchSession, upsertSearchEntries;
let setFolderMeta, getAllFolderMeta, getAllMeta, getAllCached, getSetting, getMeta, setName, getAllProjectGitCounts;

function init(ctx) {
  getActiveAccount = ctx.getActiveAccount;
  getProjectsDir = ctx.getProjectsDir;
  // Injected rather than rebuilt from getAccounts()/the setting: "which accounts
  // are on screen" has to have one answer, and it already lives in main.js.
  accountsInView = ctx.accountsInView;
  activeSessions = ctx.activeSessions;
  getMainWindow = ctx.getMainWindow;
  log = ctx.log;
  // DB functions
  deleteCachedFolder = ctx.db.deleteCachedFolder;
  getCachedByFolder = ctx.db.getCachedByFolder;
  upsertCachedSessions = ctx.db.upsertCachedSessions;
  deleteCachedSession = ctx.db.deleteCachedSession;
  deleteSearchSession = ctx.db.deleteSearchSession;
  upsertSearchEntries = ctx.db.upsertSearchEntries;
  setFolderMeta = ctx.db.setFolderMeta;
  getAllFolderMeta = ctx.db.getAllFolderMeta;
  getAllMeta = ctx.db.getAllMeta;
  getAllCached = ctx.db.getAllCached;
  getSetting = ctx.db.getSetting;
  getMeta = ctx.db.getMeta;
  setName = ctx.db.setName;
  getAllProjectGitCounts = ctx.db.getAllProjectGitCounts;
}

// readSessionFile is imported from read-session-file.js (shared with worker)

/** Read one folder from filesystem by scanning .jsonl files directly */
function readFolderFromFilesystem(folder, account = getActiveAccount()) {
  const folderPath = path.join(getProjectsDir(account), folder);
  const projectPath = deriveProjectPath(folderPath, folder);
  if (!projectPath) return { projectPath: null, sessions: [] };
  const sessions = [];

  try {
    const jsonlFiles = fs.readdirSync(folderPath).filter(f => f.endsWith('.jsonl'));
    for (const file of jsonlFiles) {
      const s = readSessionFile(path.join(folderPath, file), folder, projectPath);
      if (s) sessions.push(s);
    }
  } catch {}

  return { projectPath, sessions };
}

/** Refresh a single folder incrementally: only re-read changed/new .jsonl files */
function refreshFolder(folder, account = getActiveAccount()) {
  const accountId = account.id;
  const folderPath = path.join(getProjectsDir(account), folder);
  if (!fs.existsSync(folderPath)) {
    deleteCachedFolder(folder, accountId);
    return;
  }

  const projectPath = deriveProjectPath(folderPath, folder);
  if (!projectPath) {
    setFolderMeta(folder, null, getFolderIndexMtimeMs(folderPath));
    return;
  }

  // Get what's currently cached for this folder
  const cachedSessions = getCachedByFolder(folder, accountId);
  const cachedMap = new Map(); // sessionId → modified ISO string
  for (const row of cachedSessions) {
    cachedMap.set(row.sessionId, row.modified);
  }

  // Scan current .jsonl files
  let jsonlFiles;
  try {
    jsonlFiles = fs.readdirSync(folderPath).filter(f => f.endsWith('.jsonl'));
  } catch { return; }

  const currentIds = new Set();
  let changed = false;

  // Collect all changes first, then batch DB writes to minimize lock duration
  const sessionsToUpsert = [];
  const searchEntriesToUpsert = [];
  const namesToSet = [];
  const sessionsToDelete = [];

  for (const file of jsonlFiles) {
    const filePath = path.join(folderPath, file);
    const sessionId = path.basename(file, '.jsonl');
    currentIds.add(sessionId);

    // Check if file mtime changed
    let fileMtime;
    try { fileMtime = fs.statSync(filePath).mtime.toISOString(); } catch { continue; }

    if (cachedMap.has(sessionId) && cachedMap.get(sessionId) === fileMtime) {
      continue; // unchanged, skip
    }

    // File is new or modified — re-read it
    const s = readSessionFile(filePath, folder, projectPath);
    if (s) {
      sessionsToUpsert.push(s);
      // Title precedence: user rename (session_meta.name) > JSONL custom-title > JSONL ai-title.
      // Only customTitle (Claude /title) promotes to session_meta.name — AI titles stay in
      // session_cache.aiTitle and are preserved once written (COALESCE in the upsert).
      const existingName = getMeta(s.sessionId)?.name;
      if (!existingName && s.customTitle) namesToSet.push({ id: s.sessionId, name: s.customTitle });
      const name = existingName || s.customTitle || s.aiTitle || '';
      searchEntriesToUpsert.push({
        id: s.sessionId, type: 'session', folder: s.folder,
        title: (name ? name + ' ' : '') + s.summary, body: s.textContent,
      });
    }
    changed = true;
  }

  // Remove sessions whose .jsonl files were deleted
  for (const sessionId of cachedMap.keys()) {
    if (!currentIds.has(sessionId)) {
      sessionsToDelete.push(sessionId);
      changed = true;
    }
  }

  // Batch all DB writes to reduce lock contention
  if (sessionsToUpsert.length > 0) {
    upsertCachedSessions(sessionsToUpsert, accountId);
  }
  for (const entry of searchEntriesToUpsert) {
    deleteSearchSession(entry.id);
  }
  if (searchEntriesToUpsert.length > 0) {
    upsertSearchEntries(searchEntriesToUpsert);
  }
  for (const { id, name } of namesToSet) {
    setName(id, name);
  }
  for (const sessionId of sessionsToDelete) {
    deleteCachedSession(sessionId);
    deleteSearchSession(sessionId);
  }

  // Update folder mtime
  setFolderMeta(folder, projectPath, getFolderIndexMtimeMs(folderPath));
}

/** Populate entire cache from filesystem (cold start) */
function populateCacheFromFilesystem(account = getActiveAccount()) {
  try {
    const folders = fs.readdirSync(getProjectsDir(account), { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== '.git')
      .map(d => d.name);

    for (const folder of folders) {
      refreshFolder(folder, account);
    }
  } catch (err) {
    console.error('Error populating cache:', err);
  }
}

/** Build projects response from cached data */
function buildProjectsFromCache(showArchived) {
  const accounts = accountsInView();
  const metaMap = getAllMeta();
  const cachedRows = accounts.flatMap(a => getAllCached(a.id));
  const global = getSetting('global') || {};
  const hiddenProjects = new Set(global.hiddenProjects || []);
  const gitCounts = getAllProjectGitCounts?.() || new Map();

  // Group by projectPath, not on-disk folder name. Multiple ~/.claude/projects/<folder>/
  // directories can resolve to the same projectPath (Claude Code's folder-name encoding
  // scheme has changed over time, leaving legacy stragglers around), so we merge them into
  // a single sidebar group to avoid duplicate-id collisions in the morphdom render.
  // The merged view groups across accounts for the same reason: the project is the same
  // directory whoever opened it, and everything keyed per project — settings, git cache,
  // avatar, the hidden list — is keyed by that path alone. Which accounts contributed
  // travels alongside, in `accountIds`.
  // Only insert a project entry once we have a session that survives the archive filter —
  // otherwise folders whose sessions are all archived would appear in the sidebar as
  // undismissable phantom entries.
  const projectMap = new Map();
  const noteAccount = (proj, id) => {
    if (id && !proj.accountIds.includes(id)) proj.accountIds.push(id);
  };
  for (const row of cachedRows) {
    if (!row.projectPath) continue;
    if (hiddenProjects.has(row.projectPath)) continue;
    const meta = metaMap.get(row.sessionId);
    const s = {
      sessionId: row.sessionId,
      summary: row.summary,
      firstPrompt: row.firstPrompt,
      created: row.created,
      modified: row.modified,
      messageCount: row.messageCount,
      projectPath: row.projectPath,
      slug: row.slug || null,
      aiTitle: row.aiTitle || null,
      name: meta?.name || null,
      starred: meta?.starred || 0,
      archived: meta?.archived || 0,
      accountId: row.accountId || 'default',
    };
    if (!showArchived && s.archived) continue;
    if (!projectMap.has(row.projectPath)) {
      projectMap.set(row.projectPath, {
        folder: encodeProjectPath(row.projectPath),
        projectPath: row.projectPath,
        accountIds: [],
        sessions: [],
      });
    }
    const proj = projectMap.get(row.projectPath);
    noteAccount(proj, s.accountId);
    proj.sessions.push(s);
  }

  // Include empty project directories (no sessions yet). Resolve folder→projectPath
  // through cache_meta (populated by the indexer) instead of re-reading a JSONL off
  // disk for every directory on every render. Fall back to deriveProjectPath only
  // for folders the indexer hasn't seen yet, and backfill cache_meta so subsequent
  // renders are pure DB reads.
  const folderMeta = getAllFolderMeta();
  for (const account of accounts) {
    try {
      const projectsDir = getProjectsDir(account);
      const dirs = fs.readdirSync(projectsDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name !== '.git');
      for (const d of dirs) {
        let projectPath = folderMeta.get(d.name)?.projectPath;
        if (!projectPath) {
          projectPath = deriveProjectPath(path.join(projectsDir, d.name), d.name);
          if (projectPath) setFolderMeta(d.name, projectPath, 0);
        }
        if (!projectPath) continue;
        if (hiddenProjects.has(projectPath)) continue;
        if (!projectMap.has(projectPath)) {
          projectMap.set(projectPath, {
            folder: encodeProjectPath(projectPath),
            projectPath,
            accountIds: [],
            sessions: [],
          });
        }
        noteAccount(projectMap.get(projectPath), account.id);
      }
    } catch {}
  }

  // Inject active plain terminal sessions so they participate in sorting. A
  // terminal belongs to the account it was launched under, which is not
  // necessarily the active one by the time this runs — and it is listed whatever
  // that account is. This is live state, not cache: a terminal filtered out
  // because the app has moved off its account is a running shell with no way
  // back to it once its tab is closed.
  for (const [sessionId, session] of activeSessions) {
    if (session.exited || !session.isPlainTerminal) continue;
    if (!session.projectPath) continue;
    if (hiddenProjects.has(session.projectPath)) continue;
    const sessionAccountId = session.accountId || 'default';
    if (!projectMap.has(session.projectPath)) {
      projectMap.set(session.projectPath, {
        folder: encodeProjectPath(session.projectPath),
        projectPath: session.projectPath,
        accountIds: [],
        sessions: [],
      });
    }
    const proj = projectMap.get(session.projectPath);
    noteAccount(proj, sessionAccountId);
    if (!proj.sessions.some(s => s.sessionId === sessionId)) {
      proj.sessions.push({
        sessionId, summary: 'Terminal', firstPrompt: '', projectPath: session.projectPath,
        name: null, starred: 0, archived: 0, messageCount: 0,
        modified: new Date(session._openedAt).toISOString(),
        created: new Date(session._openedAt).toISOString(),
        type: 'terminal',
        accountId: sessionAccountId,
      });
    }
  }

  const projects = [];
  for (const proj of projectMap.values()) {
    proj.sessions.sort((a, b) => new Date(b.modified) - new Date(a.modified));
    const gc = gitCounts.get(proj.projectPath);
    if (gc) {
      proj.unpushedCount = gc.unpushedCount || 0;
      proj.changedCount = gc.changedCount || 0;
    }
    projects.push(proj);
  }

  projects.sort((a, b) => {
    // Empty projects go to the bottom
    if (a.sessions.length === 0 && b.sessions.length > 0) return 1;
    if (b.sessions.length === 0 && a.sessions.length > 0) return -1;
    const aName = a.projectPath.split('/').filter(Boolean).pop() || a.projectPath;
    const bName = b.projectPath.split('/').filter(Boolean).pop() || b.projectPath;
    return aName.localeCompare(bName);
  });

  return projects;
}


function notifyRendererProjectsChanged() {
  const mainWindow = getMainWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('projects-changed');
  }
}

function sendStatus(text, type) {
  if (text) log.info(`[status] (${type || 'info'}) ${text}`);
  const mw = getMainWindow();
  if (mw && !mw.isDestroyed()) {
    mw.webContents.send('status-update', text, type || 'info');
  }
}

// --- Worker-based cache population (non-blocking) ---
// One scan per account at a time: the merged view can ask for several accounts
// at once, and a single flag would let the second request through while the
// first is still writing.
const populatingAccounts = new Set();

// `onDone(ok)` reports whether the scan actually indexed anything, so a caller
// that only scans an account once per run can drop the mark when it failed.
function populateCacheViaWorker(account = getActiveAccount(), onDone = () => {}) {
  const accountId = account.id;
  if (populatingAccounts.has(accountId)) return;
  populatingAccounts.add(accountId);
  sendStatus('Scanning projects\u2026', 'active');

  const worker = new Worker(path.join(__dirname, 'workers', 'scan-projects.js'), {
    workerData: { projectsDir: getProjectsDir(account), accountId },
  });

  worker.on('message', (msg) => {
    // Progress updates from worker
    if (msg.type === 'progress') {
      sendStatus(msg.text, 'active');
      return;
    }

    if (!msg.ok) {
      console.error('Worker scan error:', msg.error);
      sendStatus('Scan failed: ' + msg.error, 'error');
      populatingAccounts.delete(accountId);
      onDone(false);
      return;
    }

    sendStatus(`Indexing ${msg.results.length} projects\u2026`, 'active');

    // Write results to DB on main thread (fast)
    const currentAccountId = msg.accountId || accountId;
    let sessionCount = 0;
    for (const { folder, projectPath, sessions, indexMtimeMs } of msg.results) {
      // Search rows are keyed by folder alone, and two accounts holding the same
      // project produce the same folder name \u2014 so clearing the folder here would
      // drop the other account's sessions from the index until it happens to be
      // rescanned. Clear exactly the sessions this account had instead, read
      // before deleteCachedFolder takes them away.
      const previousIds = getCachedByFolder(folder, currentAccountId).map(r => r.sessionId);
      deleteCachedFolder(folder, currentAccountId);
      for (const id of previousIds) deleteSearchSession(id);
      if (sessions.length > 0) {
        sessionCount += sessions.length;
        upsertCachedSessions(sessions, currentAccountId);
        for (const s of sessions) {
          // Only JSONL custom-title (genuine user title) promotes to the DB name column.
          // AI titles must not — see refreshFolder for the rationale.
          if (s.customTitle) setName(s.sessionId, s.customTitle);
        }
        upsertSearchEntries(sessions.map(s => {
          // Search title precedence matches the sidebar: user rename > custom-title > ai-title.
          const name = getMeta(s.sessionId)?.name || s.customTitle || s.aiTitle || '';
          return {
            id: s.sessionId, type: 'session', folder: s.folder,
            title: (name ? name + ' ' : '') + s.summary,
            body: s.textContent,
          };
        }));
      }
      setFolderMeta(folder, projectPath, indexMtimeMs);
    }

    populatingAccounts.delete(accountId);
    onDone(true);
    sendStatus(`Indexed ${sessionCount} sessions across ${msg.results.length} projects`, 'done');
    // Clear status after a few seconds
    setTimeout(() => sendStatus(''), 5000);
    notifyRendererProjectsChanged();
  });

  worker.on('error', (err) => {
    console.error('Worker error:', err);
    sendStatus('Worker error: ' + err.message, 'error');
    populatingAccounts.delete(accountId);
    onDone(false);
  });

  // If the worker exits abnormally (SIGSEGV, OOM, uncaught exception) without
  // sending a message, neither the 'message' nor 'error' handler will fire.
  // Reset the flag here to prevent a permanent lockout where the session list
  // stays empty because populateCacheViaWorker() returns immediately.
  worker.on('exit', (code) => {
    if (populatingAccounts.has(accountId)) {
      populatingAccounts.delete(accountId);
      onDone(false);
      if (code !== 0) {
        sendStatus('Scan worker exited unexpectedly', 'error');
      }
    }
  });
}

module.exports = {
  init,
  readSessionFile,
  readFolderFromFilesystem,
  refreshFolder,
  populateCacheFromFilesystem,
  buildProjectsFromCache,
  notifyRendererProjectsChanged,
  sendStatus,
  populateCacheViaWorker,
};
