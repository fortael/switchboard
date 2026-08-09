// Integration test for WSL-backed accounts.
//
// The unit tests cover the pure path helpers; this one covers the wiring, which
// is where every defect in this feature actually lived. It loads the real
// main.js on a simulated Windows host with a WSL account active, stubbing only
// what cannot run here — electron, node-pty, ws and the DB — and then drives the
// real IPC handlers, asserting on what reaches the filesystem and the spawner.
//
// Node's test runner gives each file its own process, so overriding
// process.platform here does not leak into the other suites.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const realPath = require('path');
const os = require('os');
const fs = require('fs');

Object.defineProperty(process, 'platform', { value: 'win32' });

const HOME = fs.mkdtempSync(realPath.join(os.tmpdir(), 'wootonpad-wsl-'));
os.homedir = () => HOME;

// main.js snapshots process.env at load to build the PTY environment, and what
// that environment carries is one of the things asserted below — so it is pinned
// rather than inherited from whoever runs the suite. Pinned to a value on
// purpose: this is the Windows CLAUDE_CONFIG_DIR a user may well have exported
// before launching the app, and no session may pass it on. Inside a distribution
// it does not resolve at all, and WSLENV now names CLAUDE_CONFIG_DIR, so nothing
// but the delete in the handlers keeps it on the Windows side.
process.env.CLAUDE_CONFIG_DIR = 'C:\\Users\\someone\\.claude-inherited';

const DISTRO = 'Ubuntu';
const PROJECT_POSIX = '/home/delirus/work/proj';
const PROJECT_UNC = '\\\\wsl.localhost\\Ubuntu\\home\\delirus\\work\\proj';
const WSL_HOME = '/home/delirus';
// A second Claude account in the same distribution, told apart from the first
// only by the config directory it reads.
const SECOND_CONFIG = '/home/delirus/.claude-work';
// The one path the simulated distribution does not have. Every other path under
// the distribution is answered as existing by the fs interception below, so a
// "not there" case needs a name that interception knows to refuse.
const MISSING_CONFIG = '/home/delirus/.claude-absent';

const calls = { readdirSync: [], existsSync: [], readFileSync: [], statSync: [], spawn: [] };
const settings = new Map([
  ['accounts', [
    { id: 'default', name: 'Default', configDir: realPath.join(HOME, '.claude') },
    {
      id: 'wsl-test', name: 'WSL — Ubuntu',
      configDir: '\\\\wsl.localhost\\Ubuntu\\home\\delirus\\.claude',
      wslDistro: DISTRO, wslUncPrefix: '\\\\wsl.localhost\\', wslHome: '/home/delirus',
    },
  ]],
  ['global', { activeAccountId: 'wsl-test' }],
]);

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
    // Permissive, not a bare object: main.js also subscribes to display changes,
    // and a missing screen.on rejects asynchronously — after whichever test was
    // running had already ended, which is where it surfaced.
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
    searchFtsRecreated: false,
  }),
  ws: { WebSocketServer: function () { return permissive(); } },
  // Dev hot-reload. Both watch the source tree, and the watchers they leave
  // behind are handles nothing here can reach to close — they are what kept this
  // process alive after the last subtest until CI cancelled the job.
  chokidar: { watch: () => permissive() },
  'electron-reloader': () => {},
  // Everything the handlers shell out to. Unstubbed, the suite runs real
  // commands on whatever host it lands on — `du -sk`, `docker compose ps`, and
  // any wsl.exe that happens to be on PATH — so it passed or failed by accident
  // of where it ran. The distribution list is answered, since that is what makes
  // an account's shell resolvable; every other command fails carrying its argv,
  // which is the shape the handlers report and these tests assert on.
  child_process: {
    execFileSync: (file, args = []) => {
      if (file === 'wsl.exe' && args[0] === '--list') return `${DISTRO}\r\n`;
      throw new Error(`Command failed: ${file} ${args.join(' ')}`);
    },
    // The Claude-home probe is answered, since attaching an account depends on
    // it: `sh -c` with a script the distribution would run. Everything else,
    // including the wsl.exe that carries a project command, still fails carrying
    // its argv — that failure is what the routing tests assert on.
    execFile: (file, args, options, callback) => {
      const done = typeof options === 'function' ? options : callback;
      const script = args[args.indexOf('-c') + 1];
      if (file === 'wsl.exe' && args.includes('--exec') && String(script).startsWith('printf')) {
        const answer = script.includes('.claude*')
          ? `${WSL_HOME}\n${WSL_HOME}/.claude\n${SECOND_CONFIG}`
          : WSL_HOME;
        if (done) setImmediate(() => done(null, answer, ''));
        return permissive({ pid: 1 });
      }
      if (done) setImmediate(() => done(new Error(`Command failed: ${file} ${args.join(' ')}`), '', ''));
      return permissive({ pid: 1 });
    },
    spawn: () => permissive({ pid: 1 }),
    spawnSync: (file, args = []) => ({ status: 1, stdout: '', stderr: `Command failed: ${file} ${args.join(' ')}` }),
  },
};

