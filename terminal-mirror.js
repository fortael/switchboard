// --- Terminal screen mirror ---
// A headless xterm per live PTY, fed the same bytes the renderer is sent, so that
// a reattach can be handed the screen the CLI believes it drew.
//
// It replaces a ring of raw PTY chunks. A byte log cannot be truncated safely:
// dropping its head drops the cursor position, the scroll region, the SGR state
// and the alt-screen state that the dropped prefix established, and it can cut an
// escape sequence in half. Claude Code redraws differentially — it positions the
// cursor relative to where it believes the previous frame ended and overwrites
// only what changed — so a screen restored from a truncated log is not the screen
// the next frame is drawn against, and the difference stays visible as stray
// fragments and a cursor parked in the wrong column. A parsed screen has no head
// to drop: it is bounded by construction, and it is always a whole screen.
//
// The mirror must agree with the renderer's terminal about how wide a character
// is, or the two lay the same bytes out in different columns and the exactness is
// lost where it is needed most — Claude Code's output is full of emoji and box
// drawing. Hence the same grapheme addon and the same Unicode version as
// `createTerminalEntry()` in public/terminal-manager.js; the two have to be
// changed together.

const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');
const { UnicodeGraphemesAddon } = require('@xterm/addon-unicode-graphemes');

// Enough history for a reattach to look continuous, and bounded per session.
const MIRROR_SCROLLBACK = 1000;

// `osc` maps an OSC identifier to a callback taking the completed payload. This
// is the parser the main process should read notifications off: a sequence split
// across two PTY reads is held until it is whole, where matching a regex against
// one read drops it and the tray never learns a session was asking for something.
// Handlers observe, they do not consume — each returns false so xterm still does
// whatever it would have done with the sequence.
function createMirror(cols, rows, { osc } = {}) {
  const term = new Terminal({
    cols,
    rows,
    scrollback: MIRROR_SCROLLBACK,
    allowProposedApi: true,
  });
  const serializer = new SerializeAddon();
  term.loadAddon(serializer);
  term.loadAddon(new UnicodeGraphemesAddon());
  term.unicode.activeVersion = '15';

  const mirror = { term, serializer, cursorHidden: false };

  // Cursor visibility (DECTCEM) is the one piece of state SerializeAddon leaves
  // out, and the one a TUI holds off for most of a frame — restoring it wrong
  // parks a block cursor in the middle of the screen, which is what a stale
  // cursor artifact looks like. Tracked off the parser rather than by scanning
  // chunks, so a sequence split across two PTY reads still counts. Both handlers
  // return false, which is how xterm is told to carry on to its own.
  term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
    if (params.includes(25)) mirror.cursorHidden = false;
    return false;
  });
  term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
    if (params.includes(25)) mirror.cursorHidden = true;
    return false;
  });

  for (const [ident, handler] of Object.entries(osc || {})) {
    term.parser.registerOscHandler(Number(ident), (payload) => {
      // A handler that throws must not take the screen down with it: the mirror
      // is what a reattach is restored from, and it has to keep parsing.
      try { handler(payload); } catch { /* observation only */ }
      return false;
    });
  }

  return mirror;
}

// True when the bytes reached the screen. xterm throws rather than buffering past
// its discard watermark, so a PTY that floods faster than this process parses can
// make a write fail — and the caller sends the very same bytes on to the renderer
// afterwards, which must not be skipped because the copy of the screen refused
// them. A refused write means the mirror now has a hole, so the caller is told.
function writeMirror(mirror, data) {
  if (!mirror) return true;
  try {
    mirror.term.write(data);
    return true;
  } catch {
    return false;
  }
}

function resizeMirror(mirror, cols, rows) {
  if (mirror) mirror.term.resize(cols, rows);
}

// The screen as a string that restores it when written to a fresh terminal:
// contents, colours, cursor position, alt buffer and the DEC modes the addon
// knows, plus the cursor visibility it does not.
//
// Async because xterm parses its write buffer off the calling stack. Serializing
// without waiting for it would hand over a screen missing whatever arrived last —
// the newest output, and the part the CLI is most likely to redraw against.
function serializeMirror(mirror) {
  if (!mirror) return Promise.resolve('');
  return new Promise((resolve) => {
    try {
      mirror.term.write('', () => {
        try {
          const screen = mirror.serializer.serialize({ scrollback: MIRROR_SCROLLBACK });
          resolve(screen + (mirror.cursorHidden ? '\x1b[?25l' : '\x1b[?25h'));
        } catch {
          resolve('');
        }
      });
    } catch {
      // Queueing the drain marker can fail for the same reason a write can. An
      // empty screen is a reattach with nothing restored; a rejection here would
      // be a reattach that never returns at all.
      resolve('');
    }
  });
}

function disposeMirror(mirror) {
  if (!mirror) return;
  try { mirror.term.dispose(); } catch {}
}

module.exports = { createMirror, writeMirror, resizeMirror, serializeMirror, disposeMirror, MIRROR_SCROLLBACK };
