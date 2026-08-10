// The window's minimum size follows the interface scale: window sizes are
// device-independent pixels while page zoom spends them, so a fixed floor leaves
// too few CSS pixels for the layout at 150%. That arithmetic only runs inside
// Electron, so this suite loads the real main.js against a stubbed Electron and a
// window that actually holds its bounds, and drives the IPC handler the renderer
// calls.
//
// The stub table mirrors the one in wsl-integration.test.js. They are kept separate
// on purpose: that suite intercepts fs to watch paths, this one needs a stateful
// window instead.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');
const os = require('os');
const fs = require('fs');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wootonpad-minsize-'));
os.homedir = () => HOME;

// main.js snapshots process.env at load; the suite must not inherit the Claude
// environment of whoever runs it.
delete process.env.CLAUDE_CONFIG_DIR;

const handlers = new Map();
const noop = () => {};
const permissive = (base = {}) => new Proxy(base, { get: (t, k) => (k in t ? t[k] : noop) });

// A single display whose work area the tests move around. 860 rather than 900 so a
// taskbar-sized difference between bounds and work area is actually exercised.
let workArea = { x: 0, y: 0, width: 1440, height: 860 };
const display = () => ({
  bounds: { x: 0, y: 0, width: 1440, height: 900 },
  workArea,
  workAreaSize: { width: workArea.width, height: workArea.height },
});

let win = null;
function FakeWindow(opts) {
  const state = {
    bounds: { x: 0, y: 0, width: opts.width, height: opts.height },
    minimum: { width: opts.minWidth, height: opts.minHeight },
    maximized: false, minimized: false, fullScreen: false,
  };
  win = permissive({
    _state: state,
    getBounds: () => ({ ...state.bounds }),
    setBounds: (b) => { state.bounds = { ...state.bounds, ...b }; },
    setMinimumSize: (width, height) => { state.minimum = { width, height }; },
    isMaximized: () => state.maximized,
    isMinimized: () => state.minimized,
    isFullScreen: () => state.fullScreen,
    isDestroyed: () => false,
    webContents: permissive({ send: noop }),
  });
  return win;
}

const settings = new Map();
const stubs = {
  electron: {
    app: permissive({
      isPackaged: false, getVersion: () => '0.0.0', getPath: () => HOME,
      whenReady: () => Promise.resolve(), requestSingleInstanceLock: () => true,
    }),
    BrowserWindow: Object.assign(FakeWindow, { getAllWindows: () => (win ? [win] : []) }),
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), on: noop, removeHandler: noop },
    Menu: permissive({ buildFromTemplate: () => permissive() }),
    screen: permissive({
      getPrimaryDisplay: display,
      getDisplayMatching: display,
      getAllDisplays: () => [display()],
    }),
    shell: permissive(),
    nativeTheme: permissive(),
  },
  'node-pty': { spawn: () => permissive({ pid: 1 }) },
  'electron-log': permissive({ transports: { file: {}, console: {} } }),
  './db': permissive({
    getSetting: (key) => settings.get(key),
    setSetting: (key, value) => settings.set(key, value),
    deleteSetting: (key) => settings.delete(key),
    searchFtsRecreated: false,
  }),
  ws: { WebSocketServer: function () { return permissive(); } },
  chokidar: { watch: () => permissive() },
  'electron-reloader': () => {},
  child_process: {
    execFileSync: (file, args = []) => { throw new Error(`Command failed: ${file} ${args.join(' ')}`); },
    execFile: (file, args, options, callback) => {
      const done = typeof options === 'function' ? options : callback;
      if (done) setImmediate(() => done(new Error(`Command failed: ${file} ${args.join(' ')}`), '', ''));
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

// Kept before the unref patch, which would otherwise let the process end before the
// wait below resolves.
const realSetTimeout = global.setTimeout;
for (const name of ['setInterval', 'setTimeout']) {
  const original = global[name];
  global[name] = (...args) => {
    const handle = original(...args);
    if (handle && typeof handle.unref === 'function') handle.unref();
    return handle;
  };
}

// Bounds under the 150% floor, positioned so that growing them without clamping
// would push the window off the right and bottom edges.
settings.set('global', { uiScale: 150, windowBounds: { x: 1000, y: 700, width: 900, height: 600 } });
require('../main.js');

// The window is created from app.whenReady(), so it exists a few ticks after load.
const ready = new Promise((resolve) => realSetTimeout(resolve, 50));
const size = () => ({ width: win._state.bounds.width, height: win._state.bounds.height });
const apply = (factor) => handlers.get('set-ui-scale-minimum')({}, factor);

test('a window restored under the floor of its scale opens at the floor, on screen', async () => {
  await ready;
  assert.deepEqual(win._state.minimum, { width: 1200, height: 750 });
  assert.deepEqual(size(), { width: 1200, height: 750 });
  // 1000 + 1200 would end 760 px past the right edge of a 1440 px work area
  assert.deepEqual({ x: win._state.bounds.x, y: win._state.bounds.y }, { x: 240, y: 110 });
});

test('a window grown at creation keeps its size when the scale drops', async () => {
  await ready;
  assert.deepEqual(await apply(1.0), { width: 800, height: 500 });
  assert.deepEqual(size(), { width: 1200, height: 750 });
});

test('a scale previewed mid-session grows the window and cancelling gives it back', async () => {
  await ready;
  win._state.bounds = { x: 100, y: 100, width: 900, height: 600 };

  assert.deepEqual(await apply(1.5), { width: 1200, height: 750 });
  assert.deepEqual(size(), { width: 1200, height: 750 });

  await apply(1.0);
  assert.deepEqual(size(), { width: 900, height: 600 });

  // Applying the same scale again must not move anything
  await apply(1.0);
  assert.deepEqual(size(), { width: 900, height: 600 });
});

test('a window the user resized after a growth is left at their size', async () => {
  await ready;
  win._state.bounds = { x: 100, y: 100, width: 900, height: 600 };
  await apply(1.5);
  win._state.bounds = { ...win._state.bounds, width: 1300, height: 800 };

  await apply(1.0);
  assert.deepEqual(size(), { width: 1300, height: 800 });
});

test('a scale that is not a usable number means no scaling, not the lowest one', async () => {
  await ready;
  for (const value of [null, '', 0, undefined, 'wide']) {
    assert.deepEqual(await apply(value), { width: 800, height: 500 }, `for ${JSON.stringify(value)}`);
  }
});

test('the scale is clamped at both ends', async () => {
  await ready;
  assert.deepEqual(await apply(4), { width: 1200, height: 750 });
  assert.deepEqual(await apply(0.1), { width: 640, height: 400 });
  await apply(1.0);
});

test('the floor never exceeds the work area of the display the window is on', async () => {
  await ready;
  workArea = { x: 0, y: 0, width: 1000, height: 700 };
  try {
    // A minimum larger than the screen leaves a window that cannot be resized
    assert.deepEqual(await apply(1.5), { width: 1000, height: 700 });
  } finally {
    workArea = { x: 0, y: 0, width: 1440, height: 860 };
    await apply(1.0);
  }
});

test('a maximised window is not resized', async () => {
  await ready;
  win._state.maximized = true;
  win._state.bounds = { x: 0, y: 0, width: 1440, height: 860 };
  try {
    assert.deepEqual(await apply(1.5), { width: 1200, height: 750 });
    assert.deepEqual(size(), { width: 1440, height: 860 });
  } finally {
    win._state.maximized = false;
    await apply(1.0);
  }
});