const originalLoad = Module._load;
Module._load = function (request) {
  return stubs[request] || originalLoad.apply(this, arguments);
};

// main.js starts the watcher poll, the scheduler and the updater interval, none
// of which are reachable to clear from here. Unref them as they are created so
// the process ends on its own — exiting from a hook instead would swallow the
// subtest results and could mask a failure as a pass.
for (const name of ['setInterval', 'setTimeout']) {
  const original = global[name];
  global[name] = (...args) => {
    const handle = original(...args);
    if (handle && typeof handle.unref === 'function') handle.unref();
    return handle;
  };
}

require('../main.js');

// Interception starts after load so Node's own module loader is untouched.
// Anything naming the distribution is answered as if it existed; every other
// path falls through to the real filesystem.
for (const name of ['readdirSync', 'existsSync', 'readFileSync', 'statSync', 'mkdirSync', 'writeFileSync', 'appendFileSync']) {
  const original = fs[name];
  fs[name] = function (p, ...rest) {
    const asString = String(p);
    if (!asString.includes('wsl.localhost')) return original.call(fs, p, ...rest);
    if (calls[name]) calls[name].push(asString);
    if (name === 'existsSync') return !asString.includes('.claude-absent');
    if (name === 'readdirSync') return [];
    if (name === 'statSync') return { isDirectory: () => true, mtime: new Date(0), mtimeMs: 0 };
    return '';
  };
}

test('every handler that touches a project file gets the UNC translation', async () => {
  calls.readdirSync.length = 0;
  await handlers.get('get-file-tree')({}, PROJECT_POSIX);
  assert.equal(calls.readdirSync[0], PROJECT_UNC);

  calls.existsSync.length = 0;
  await handlers.get('get-project-info')({}, PROJECT_POSIX);
  assert.equal(calls.existsSync[0], PROJECT_UNC);

  calls.readFileSync.length = 0;
  await handlers.get('read-file-for-panel')({}, PROJECT_POSIX + '/README.md');
  assert.equal(calls.readFileSync[0], PROJECT_UNC + '\\README.md');
});

test('a folder picked as UNC is stored POSIX and encodes the folder Claude creates', async () => {
  const result = await handlers.get('add-project')({}, PROJECT_UNC);
  assert.equal(result.projectPath, PROJECT_POSIX);
  assert.equal(result.folder, '-home-delirus-work-proj');
});

test('a folder from another distribution is refused with the account to switch to', async () => {
  const result = await handlers.get('add-project')({}, '\\\\wsl.localhost\\Debian\\home\\d\\p');
  assert.match(result.error, /Debian/);
});

test('a command that runs in the project is routed into the distribution', async () => {
  const result = await handlers.get('git-branches')({}, PROJECT_POSIX);
  // git is not installed in the simulated distro, so this fails — but on the
  // command it actually tried to run, which is what is under test.
  assert.equal(result.ok, false);
  assert.match(result.error, /wsl\.exe -d Ubuntu --cd \/home\/delirus\/work\/proj/);
});

