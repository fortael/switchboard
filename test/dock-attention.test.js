const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createDockAttention } = require('../dock-attention');

/**
 * A stand-in for the bits of Electron's `app` this touches. `focused` is a
 * plain flag the test flips, the way activating the app would.
 */
function harness({ focused = false, bounceIds = [1, 2, 3, 4, 5] } = {}) {
  const calls = { badge: [], bounce: 0, cancelled: [], logs: [] };
  const ids = [...bounceIds];
  const state = { focused };
  const dock = createDockAttention({
    setBadgeCount: (n) => { calls.badge.push(n); return true; },
    bounce: () => { calls.bounce++; return ids.shift(); },
    cancelBounce: (id) => calls.cancelled.push(id),
    isFocused: () => state.focused,
    log: (m) => calls.logs.push(m),
  });
  return { dock, calls, state };
}

const lastBadge = (calls) => calls.badge[calls.badge.length - 1];

// ── The badge ─────────────────────────────────────────────────────

test('the badge is the two columns added together', () => {
  const { dock, calls } = harness();
  dock.update({ waiting: ['a', 'b'], done: 3 });
  assert.equal(lastBadge(calls), 5);
});

test('the badge is set on every report, including back to zero', () => {
  const { dock, calls } = harness();
  dock.update({ waiting: ['a'], done: 0 });
  dock.update({ waiting: [], done: 0 });
  assert.deepEqual(calls.badge, [1, 0]);
});

test('duplicate ids are counted once', () => {
  const { dock, calls } = harness();
  dock.update({ waiting: ['a', 'a', 'b'], done: 0 });
  assert.equal(lastBadge(calls), 2);
});

test('a malformed summary counts as nothing rather than throwing', () => {
  const { dock, calls } = harness();
  for (const summary of [undefined, null, {}, { waiting: 'no', done: 'lots' }, { done: -4 }]) {
    dock.update(summary);
    assert.equal(lastBadge(calls), 0);
  }
});

// The badge needs notification permission on macOS; a refusal must not stop
// the bounce, which is a separate mechanism.
test('a badge that refuses to set does not stop the bounce', () => {
  let bounced = 0;
  const dock = createDockAttention({
    setBadgeCount: () => { throw new Error('no permission'); },
    bounce: () => { bounced++; return 1; },
    cancelBounce: () => {},
    isFocused: () => false,
  });
  dock.update({ waiting: ['a'], done: 0 });
  assert.equal(bounced, 1);
});

// ── The bounce ────────────────────────────────────────────────────

test('a session that becomes blocked bounces the icon', () => {
  const { dock, calls } = harness();
  dock.update({ waiting: ['a'], done: 0 });
  assert.equal(calls.bounce, 1);
});

// A finished turn is finished. It can wait.
test('a finished turn does not bounce', () => {
  const { dock, calls } = harness();
  dock.update({ waiting: [], done: 4 });
  assert.equal(calls.bounce, 0);
  assert.equal(lastBadge(calls), 4);
});

test('the same session still waiting does not bounce again', () => {
  const { dock, calls } = harness();
  dock.update({ waiting: ['a'], done: 0 });
  dock.update({ waiting: ['a'], done: 1 });
  dock.update({ waiting: ['a'], done: 2 });
  assert.equal(calls.bounce, 1);
});

test('a second session becoming blocked is worth another bounce', () => {
  const { dock, calls } = harness();
  dock.update({ waiting: ['a'], done: 0 });
  dock.update({ waiting: ['a', 'b'], done: 0 });
  assert.equal(calls.bounce, 2);
});

test('sessions being answered does not bounce', () => {
  const { dock, calls } = harness();
  dock.update({ waiting: ['a', 'b'], done: 0 });
  dock.update({ waiting: ['a'], done: 1 });
  assert.equal(calls.bounce, 1);
});

// Looking at the app already is the answer to "get my attention".
test('nothing bounces while the window is in front', () => {
  const { dock, calls } = harness({ focused: true });
  dock.update({ waiting: ['a'], done: 0 });
  assert.equal(calls.bounce, 0);
  assert.equal(lastBadge(calls), 1);
});

test('a session blocked while you were away bounces once you are away again', () => {
  const { dock, calls, state } = harness({ focused: true });
  dock.update({ waiting: ['a'], done: 0 });
  assert.equal(calls.bounce, 0);
  state.focused = false;
  dock.update({ waiting: ['a', 'b'], done: 0 });
  assert.equal(calls.bounce, 1);
});

// ── Stopping ──────────────────────────────────────────────────────

test('coming to the front cancels the request we started', () => {
  const { dock, calls } = harness({ bounceIds: [7] });
  dock.update({ waiting: ['a'], done: 0 });
  dock.stopBounce();
  assert.deepEqual(calls.cancelled, [7]);
  assert.equal(dock.bounceId, null);
});

