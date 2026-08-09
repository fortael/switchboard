// The tray's presentation rules: which glyph wins, what the tooltip says, and how a
// menu is laid out. All of it is pure, so none of this needs Electron — tray.js only
// reaches for it below the presentation half.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  presentTray, usageLine, peakUsage, sessionLabel, truncateMiddle, statusLine,
  createTray, updateTray, destroyTray,
} = require('../tray');

const session = (id, projectPath, extra = {}) => ({ sessionId: id, projectPath, ...extra });
// Separators carry no label, so they are dropped rather than compared against.
const labels = (view) => view.items.map((item) => item.label).filter(Boolean);

test('a session waiting for the user outweighs every running one', () => {
  const view = presentTray({
    attention: [session('a', '/home/u/work/api')],
    busy: [session('b', '/home/u/work/web'), session('c', '/home/u/work/cli')],
  });
  assert.equal(view.icon, 'attention');
  assert.match(view.tooltip, /1 session waiting for you/);
});

test('running sessions show as busy, and an empty app as idle', () => {
  assert.equal(presentTray({ busy: [session('b', '/x')] }).icon, 'busy');
  assert.equal(presentTray({}).icon, 'idle');
  assert.match(presentTray({}).tooltip, /nothing waiting/);
  assert.match(presentTray({ busy: [session('b', '/x'), session('c', '/y')] }).tooltip, /2 running/);
});

test('the plural follows the count', () => {
  assert.equal(statusLine(1, 0), '1 session waiting for you');
  assert.equal(statusLine(2, 0), '2 sessions waiting for you');
});

test('every waiting session is listed and carries its id for the click', () => {
  const view = presentTray({
    attention: [session('a', '/home/u/work/api'), session('b', '/home/u/work/web', { sessionSlug: 'fix-login' })],
  });
  const clickable = view.items.filter((item) => item.kind === 'session');
  assert.deepEqual(clickable.map((item) => item.sessionId), ['a', 'b']);
  assert.deepEqual(clickable.map((item) => item.label), ['api', 'web — fix-login']);
});

test('the menu always offers show and quit', () => {
  const kinds = presentTray({}).items.map((item) => item.kind);
  assert.ok(kinds.includes('show'));
  assert.ok(kinds.includes('quit'));
});

test('only sessions are clickable — headers and limit lines are not', () => {
  const view = presentTray({
    attention: [session('a', '/x/api')],
    accounts: [{ id: 'default', name: 'Default' }],
    usage: { default: { session: 10 } },
  });
  for (const item of view.items) {
    const actionable = ['session', 'show', 'quit'].includes(item.kind);
    if (!actionable) assert.ok(['header', 'text', 'separator'].includes(item.kind), item.kind);
  }
});

test('a long session label is cut in the middle so both ends survive', () => {
  const long = truncateMiddle('a'.repeat(30) + 'MIDDLE' + 'b'.repeat(30), 21);
  assert.equal(long.length, 21);
  assert.ok(long.startsWith('aaaa'));
  assert.ok(long.endsWith('bbbb'));
  assert.ok(long.includes('…'));
});

// A Windows-owned project arrives with backslashes, and the label has to be the
// folder rather than the whole path — the integration suite caught this only once it
// ran on a Windows runner, where its own temp directory is a native path.
test('a Windows project path is reduced to its folder like any other', () => {
  assert.equal(sessionLabel({ projectPath: 'C:\\Users\\dev\\work\\api' }), 'api');
  assert.equal(sessionLabel({ projectPath: 'C:\\Users\\dev\\work\\api\\' }), 'api');
  assert.equal(sessionLabel({ projectPath: '/home/u/work/api' }), 'api');
  assert.equal(
    sessionLabel({ projectPath: 'C:\\work\\api', sessionSlug: 'fix-login' }),
    'api — fix-login',
  );
});

test('a session with neither project nor title still gets a label', () => {
  assert.equal(sessionLabel({ sessionId: 'abc' }), 'abc');
  assert.equal(sessionLabel({}), 'session');
});

test('an account line leads with the five-hour window', () => {
  const line = usageLine({ id: 'a', name: 'Work' }, {
    session: 42, weekAll: 71, weekOpus: 12, sessionResetIn: '3h',
  });
  assert.equal(line, 'Work — 5h 42% · week 71% · opus 12% · resets in 3h');
});

test('an account line degrades to whatever the API gave', () => {
  assert.equal(usageLine({ id: 'a', name: 'Work' }, { _error: true }), 'Work — limits unavailable');
  assert.equal(usageLine({ id: 'a', name: 'Work' }, { _rateLimited: true }), 'Work — rate limited by the API');
  assert.equal(usageLine({ id: 'a', name: 'Work' }, {}), 'Work — no limit data yet');
  // Nothing fetched yet is not a failure, and must not read like one
  assert.equal(usageLine({ id: 'a', name: 'Work' }, undefined), 'Work — no limit data yet');
  assert.equal(usageLine({ id: 'a' }, { session: 5 }), 'a — 5h 5%');
});

