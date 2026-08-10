const test = require('node:test');
const assert = require('node:assert/strict');
const { Terminal } = require('@xterm/headless');
const { UnicodeGraphemesAddon } = require('@xterm/addon-unicode-graphemes');

const { createMirror, writeMirror, resizeMirror, serializeMirror, disposeMirror } = require('../terminal-mirror');

const COLS = 80;
const ROWS = 24;

// A terminal built the way the renderer builds one, to receive a reattach.
function receiver(cols = COLS, rows = ROWS) {
  const term = new Terminal({ cols, rows, scrollback: 10000, allowProposedApi: true });
  term.loadAddon(new UnicodeGraphemesAddon());
  term.unicode.activeVersion = '15';
  return term;
}

function write(term, data) {
  return new Promise(resolve => term.write(data, resolve));
}

function screenOf(term) {
  const buf = term.buffer.active;
  const lines = [];
  for (let y = 0; y < term.rows; y++) {
    lines.push(buf.getLine(buf.viewportY + y)?.translateToString(true) ?? '');
  }
  return lines;
}

// The property everything else rests on: what the mirror hands a reattach restores
// the screen the PTY actually produced, rather than the bytes that produced it.
async function roundTrip(stream, { cols = COLS, rows = ROWS } = {}) {
  const mirror = createMirror(cols, rows);
  writeMirror(mirror, stream);
  const serialized = await serializeMirror(mirror);

  const restored = receiver(cols, rows);
  await write(restored, serialized);

  const direct = receiver(cols, rows);
  await write(direct, stream);

  return { mirror, serialized, restored, direct };
}

test('a reattach restores the screen the PTY produced', async () => {
  const stream =
    'plain line\r\n' +
    '\x1b[31mred\x1b[0m and \x1b[1;32mbold green\x1b[0m\r\n' +
    '\x1b[4;10Hpositioned at row 4 col 10\r\n' +
    '\x1b[7mreverse\x1b[0m\r\n';

  const { mirror, restored, direct } = await roundTrip(stream);
  try {
    assert.deepEqual(screenOf(restored), screenOf(direct));
    assert.equal(restored.buffer.active.cursorX, direct.buffer.active.cursorX);
    assert.equal(restored.buffer.active.cursorY, direct.buffer.active.cursorY);
  } finally {
    disposeMirror(mirror);
    restored.dispose();
    direct.dispose();
  }
});

test('a differential redraw after a reattach lands where it would have', async () => {
  // The whole point. Claude Code repaints by moving the cursor relative to the
  // frame it believes is on screen and rewriting only what changed. If a reattach
  // restores a screen that is not that frame, the next repaint lands offset and
  // the difference stays visible — duplicated rows and a cursor in the wrong
  // column. Restored and never-detached have to be indistinguishable afterwards.
  const frame =
    '\x1b[?25l' +
    '\x1b[31m· Sautéing…\x1b[0m (10m 30s · ↓ 38.7k tokens)\r\n' +
    '  ⎿ Tip: Use /feedback to help us improve!\r\n';
  // Up two rows, clear to end of line, rewrite the timer, back down. Untouched
  // rows are not resent — they are assumed to still be there.
  const repaint = '\x1b[2A\r\x1b[K\x1b[31m* Sautéing…\x1b[0m (33s · ↓ 1.2k tokens)\x1b[2B\r';

  const { mirror, restored, direct } = await roundTrip(frame);
  try {
    await write(restored, repaint);
    await write(direct, repaint);

    assert.deepEqual(screenOf(restored), screenOf(direct));
    assert.equal(restored.buffer.active.cursorX, direct.buffer.active.cursorX);
    assert.equal(restored.buffer.active.cursorY, direct.buffer.active.cursorY);
  } finally {
    disposeMirror(mirror);
    restored.dispose();
    direct.dispose();
  }
});

test('wide characters land in the same columns after a reattach', async () => {
  // The mirror and the renderer have to agree on character width, or the same
  // bytes occupy different columns in each and the restored screen is subtly
  // shifted. Emoji and box drawing are what a CLI actually emits.
  const stream = '╭──╮\r\n│ ✅ ok │\r\n╰──╯\r\nend 🎉 here\r\n';

  const { mirror, restored, direct } = await roundTrip(stream);
  try {
    assert.deepEqual(screenOf(restored), screenOf(direct));
  } finally {
    disposeMirror(mirror);
    restored.dispose();
    direct.dispose();
  }
});

