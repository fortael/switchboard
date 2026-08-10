// Integration test for the merged account view.
//
// The setting turns one question into another: instead of "what has the active
// account got", the sidebar asks "what has every account got, and whose is
// each". This loads the real main.js against an in-memory session cache holding
// two accounts and drives the real IPC handlers, because every part of this
// feature that can break is wiring — which account a row is read under, which
// one a launch runs under — rather than logic inside any one function.
//
// Node's test runner gives each file its own process, so the stubs here do not
// leak into the other suites.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');
const os = require('os');
const fs = require('fs');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wootonpad-merged-'));
os.homedir = () => HOME;

const { encodeProjectPath } = require('../encode-project-path');

const ACCOUNT_A = { id: 'default', name: 'Default', configDir: path.join(HOME, '.claude') };
const ACCOUNT_B = { id: 'acc-b', name: 'Work', configDir: path.join(HOME, '.wootonpad', 'accounts', 'acc-b') };

// Real directories: buildProjectsFromCache reads each account's projects/ to
// find projects with no sessions yet, and a session launch checks that the
// project is still there.
const PROJECT_A = path.join(HOME, 'work', 'only-a');
const PROJECT_B = path.join(HOME, 'work', 'only-b');
const PROJECT_SHARED = path.join(HOME, 'work', 'shared');
const PROJECT_EMPTY_B = path.join(HOME, 'work', 'empty-in-b');

for (const p of [PROJECT_A, PROJECT_B, PROJECT_SHARED, PROJECT_EMPTY_B]) {
  fs.mkdirSync(p, { recursive: true });
}
for (const [account, projects] of [
  [ACCOUNT_A, [PROJECT_A, PROJECT_SHARED]],
  [ACCOUNT_B, [PROJECT_B, PROJECT_SHARED, PROJECT_EMPTY_B]],
]) {
  for (const projectPath of projects) {
    fs.mkdirSync(path.join(account.configDir, 'projects', encodeProjectPath(projectPath)), { recursive: true });
  }
}

// A project with no sessions is resolvable only through what is on disk — the
// seed .jsonl `add-project` writes, which records the cwd and nothing else.
fs.writeFileSync(
  path.join(ACCOUNT_B.configDir, 'projects', encodeProjectPath(PROJECT_EMPTY_B), 'seed.jsonl'),
  JSON.stringify({ type: 'user', cwd: PROJECT_EMPTY_B }) + '\n',
);

// The session cache, as the DB would hold it: one row per session, tagged with
// the account that recorded it.
const cachedSessions = [
  { sessionId: 's-a', folder: encodeProjectPath(PROJECT_A), projectPath: PROJECT_A, summary: 'A', created: '2026-01-01T00:00:00.000Z', modified: '2026-01-01T00:00:00.000Z', messageCount: 1, accountId: 'default' },
  { sessionId: 's-b', folder: encodeProjectPath(PROJECT_B), projectPath: PROJECT_B, summary: 'B', created: '2026-01-02T00:00:00.000Z', modified: '2026-01-02T00:00:00.000Z', messageCount: 1, accountId: 'acc-b' },
  { sessionId: 's-shared-a', folder: encodeProjectPath(PROJECT_SHARED), projectPath: PROJECT_SHARED, summary: 'shared from A', created: '2026-01-03T00:00:00.000Z', modified: '2026-01-03T00:00:00.000Z', messageCount: 1, accountId: 'default' },
  { sessionId: 's-shared-b', folder: encodeProjectPath(PROJECT_SHARED), projectPath: PROJECT_SHARED, summary: 'shared from B', created: '2026-01-04T00:00:00.000Z', modified: '2026-01-04T00:00:00.000Z', messageCount: 1, accountId: 'acc-b' },
];

const settings = new Map([
  ['accounts', [ACCOUNT_A, ACCOUNT_B]],
  ['global', { activeAccountId: 'default', mergedAccountView: true }],
]);