test('stopping twice cancels once', () => {
  const { dock, calls } = harness({ bounceIds: [7] });
  dock.update({ waiting: ['a'], done: 0 });
  dock.stopBounce();
  dock.stopBounce();
  assert.deepEqual(calls.cancelled, [7]);
});

test('stopping when nothing is bouncing is a no-op', () => {
  const { dock, calls } = harness();
  dock.stopBounce();
  assert.deepEqual(calls.cancelled, []);
});

test('the last session being answered stops the bounce on its own', () => {
  const { dock, calls } = harness({ bounceIds: [9] });
  dock.update({ waiting: ['a'], done: 0 });
  dock.update({ waiting: [], done: 1 });
  assert.deepEqual(calls.cancelled, [9]);
  assert.equal(dock.bounceId, null);
});

// The regression this module was extracted over: macOS stops a 'critical'
// bounce itself when the app is activated, so the id we are holding points at
// nothing. Treating it as "still asking" made the icon bounce exactly once per
// app run.
test('a stale request does not suppress the next bounce', () => {
  const { dock, calls, state } = harness({ bounceIds: [1, 2] });
  dock.update({ waiting: ['a'], done: 0 });        // bounce #1
  state.focused = true;                            // macOS stops it; we are not told
  state.focused = false;
  dock.update({ waiting: ['a', 'b'], done: 0 });    // bounce #2
  assert.equal(calls.bounce, 2);
  // and the first request was retired rather than leaked
  assert.deepEqual(calls.cancelled, [1]);
  assert.equal(dock.bounceId, 2);
});

// ── Off macOS ─────────────────────────────────────────────────────

// `app.dock` is undefined everywhere but macOS, so these come back as no-ops.
test('a platform with no dock never throws', () => {
  const dock = createDockAttention({
    setBadgeCount: () => false,
    bounce: () => null,
    cancelBounce: () => {},
    isFocused: () => false,
  });
  dock.update({ waiting: ['a'], done: 2 });
  dock.update({ waiting: [], done: 0 });
  dock.stopBounce();
  assert.equal(dock.bounceId, null);
});

test('a bounce that throws leaves nothing to cancel later', () => {
  const calls = { cancelled: [] };
  const dock = createDockAttention({
    setBadgeCount: () => true,
    bounce: () => { throw new Error('no dock'); },
    cancelBounce: (id) => calls.cancelled.push(id),
    isFocused: () => false,
  });
  dock.update({ waiting: ['a'], done: 0 });
  assert.equal(dock.bounceId, null);
  dock.stopBounce();
  assert.deepEqual(calls.cancelled, []);
});

// ── The wiring ────────────────────────────────────────────────────
//
// Everything above runs against fakes, which proves the rules and nothing
// about whether the real dock is ever touched. main.js cannot be required
// outside Electron — it reads `app.isPackaged` on the way in — so the wiring is
// checked as text. Crude, and it still catches the failure that matters: the
// module quietly stops being called, or is handed something that is not the
// Electron API, and the icon silently does nothing.
test('main.js hands the real Electron dock to this module', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

  assert.match(source, /require\('\.\/dock-attention'\)/, 'module is not imported');
  assert.match(source, /createDockAttention\(\{/, 'module is never constructed');

  // The four platform calls, as passed in.
  assert.match(source, /setBadgeCount:\s*\(n\)\s*=>\s*app\.setBadgeCount\(n\)/);
  assert.match(source, /bounce:\s*\(\)\s*=>\s*app\.dock\?\.bounce\('critical'\)/);
  assert.match(source, /cancelBounce:\s*\(id\)\s*=>\s*app\.dock\?\.cancelBounce\(id\)/);
  assert.match(source, /isFocused:\s*\(\)\s*=>.*mainWindow\.isFocused\(\)/);

  // The renderer's report has to reach update(), or the badge never moves.
  assert.match(source, /ipcMain\.on\('attention-summary',[^\n]*dock\.update\(/);

  // And coming to the front has to stop the bounce, or a 'critical' one keeps
  // asking after it has been answered.
  assert.match(source, /on\('browser-window-focus',[^\n]*dock\.stopBounce\(\)/);
  assert.match(source, /mainWindow\.on\('focus',[^\n]*dock\.stopBounce\(\)/);
});

// `[1m]`-style guard: a bounce that is not 'critical' stops after a second and
// would not survive the user being away from the keyboard.
test('the bounce asks until the app is activated, not for one second', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.doesNotMatch(source, /bounce\('informational'\)/);
});

test('a focus check that throws is treated as not focused', () => {
  let bounced = 0;
  const dock = createDockAttention({
    setBadgeCount: () => true,
    bounce: () => { bounced++; return 1; },
    cancelBounce: () => {},
    isFocused: () => { throw new Error('window is gone'); },
  });
  dock.update({ waiting: ['a'], done: 0 });
  assert.equal(bounced, 1);
});
