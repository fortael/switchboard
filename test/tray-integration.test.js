// Tray wiring against the real main.js: whether an OSC 9 alert from a session reaches
// the tray, whether looking at that session clears it, whether closing the window
// hides it instead of destroying it, and whether the usage poller stays polite.
//
// Electron is stubbed, and so is node-pty — but its onData callback is captured, so
// bytes can be pushed through the same path a live Claude session uses.
//
// The stub table is close to the one in wsl-integration.test.js and
// window-minimum-size.test.js; each suite needs a different part of Electron faked,
// so they are kept apart rather than merged into a helper that fakes everything.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');
const os = require('os');
const fs = require('fs');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wootonpad-tray-'));
os.homedir = () => HOME;
delete process.env.CLAUDE_CONFIG_DIR;
// Deliberately no ~/.claude/projects: main.js starts a recursive fs.watch over it
// when it exists, and that watcher is a handle nothing here can reach to close — the
// process would never exit. Nothing under test needs the directory.
// open-terminal, on the other hand, refuses a project directory that is not there.
const PROJECT = path.join(HOME, 'proj');
fs.mkdirSync(PROJECT, { recursive: true });

const handlers = new Map();
const listeners = new Map();
const sent = [];
const noop = () => {};
const permissive = (base = {}) => new Proxy(base, { get: (t, k) => (k in t ? t[k] : noop) });

// --- the fake tray -----------------------------------------------------------
const trayState = { image: null, tooltip: null, menu: null, destroyed: false, created: 0 };
function FakeTray(image) {
  trayState.image = image;
  trayState.destroyed = false;
  trayState.created += 1;
  return permissive({
    setImage: (img) => { trayState.image = img; },
    setToolTip: (text) => { trayState.tooltip = text; },
    setContextMenu: (menu) => { trayState.menu = menu; },
    destroy: () => { trayState.destroyed = true; },
    isDestroyed: () => trayState.destroyed,
    on: noop,
  });
}

// --- the fake window ---------------------------------------------------------
const windowState = { visible: true, focused: true, hidden: 0, destroyed: false, closePrevented: 0 };
let win = null;
function FakeWindow(opts) {
  const events = new Map();
  win = permissive({
    _events: events,
    on: (name, fn) => { events.set(name, [...(events.get(name) || []), fn]); },
    once: noop,
    getBounds: () => ({ x: 0, y: 0, width: opts.width, height: opts.height }),
    setBounds: noop,
    setMinimumSize: noop,
    isMaximized: () => false,
    isMinimized: () => false,
    isFullScreen: () => false,
    isDestroyed: () => windowState.destroyed,
    isVisible: () => windowState.visible,
    isFocused: () => windowState.focused,
    hide: () => { windowState.visible = false; windowState.hidden += 1; },
    show: () => { windowState.visible = true; },
    focus: () => { windowState.focused = true; },
    webContents: permissive({
      send: (channel, ...args) => sent.push({ channel, args }),
    }),
  });
  return win;
}
const fireWindow = (name, ...args) => (win._events.get(name) || []).forEach((fn) => fn(...args));

// --- usage source ------------------------------------------------------------
const usageCalls = [];
let usageReply = () => ({ session: 10, weekAll: 20, sessionResetIn: '2h' });

const settings = new Map([
  ['accounts', [{ id: 'default', name: 'Default', configDir: path.join(HOME, '.claude') }]],
  ['global', { activeAccountId: 'default' }],
]);