test('a Claude session for a WSL account is spawned inside the distribution', async () => {
  calls.spawn.length = 0;
  const result = await handlers.get('open-terminal')({}, 'sess-1', PROJECT_POSIX, true, { mcpEmulation: false });
  assert.equal(result.ok, true);

  const [spawned] = calls.spawn;
  assert.equal(spawned.file, 'wsl.exe');
  assert.deepEqual(spawned.args.slice(0, 4), ['--cd', PROJECT_POSIX, '-d', DISTRO]);
  // wsl.exe itself is a Windows process, so its own cwd must stay a Windows path
  assert.equal(realPath.win32.isAbsolute(spawned.opts.cwd) || spawned.opts.cwd === HOME, true);
  // Setting this would point Claude at a path it cannot resolve inside the distro
  // — including the one the app itself was launched with, which reaches the
  // handler through the snapshot of process.env and has to be dropped there.
  assert.equal(spawned.opts.env.CLAUDE_CONFIG_DIR, undefined);
});

// --- Several Claude accounts inside one distribution -----------------------
// They differ only by which config directory they read, so that directory is
// what identifies an account and what has to cross into the distribution.

test('an account attached before this was possible is read as the default home', async () => {
  const account = (await handlers.get('get-accounts')({})).find(a => a.id === 'wsl-test');
  // The stored row carries no wslClaudePosix at all — see the settings map above
  assert.equal(account.wslClaudePosix, `${WSL_HOME}/.claude`);
});

test('discovery lists every config directory, not just the distribution default', async () => {
  const homes = await handlers.get('discover-wsl-claude-homes')({});
  assert.deepEqual(homes.map(h => h.claudePosix), [`${WSL_HOME}/.claude`, SECOND_CONFIG]);
  assert.deepEqual(homes.map(h => h.isDefault), [true, false]);
  // Each still carries the Windows view the app opens files through
  assert.equal(homes[1].configDir, '\\\\wsl.localhost\\Ubuntu\\home\\delirus\\.claude-work');
});

test('a second account in the same distribution is attachable, and only once', async () => {
  const created = await handlers.get('create-wsl-account')({}, DISTRO, null, SECOND_CONFIG);
  assert.equal(created.error, undefined);
  assert.equal(created.wslDistro, DISTRO);
  assert.equal(created.wslClaudePosix, SECOND_CONFIG);
  // The name has to say which of the two it is
  assert.equal(created.name, 'WSL — Ubuntu (.claude-work)');

  // Attaching the same directory again returns the account rather than a twin
  const again = await handlers.get('create-wsl-account')({}, DISTRO, null, SECOND_CONFIG);
  assert.equal(again.id, created.id);
  // and so does the distribution's default home, which the account attached
  // before any of this already holds — matched on the backfilled directory
  const defaultHome = await handlers.get('create-wsl-account')({}, DISTRO, null, `${WSL_HOME}/.claude`);
  assert.equal(defaultHome.id, 'wsl-test');

  const forDistro = (await handlers.get('get-accounts')({})).filter(a => a.wslDistro === DISTRO);
  assert.equal(forDistro.length, 2, 'one distribution, two config directories, two accounts');
});

test('a directory that is not there is refused rather than attached', async () => {
  const before = (await handlers.get('get-accounts')({})).length;
  const missing = await handlers.get('create-wsl-account')({}, DISTRO, null, MISSING_CONFIG);
  assert.ok(missing.error.includes(MISSING_CONFIG), missing.error);
  assert.equal((await handlers.get('get-accounts')({})).length, before, 'nothing was written for it');

  // A path the distribution could not resolve either is refused without asking it
  const relative = await handlers.get('create-wsl-account')({}, DISTRO, null, 'claude-work');
  assert.match(relative.error, /claude-work/);
});

test('the second account tells the CLI which config directory to read', async () => {
  const second = (await handlers.get('get-accounts')({}))
    .find(a => a.wslClaudePosix === SECOND_CONFIG);
  await withActiveAccount(second.id, async () => {
    calls.spawn.length = 0;
    const result = await handlers.get('open-terminal')({}, 'sess-3', PROJECT_POSIX, true, { mcpEmulation: false });
    assert.equal(result.ok, true);

    const [spawned] = calls.spawn;
    // The POSIX directory, never the Windows view of it — the distribution
    // cannot resolve a UNC path
    assert.equal(spawned.opts.env.CLAUDE_CONFIG_DIR, SECOND_CONFIG);
    // and wsl.exe drops anything WSLENV does not name
    assert.match(spawned.opts.env.WSLENV, /CLAUDE_CONFIG_DIR/);
  });
});

// --- Removing the local Claude home ---------------------------------------
// An install that only runs Claude inside WSL has no use for a Windows home it
// never opens, so the default account is deletable like any other. The one
// invariant is that the app always has an account to look at.

