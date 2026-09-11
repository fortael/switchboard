// dock-attention.js — the dock icon as a status light.
//
// Two signals, deliberately different in kind:
//
//   the badge   how many sessions want something — the board's WAITING INPUT
//               and DONE columns added together. A number you glance at.
//   the bounce  one session has just become blocked on a dialog and is holding
//               up work. A thing that interrupts you.
//
// A finished turn never bounces. It is finished; it can wait.
//
// The count cannot be derived from session-status.js, because "done" is not a
// status — it is "finished a turn and you have not put it away yet", which only
// the window knows (see readPendingSessions in public/app.js). So the renderer
// reports it and this decides what the dock does about it.
//
// Everything platform-specific is injected rather than imported: `app.dock` is
// undefined off macOS and `app` cannot be required outside Electron at all,
// which would leave this untestable.

/**
 * @param {object} deps
 * @param {(count: number) => boolean} deps.setBadgeCount
 * @param {() => number|null} deps.bounce         starts a 'critical' bounce, returns its id
 * @param {(id: number) => void} deps.cancelBounce
 * @param {() => boolean} deps.isFocused          is the window in front right now
 * @param {(message: string) => void} [deps.log]
 */
function createDockAttention(deps) {
  const log = deps.log || (() => {});

  /** The id of the bounce request we started, or null. */
  let bounceId = null;
  /** Ids that were already waiting, so only a newly blocked one bounces. */
  let waitingBefore = new Set();

  function stopBounce() {
    if (bounceId === null) return;
    const id = bounceId;
    bounceId = null;
    try { deps.cancelBounce(id); } catch {}
  }

  /**
   * @param {{ waiting?: string[], done?: number }} summary
   */
  function update(summary) {
    const waiting = new Set(Array.isArray(summary?.waiting) ? summary.waiting : []);
    const done = Number(summary?.done) > 0 ? Math.floor(Number(summary.done)) : 0;
    const total = waiting.size + done;

    // macOS and the Unity launcher; a no-op everywhere else. On macOS the badge
    // needs notification permission, so a refused prompt means no number —
    // which is why nothing below depends on it having worked.
    let badged = false;
    try { badged = deps.setBadgeCount(total) !== false; } catch { badged = false; }
    log(`[dock] badge=${total} (waiting ${waiting.size}, done ${done}) set=${badged}`);

    const arrived = [...waiting].some(id => !waitingBefore.has(id));
    waitingBefore = waiting;

    // Nothing is waiting any more, so stop asking even if the window was never
    // brought forward.
    if (!waiting.size) { stopBounce(); return; }
    // Looking at the app already is the answer to "get my attention".
    if (!arrived) return;
    let focused = false;
    try { focused = !!deps.isFocused(); } catch { focused = false; }
    if (focused) return;

    // Deliberately not guarded on "are we already bouncing": a 'critical'
    // bounce is stopped by macOS itself the moment the app is activated, which
    // leaves our id pointing at nothing. Treating that stale id as "still
    // asking" is what made the icon bounce exactly once per app run. Cancelling
    // first is what keeps us from leaking a request instead.
    stopBounce();
    try { bounceId = deps.bounce() ?? null; } catch { bounceId = null; }
    log(`[dock] bounce id=${bounceId}`);
  }

  return {
    update,
    /** Call when the app comes to the front — that is the answer to a bounce. */
    stopBounce,
    /** Test seam: what this thinks it is currently asking with. */
    get bounceId() { return bounceId; },
  };
}

module.exports = { createDockAttention };