const stubs = {
  electron: {
    app: permissive({
      isPackaged: false, getVersion: () => '0.0.0', getPath: () => HOME,
      whenReady: () => Promise.resolve(), requestSingleInstanceLock: () => true,
      setBadgeCount: noop,
      on: (name, fn) => { listeners.set(name, fn); },
    }),
    BrowserWindow: Object.assign(FakeWindow, { getAllWindows: () => (win ? [win] : []) }),
    Tray: FakeTray,
    nativeImage: {
      createFromPath: (p) => permissive({
        _path: p,
        isEmpty: () => !fs.existsSync(p),
        setTemplateImage: noop,
      }),
    },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    ipcMain: {
      handle: (channel, fn) => handlers.set(channel, fn),
      on: (channel, fn) => handlers.set('on:' + channel, fn),
      removeHandler: noop,
    },
    Menu: permissive({ buildFromTemplate: (template) => template }),
    screen: permissive({
      getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 0, width: 1440, height: 860 }, workAreaSize: { width: 1440, height: 860 } }),
      getDisplayMatching: () => ({ bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 0, width: 1440, height: 860 }, workAreaSize: { width: 1440, height: 860 } }),
      getAllDisplays: () => [{ bounds: { x: 0, y: 0, width: 1440, height: 900 } }],
    }),
    shell: permissive(),
    nativeTheme: permissive(),
    powerMonitor: permissive({ on: noop }),
  },
  'node-pty': {
    spawn: () => permissive({
      pid: 1,
      // Captured so a test can push terminal output through the real parser.
      onData: (fn) => { stubs['node-pty']._onData = fn; },
      onExit: (fn) => { stubs['node-pty']._onExit = fn; },
      write: noop, resize: noop, kill: noop,
    }),
  },
  'electron-log': permissive({ transports: { file: {}, console: {} } }),
  './db': permissive({
    getSetting: (key) => settings.get(key),
    setSetting: (key, value) => settings.set(key, value),
    deleteSetting: (key) => settings.delete(key),
    searchFtsRecreated: false,
  }),
  './claude-auth': {
    fetchAndTransformUsage: async (configDir) => {
      usageCalls.push(configDir);
      return usageReply();
    },
    getOAuthToken: () => null,
    fetchUsage: async () => null,
    getConfigDir: () => path.join(HOME, '.claude'),
  },
  ws: { WebSocketServer: function () { return permissive(); } },
  chokidar: { watch: () => permissive() },
  'electron-reloader': () => {},
  child_process: {
    execFileSync: (file, args = []) => { throw new Error(`Command failed: ${file} ${args.join(' ')}`); },
    execFile: (file, args, options, callback) => {
      const done = typeof options === 'function' ? options : callback;
      if (done) setImmediate(() => done(new Error('no'), '', ''));
      return permissive({ pid: 1 });
    },
    spawn: () => permissive({ pid: 1 }),
    spawnSync: () => ({ status: 1, stdout: '', stderr: '' }),
  },
};

const originalLoad = Module._load;
Module._load = function (request) {
  return stubs[request] || originalLoad.apply(this, arguments);
};

const realSetTimeout = global.setTimeout;
for (const name of ['setInterval', 'setTimeout']) {
  const original = global[name];
  global[name] = (...args) => {
    const handle = original(...args);
    if (handle && typeof handle.unref === 'function') handle.unref();
    return handle;
  };
}

require('../main.js');

const ready = new Promise((resolve) => realSetTimeout(resolve, 50));
const menuLabels = () => (trayState.menu || []).map((item) => item.label).filter(Boolean);

// Text of an iTerm2 OSC 9 notification, the shape the Claude CLI emits.
const osc9 = (message) => `]9;${message}`;

async function openSession(sessionId) {
  const result = await handlers.get('open-terminal')({}, sessionId, PROJECT, true, { mcpEmulation: false });
  assert.equal(result.ok, true, `open-terminal failed: ${result.error}`);
  return stubs['node-pty']._onData;
}

test('the tray comes up with the app and reports an idle app', async () => {
  await ready;
  assert.equal(trayState.created, 1);
  assert.match(trayState.tooltip, /nothing waiting/);
  assert.match(trayState.image._path, /idle(Template)?\.png$/);
});

test('the icons the tray asks for actually exist in the package', async () => {
  await ready;
  for (const name of ['idle', 'busy', 'attention']) {
    for (const suffix of ['', 'Template']) {
      const file = path.join(__dirname, '..', 'public', 'tray', `${name}${suffix}.png`);
      assert.ok(fs.existsSync(file), `missing ${file}`);
    }
  }
});

test('an alert from a session reaches the tray, and viewing it clears it', async () => {
  await ready;
  const onData = await openSession('sess-attention');
  assert.ok(typeof onData === 'function', 'pty data callback was not captured');

  onData(osc9('Claude needs your permission to use Bash'));
  assert.match(trayState.tooltip, /1 session waiting for you/);
  assert.match(trayState.image._path, /attention(Template)?\.png$/);
  assert.ok(menuLabels().includes('proj'), `menu was ${JSON.stringify(menuLabels())}`);
  // the renderer is told as well, exactly as before the tray existed
  assert.ok(sent.some((m) => m.channel === 'terminal-notification'));

  handlers.get('on:session-viewed')({}, 'sess-attention');
  assert.match(trayState.tooltip, /nothing waiting/);
  assert.match(trayState.image._path, /idle(Template)?\.png$/);
});

test('a message that is not a request for the user does not light the tray', async () => {
  await ready;
  const onData = await openSession('sess-quiet');
  onData(osc9('Claude is waiting for your input'));
  assert.match(trayState.tooltip, /nothing waiting/);
  handlers.get('on:session-viewed')({}, null);
});

test('an alert about the session already on screen is not raised', async () => {
  await ready;
  const onData = await openSession('sess-watched');
  handlers.get('on:session-viewed')({}, 'sess-watched');
  windowState.visible = true;
  windowState.focused = true;

  onData(osc9('Claude Code needs your attention'));
  assert.match(trayState.tooltip, /nothing waiting/);
});