test('a cached figure is marked as one', () => {
  assert.match(usageLine({ id: 'a', name: 'Work' }, { session: 5, _cached: true }), /\(cached\)$/);
});

test('a reset time is only worth the space once the window is loaded', () => {
  assert.equal(usageLine({ id: 'a', name: 'W' }, { session: 0, sessionResetIn: '3h' }), 'W — 5h 0%');
});

test('the tooltip reports the worst window across accounts', () => {
  const accounts = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
  const usage = { a: { session: 12, weekAll: 80 }, b: { session: 91, weekAll: 30 } };
  assert.deepEqual(peakUsage(accounts, usage), { session: 91, week: 80, reporting: 2 });

  const view = presentTray({ accounts, usage });
  assert.match(view.tooltip, /Limits: 5h 91% · week 80% \(highest of 2 accounts\)/);
  // and each account keeps its own line in the menu
  assert.ok(labels(view).some((l) => l.startsWith('A — ')));
  assert.ok(labels(view).some((l) => l.startsWith('B — ')));
});

test('one account needs no "highest of" qualifier', () => {
  const view = presentTray({ accounts: [{ id: 'a', name: 'A' }], usage: { a: { session: 5 } } });
  assert.match(view.tooltip, /Limits: 5h 5%$/);
});

// The figure in the tooltip is a maximum over the accounts that answered. Naming
// a count larger than that reads as "the other account's number is missing", and
// sends people looking for a bug in the wrong place — the second account has no
// data, which the menu says in as many words.
test('the qualifier counts the accounts that answered, not the ones configured', () => {
  const accounts = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];

  const oneAnswered = presentTray({ accounts, usage: { a: { session: 9, weekAll: 10 } } });
  assert.match(oneAnswered.tooltip, /Limits: 5h 9% · week 10%$/);
  assert.equal(peakUsage(accounts, { a: { session: 9 } }).reporting, 1);

  // A failed or rate-limited fetch is an answer with no number in it
  const failed = { a: { session: 9, weekAll: 10 }, b: { _error: true } };
  assert.match(presentTray({ accounts, usage: failed }).tooltip, /week 10%$/);
  const limited = { a: { session: 9, weekAll: 10 }, b: { _rateLimited: true } };
  assert.match(presentTray({ accounts, usage: limited }).tooltip, /week 10%$/);

  // and both answering brings the qualifier back
  const both = { a: { session: 9, weekAll: 10 }, b: { session: 40, weekAll: 3 } };
  assert.match(presentTray({ accounts, usage: both }).tooltip, /highest of 2 accounts/);
});

test('accounts with no usage at all leave the tooltip to the session state', () => {
  const view = presentTray({ accounts: [{ id: 'a', name: 'A' }], usage: {} });
  assert.equal(peakUsage([{ id: 'a' }], {}).session, null);
  assert.ok(!/Limits:/.test(view.tooltip));
  // the account is still listed, so the absence is visible rather than silent
  assert.ok(labels(view).includes('A — no limit data yet'));
});

// The wiring half, with Electron faked. tray.js requires electron inside the calls
// rather than at load, so the stub can be installed here — which keeps this suite
// free of the module-loader gymnastics the integration suites need.
test('an unchanged view is not re-installed on the tray', () => {
  const Module = require('module');
  const counts = { menus: 0, images: 0, tooltips: 0 };
  const electronStub = {
    Tray: function () {
      return {
        setImage: () => { counts.images += 1; },
        setToolTip: () => { counts.tooltips += 1; },
        setContextMenu: () => { counts.menus += 1; },
        destroy: () => {},
        isDestroyed: () => false,
        on: () => {},
      };
    },
    Menu: { buildFromTemplate: (template) => template },
    nativeImage: { createFromPath: () => ({ isEmpty: () => false, setTemplateImage: () => {} }) },
  };

  const originalLoad = Module._load;
  Module._load = function (request) {
    return request === 'electron' ? electronStub : originalLoad.apply(this, arguments);
  };

  try {
    assert.equal(createTray({}), true);
    const busy = { busy: [session('b', '/x/api')], accounts: [{ id: 'a', name: 'A' }], usage: { a: { session: 5 } } };

    updateTray(busy);
    const afterFirst = counts.menus;
    assert.ok(afterFirst > 0, 'the first view has to be installed');

    // The busy flag flips twice per prompt and most flips leave the tray identical;
    // rebuilding a native menu for those is waste.
    updateTray(busy);
    updateTray(busy);
    assert.equal(counts.menus, afterFirst, 'an identical view must not be re-installed');

    // A real change still gets through
    updateTray({ ...busy, attention: [session('c', '/x/web')] });
    assert.equal(counts.menus, afterFirst + 1);
    assert.ok(counts.images > 0, 'and the icon follows the state');
  } finally {
    destroyTray();
    Module._load = originalLoad;
  }
});