test('a hidden cursor stays hidden across a reattach', async () => {
  // SerializeAddon does not carry DECTCEM. Without the mirror tracking it, a
  // reattach shows a block cursor the CLI had deliberately hidden — the stale
  // cursor artifact this replaces.
  const hidden = createMirror(COLS, ROWS);
  writeMirror(hidden, 'drawing\x1b[?25l frame');
  assert.match(await serializeMirror(hidden), /\x1b\[\?25l$/);
  disposeMirror(hidden);

  const shown = createMirror(COLS, ROWS);
  writeMirror(shown, 'drawing\x1b[?25l frame\x1b[?25h');
  assert.match(await serializeMirror(shown), /\x1b\[\?25h$/);
  disposeMirror(shown);
});

test('an alternate-screen session reattaches into the alternate screen', async () => {
  const stream = 'scrollback line\r\n\x1b[?1049h\x1b[2J\x1b[H\x1b[1mfull screen app\x1b[0m\r\nsecond row';

  const { mirror, serialized, restored, direct } = await roundTrip(stream);
  try {
    assert.ok(serialized.includes('\x1b[?1049h'), 'serialization enters the alt buffer');
    assert.deepEqual(screenOf(restored), screenOf(direct));
  } finally {
    disposeMirror(mirror);
    restored.dispose();
    direct.dispose();
  }
});

test('scrollback survives a reattach instead of being truncated mid-stream', async () => {
  // The byte log this replaces was capped by dropping its head, which cut escape
  // sequences in half and lost the state the dropped prefix had set. Volume alone
  // must not corrupt anything now.
  let stream = '';
  for (let i = 0; i < 500; i++) stream += `line ${i} \x1b[3${i % 8}mcoloured\x1b[0m\r\n`;

  const { mirror, restored, direct } = await roundTrip(stream);
  try {
    assert.deepEqual(screenOf(restored), screenOf(direct));

    const buf = restored.buffer.active;
    assert.ok(buf.baseY > 0, 'history is restored, not just the viewport');
    assert.equal(buf.getLine(buf.baseY + buf.cursorY - 1)?.translateToString(true), 'line 499 coloured');
  } finally {
    disposeMirror(mirror);
    restored.dispose();
    direct.dispose();
  }
});

test('a resized session reattaches at the size it was resized to', async () => {
  const mirror = createMirror(COLS, ROWS);
  writeMirror(mirror, 'before resize\r\n');
  resizeMirror(mirror, 100, 30);
  writeMirror(mirror, 'after resize\r\n');

  const serialized = await serializeMirror(mirror);
  const restored = receiver(100, 30);
  await write(restored, serialized);

  try {
    const text = screenOf(restored).join('\n');
    assert.match(text, /before resize/);
    assert.match(text, /after resize/);
  } finally {
    disposeMirror(mirror);
    restored.dispose();
  }
});

test('the screen survives landing on a terminal that has not been fitted yet', async () => {
  // Delivery order in main.js: the renderer creates the terminal at xterm's
  // default size, the screen arrives, and only then does showSession fit it. So
  // the screen is written narrow and reflowed wide, against SerializeAddon's
  // advice to restore at the original size. That is safe — this is what says so.
  let stream = '';
  for (let i = 0; i < 40; i++) stream += `row ${i} `.padEnd(110, 'x') + '\r\n';
  stream += 'a line long enough to wrap even at the session width '.padEnd(150, 'y') + '\r\n';
  stream += '\x1b[31mtail\x1b[0m';

  const mirror = createMirror(120, 30);
  writeMirror(mirror, stream);
  const serialized = await serializeMirror(mirror);

  const unfitted = receiver(80, 24);
  await write(unfitted, serialized);
  unfitted.resize(120, 30);

  const direct = receiver(120, 30);
  await write(direct, stream);

  try {
    assert.deepEqual(screenOf(unfitted), screenOf(direct));
  } finally {
    disposeMirror(mirror);
    unfitted.dispose();
    direct.dispose();
  }
});

test('an OSC sequence split across two PTY reads is still reported, once', async () => {
  // The reason notifications moved onto this parser. A PTY read boundary falls
  // wherever the pipe happens to end, and matching a whole sequence inside one
  // read drops any that straddles two — for OSC 9 that is a permission prompt the
  // tray never hears about.
  const seen = [];
  const mirror = createMirror(COLS, ROWS, { osc: { 9: (p) => seen.push(p) } });

  const notification = '\x1b]9;Claude needs your permission to use Bash\x07';
  for (let cut = 1; cut < notification.length; cut++) {
    seen.length = 0;
    mirror.term.write(notification.slice(0, cut));
    await new Promise(resolve => mirror.term.write(notification.slice(cut), resolve));
    assert.deepEqual(seen, ['Claude needs your permission to use Bash'], `split at ${cut}`);
  }

  disposeMirror(mirror);
});

test('OSC handlers see the payload without its identifier, progress included', async () => {
  const titles = [];
  const notes = [];
  const mirror = createMirror(COLS, ROWS, {
    osc: { 0: (p) => titles.push(p), 9: (p) => notes.push(p) },
  });

  await new Promise(resolve => mirror.term.write(
    '\x1b]0;✳ idle title\x07' +      // CLI title, idle marker
    '\x1b]9;4;1;50\x1b\\' +               // ConEmu progress, ST-terminated
    '\x1b]9;Claude is waiting for your input\x07',
    resolve,
  ));

  try {
    assert.deepEqual(titles, ['✳ idle title']);
    assert.deepEqual(notes, ['4;1;50', 'Claude is waiting for your input']);
  } finally {
    disposeMirror(mirror);
  }
});

test('observing OSC does not stop xterm handling it, and a throwing handler is contained', async () => {
  const mirror = createMirror(COLS, ROWS, {
    osc: { 0: () => { throw new Error('handler blew up'); } },
  });

  await new Promise(resolve => mirror.term.write('\x1b]0;window title\x07after', resolve));

  try {
    // The title still reached xterm's own handler, and parsing carried on past
    // the throw — the mirror is what a reattach is restored from.
    assert.equal(mirror.term.buffer.active.getLine(0)?.translateToString(true), 'after');
  } finally {
    disposeMirror(mirror);
  }
});

test('the mirror helpers are inert without a mirror', async () => {
  // Every call site reaches a session that may already have exited and released
  // its screen; none of them should have to check first.
  writeMirror(null, 'data');
  resizeMirror(null, 80, 24);
  disposeMirror(null);
  assert.equal(await serializeMirror(null), '');
});