test('the same alert is raised once the window is no longer being looked at', async () => {
  await ready;
  const onData = await openSession('sess-hidden');
  handlers.get('on:session-viewed')({}, 'sess-hidden');
  windowState.focused = false;

  onData(osc9('Claude Code needs your attention'));
  assert.match(trayState.tooltip, /1 session waiting for you/);

  // Coming back to the window is the other half of clearing it
  windowState.focused = true;
  fireWindow('focus');
  assert.match(trayState.tooltip, /nothing waiting/);
});

test('leaving the sessions view stops counting as watching that session', async () => {
  await ready;
  const onData = await openSession('sess-tab');
  handlers.get('on:session-viewed')({}, 'sess-tab');
  windowState.focused = true;

  // What the renderer reports when it switches to a tab that hides the terminal
  handlers.get('on:session-viewed')({}, null);
  onData(osc9('Claude needs your permission to use Bash'));
  assert.match(trayState.tooltip, /1 session waiting for you/);
  handlers.get('on:session-viewed')({}, 'sess-tab');
});

test('the verdict on a message travels to the renderer with it', async () => {
  await ready;
  const onData = await openSession('sess-verdict');
  sent.length = 0;
  onData(osc9('Claude Code needs your attention'));
  const asked = sent.find((m) => m.channel === 'terminal-notification');
  assert.deepEqual(asked.args.slice(1), ['Claude Code needs your attention', true]);

  sent.length = 0;
  onData(osc9('Claude is waiting for your input'));
  const reported = sent.find((m) => m.channel === 'terminal-notification');
  assert.equal(reported.args[2], false, 'a report is not a request, and both sides must agree');
  handlers.get('on:session-viewed')({}, 'sess-verdict');
});

test('a running session shows as busy without asking for anything', async () => {
  await ready;
  const onData = await openSession('sess-busy');
  // OSC 0 title starting with a braille spinner is the CLI's busy signal
  onData(']0;⠇ working');
  assert.match(trayState.image._path, /busy(Template)?\.png$/);
  assert.match(trayState.tooltip, /running/);
  onData(']0;✳ idle');
  assert.match(trayState.image._path, /idle(Template)?\.png$/);
});

test('closing the window hides it while the tray is there', async () => {
  await ready;
  const before = windowState.hidden;
  let prevented = false;
  fireWindow('close', { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(windowState.hidden, before + 1);
  assert.equal(windowState.visible, false);
  windowState.visible = true;
});

test('with the tray switched off, closing the window is closing the window', async () => {
  await ready;
  assert.equal(await handlers.get('set-tray-enabled')({}, false), false);
  assert.equal(trayState.destroyed, true);

  let prevented = false;
  fireWindow('close', { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false);

  // and switching it back on brings a new icon up
  assert.equal(await handlers.get('set-tray-enabled')({}, true), true);
  assert.equal(trayState.destroyed, false);
});

test('limits are fetched once per account and served from that result', async () => {
  await ready;
  usageCalls.length = 0;
  const first = await handlers.get('get-accounts-usage')({});
  assert.deepEqual(Object.keys(first), ['default']);
  assert.equal(first.default.session, 10);
  const afterFirst = usageCalls.length;

  // A second request inside the freshness window must not go to the network again
  await handlers.get('get-accounts-usage')({});
  assert.equal(usageCalls.length, afterFirst);
  assert.match(trayState.tooltip, /Limits: 5h 10% · week 20%/);
});

// Switching the tray on starts the poller, which refreshes unconditionally — the one
// lever a test has to force a fetch regardless of how fresh the last result is.
async function forceUsageFetch() {
  await handlers.get('set-tray-enabled')({}, false);
  await handlers.get('set-tray-enabled')({}, true);
  await new Promise((resolve) => realSetTimeout(resolve, 5));
}

test('a rate-limited answer stops the next fetch and keeps the cached figures', async () => {
  await ready;
  // A good reply first, so there is something cached to fall back to
  usageReply = () => ({ session: 55, weekAll: 60 });
  await forceUsageFetch();
  assert.equal(settings.get('usage:default').session, 55, 'a good reply is cached for later');

  usageReply = () => ({ _rateLimited: true, retryAfterSeconds: 600 });
  usageCalls.length = 0;
  await forceUsageFetch();
  assert.equal(usageCalls.length, 1, 'the rate-limited fetch itself did happen');

  const limited = await handlers.get('get-accounts-usage')({});
  assert.equal(limited.default._cached, true, 'the cached figures must survive a 429');
  assert.equal(limited.default.session, 55);

  // The retry-after must hold off every later attempt, not just the request that met it
  await forceUsageFetch();
  assert.equal(usageCalls.length, 1, 'no fetch may be attempted while rate limited');

  usageReply = () => ({ session: 10, weekAll: 20, sessionResetIn: '2h' });
});