// Each of these empties the account list on its way, so each puts it back — the
// suite's later tests read whatever is left behind.
async function withAccountsRestored(fn) {
  const accounts = settings.get('accounts');
  // A copy, not the reference: activateAccount() writes the active id into the
  // very object getSetting() hands it, so keeping the reference would restore
  // whatever the last deletion left behind and quietly change which account the
  // suite's later tests run under.
  const global = { ...settings.get('global') };
  try {
    await fn();
  } finally {
    settings.set('accounts', accounts);
    settings.set('global', global);
  }
}

test('the local Claude home can be removed once WSL holds an account', async () => {
  await withAccountsRestored(async () => {
    const before = await handlers.get('get-accounts')({});
    assert.ok(before.some(a => a.id === 'default'), 'it is there to begin with');

    const result = await handlers.get('delete-account')({}, 'default');
    assert.equal(result.ok, true);
    const after = await handlers.get('get-accounts')({});
    assert.equal(after.some(a => a.id === 'default'), false, 'and it is not put back');
    assert.equal(after.length, before.length - 1);
  });
});

test('the last account stays, whichever one it is', async () => {
  await withAccountsRestored(async () => {
    const all = await handlers.get('get-accounts')({});
    const survivor = all[all.length - 1];
    for (const account of all.slice(0, -1)) {
      assert.equal((await handlers.get('delete-account')({}, account.id)).ok, true);
    }
    const refused = await handlers.get('delete-account')({}, survivor.id);
    assert.equal(refused.ok, false);
    assert.match(refused.error, /last account/);
    assert.deepEqual((await handlers.get('get-accounts')({})).map(a => a.id), [survivor.id]);

    // Deleting the account on screen has to move the app somewhere real, and the
    // id the renderer is told must be the one every account read resolves to
    assert.equal(await handlers.get('get-active-account-id')({}), survivor.id);
  });
});

test('the local home can be attached again after being removed', async () => {
  await withAccountsRestored(async () => {
    await handlers.get('delete-account')({}, 'default');
    const restored = await handlers.get('restore-default-account')({});
    assert.equal(restored.id, 'default');
    assert.equal(restored.configDir, realPath.join(HOME, '.claude'));
    // and asking twice does not produce a twin
    await handlers.get('restore-default-account')({});
    const back = (await handlers.get('get-accounts')({})).filter(a => a.id === 'default');
    assert.equal(back.length, 1);
  });
});

test('an empty account list is refused rather than saved', async () => {
  const result = await handlers.get('save-accounts')({}, []);
  assert.equal(result.ok, false);
  assert.ok((await handlers.get('get-accounts')({})).length > 0);
});

// Swap the active account for the duration of one test. The IPC that does this
// in the app also re-inits the cache and starts a worker, neither of which this
// suite can shut down again; the setting is what every account read goes through.
async function withActiveAccount(id, fn) {
  const previous = settings.get('global');
  settings.set('global', { ...previous, activeAccountId: id });
  try {
    await fn();
  } finally {
    settings.set('global', previous);
  }
}

test('IDE emulation publishes the contract the CLI parses, and the port crosses', async () => {
  calls.spawn.length = 0;
  const result = await handlers.get('open-terminal')({}, 'sess-2', PROJECT_POSIX, true, {});
  assert.equal(result.mcpActive, true);

  const [spawned] = calls.spawn;
  assert.match(spawned.args[spawned.args.length - 1], /--ide$/);
  const port = spawned.opts.env.CLAUDE_CODE_SSE_PORT;
  assert.ok(port, 'the CLI needs the port to accept the lock without workspace matching');
  // wsl.exe passes nothing but WSLENV-listed names into the distribution
  assert.match(spawned.opts.env.WSLENV, /CLAUDE_CODE_SSE_PORT/);

  const lockPath = realPath.join(HOME, '.claude', 'ide', `${port}.lock`);
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  // The CLI reads the port from the file name and these fields from the body.
  assert.equal(lock.runningInWindows, true, 'this is what makes the CLI resolve the host instead of using loopback');
  assert.equal(lock.transport, 'ws');
  assert.deepEqual(lock.workspaceFolders, [PROJECT_UNC]);
  assert.ok(lock.authToken);
});