function setGlobal(patch) {
  settings.set('global', { ...settings.get('global'), ...patch });
}

const calls = { spawn: [] };
const handlers = new Map();
const noop = () => {};
const permissive = (base = {}) => new Proxy(base, { get: (t, k) => (k in t ? t[k] : noop) });

const stubs = {
  electron: {
    app: permissive({
      isPackaged: false, getVersion: () => '0.0.0', getPath: () => HOME,
      whenReady: () => Promise.resolve(), requestSingleInstanceLock: () => true,
    }),
    BrowserWindow: Object.assign(function () {
      return permissive({
        webContents: permissive({ send: noop }),
        isDestroyed: () => false,
        getBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
        isMinimized: () => false,
      });
    }, { getAllWindows: () => [] }),
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), on: noop, removeHandler: noop },
    Menu: permissive({ buildFromTemplate: () => permissive() }),
    screen: permissive({ getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) }),
    shell: permissive(),
    nativeTheme: permissive(),
  },
  'node-pty': {
    spawn: (file, args, opts) => {
      calls.spawn.push({ file, args, opts });
      return permissive({ pid: 1 });
    },
  },
  'electron-log': permissive({ transports: { file: {}, console: {} } }),
  './db': permissive({
    getSetting: (k) => settings.get(k),
    setSetting: (k, v) => settings.set(k, v),
    deleteSetting: (k) => settings.delete(k),
    getAllCached: (accountId) => cachedSessions.filter(s => s.accountId === accountId),
    // Populated for both accounts: a cold start would answer with an empty list
    // and kick off a scan, which is not what these tests are about.
    isCachePopulated: () => true,
    isSearchIndexPopulated: () => true,
    getAllMeta: () => new Map(),
    getAllFolderMeta: () => new Map(),
    getProjectAccountIds: () => {
      const map = new Map();
      for (const s of cachedSessions) {
        const ids = map.get(s.projectPath) || [];
        if (!ids.includes(s.accountId)) ids.push(s.accountId);
        map.set(s.projectPath, ids);
      }
      return map;
    },
    searchFtsRecreated: false,
  }),
  ws: { WebSocketServer: function () { return permissive(); } },
  chokidar: { watch: () => permissive() },
  'electron-reloader': () => {},
  child_process: {
    execFileSync: () => { throw new Error('Command failed'); },
    execFile: (file, args, options, callback) => {
      const done = typeof options === 'function' ? options : callback;
      if (done) setImmediate(() => done(new Error('Command failed'), '', ''));
      return permissive({ pid: 1 });
    },
    spawn: () => permissive({ pid: 1 }),
    spawnSync: () => ({ status: 1, stdout: '', stderr: 'Command failed' }),
  },
};

const originalLoad = Module._load;
Module._load = function (request) {
  return stubs[request] || originalLoad.apply(this, arguments);
};

// One watcher per account is started against real directories here, and a live
// fs.watch handle has no owner this file can reach to close.
fs.watch = () => permissive({ close: noop, on: noop });

// The watcher poll, the scheduler and the updater interval are equally
// unreachable; unref them as they are created so the process ends on its own.
for (const name of ['setInterval', 'setTimeout']) {
  const original = global[name];
  global[name] = (...args) => {
    const handle = original(...args);
    if (handle && typeof handle.unref === 'function') handle.unref();
    return handle;
  };
}

require('../main.js');

const byPath = (projects) => new Map(projects.map(p => [p.projectPath, p]));

test('the merged view lists the projects of every account at once', async () => {
  setGlobal({ activeAccountId: 'default', mergedAccountView: true });

  const projects = byPath(await handlers.get('get-projects')({}, false));

  assert.ok(projects.has(PROJECT_A), 'the active account\'s project is listed');
  assert.ok(projects.has(PROJECT_B), 'the other account\'s project is listed too');
  // A directory with no sessions yet belongs to the account whose projects/ it
  // sits in, and is the case the empty-folder sweep has to cover per account.
  assert.ok(projects.has(PROJECT_EMPTY_B), 'an empty project of the other account is listed');
  assert.deepEqual(projects.get(PROJECT_B).accountIds, ['acc-b']);
});

test('a project both accounts have is one entry carrying both', async () => {
  setGlobal({ activeAccountId: 'default', mergedAccountView: true });

  const projects = await handlers.get('get-projects')({}, false);
  const shared = projects.filter(p => p.projectPath === PROJECT_SHARED);

  // Grouped by path rather than by (account, path): the directory is the same
  // one whoever opened it, and everything keyed per project — settings, git
  // cache, the hidden list — is keyed by that path alone.
  assert.equal(shared.length, 1, 'the shared project appears once, not once per account');
  assert.deepEqual(shared[0].accountIds.slice().sort(), ['acc-b', 'default']);
  assert.deepEqual(
    shared[0].sessions.map(s => s.sessionId).sort(),
    ['s-shared-a', 's-shared-b'],
  );
  // Which account each session belongs to has to survive the merge — it is what
  // the badge reads and what a resume is launched under.
  assert.equal(shared[0].sessions.find(s => s.sessionId === 's-shared-b').accountId, 'acc-b');
});

test('with the setting off the list is the active account\'s own', async () => {
  setGlobal({ activeAccountId: 'default', mergedAccountView: false });

  const projects = byPath(await handlers.get('get-projects')({}, false));

  assert.ok(projects.has(PROJECT_A));
  assert.ok(projects.has(PROJECT_SHARED));
  assert.equal(projects.has(PROJECT_B), false, 'another account\'s project stays out');
  assert.equal(projects.has(PROJECT_EMPTY_B), false);
});

test('a launch runs under the account it names, not the one on screen', async () => {
  setGlobal({ activeAccountId: 'default', mergedAccountView: true });
  calls.spawn.length = 0;

  const result = await handlers.get('open-terminal')(
    {}, 'new-session-1', PROJECT_B, true,
    { accountId: 'acc-b', mcpEmulation: false },
  );

  assert.equal(result.ok, true);
  assert.equal(result.accountId, 'acc-b');
  // Activated rather than merely bound to the spawn: fork detection, the diffs
  // arriving over MCP and the file panel all resolve through the active account,
  // and they have to agree with the shell that is running.
  assert.equal(settings.get('global').activeAccountId, 'acc-b');
  assert.equal(calls.spawn[0].opts.env.CLAUDE_CONFIG_DIR, ACCOUNT_B.configDir);
});

test('with the setting off a launch naming another account is ignored', async () => {
  setGlobal({ activeAccountId: 'default', mergedAccountView: false });
  calls.spawn.length = 0;

  const result = await handlers.get('open-terminal')(
    {}, 'new-session-3', PROJECT_A, true,
    { accountId: 'acc-b', mcpEmulation: false },
  );

  // The standard view is one account's own list, so every launch is already
  // that account's — and honouring the field would let a stale record in the
  // renderer move the whole app somewhere the user never asked to go.
  assert.equal(result.ok, true);
  assert.equal(settings.get('global').activeAccountId, 'default');
  assert.equal(result.accountId, 'default');
  assert.equal(calls.spawn[0].opts.env.CLAUDE_CONFIG_DIR, undefined);
});

test('a launch that names no account stays on the active one', async () => {
  setGlobal({ activeAccountId: 'default', mergedAccountView: true });
  calls.spawn.length = 0;

  const result = await handlers.get('open-terminal')(
    {}, 'new-session-2', PROJECT_A, true, { mcpEmulation: false },
  );

  assert.equal(result.ok, true);
  assert.equal(result.accountId, 'default');
  assert.equal(settings.get('global').activeAccountId, 'default');
  // The default account is the one Claude resolves on its own, so naming it
  // would be worse than saying nothing.
  assert.equal(calls.spawn[0].opts.env.CLAUDE_CONFIG_DIR, undefined);
});
