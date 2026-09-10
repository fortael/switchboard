// session-column.js — which lane a session is in, and which one to open first.
//
// The board draws four columns and the Recent rail sorts projects by the worst
// state in them. Both were deciding for themselves what a session's state was,
// from the same four collections, and they disagreed at the edges: a session
// that had finished a turn *and* been sent back to work landed in DONE on the
// rail and IN PROGRESS on the board.
//
// One answer, one precedence order, used by both.

/**
 * Precedence, not a partition: a session can carry more than one of these marks
 * at once. Blocked-on-the-user outranks everything — it is the only state that
 * cannot progress without a human. Running outranks done because a session you
 * opened and then sent back to work is working, not finished; otherwise a read
 * turn would pin it in DONE for the whole next turn.
 */
export const COLUMN_PRECEDENCE = ['waiting', 'running', 'done', 'idle'];

/**
 * The order to open them in, which is not the order to rank them by. Once a
 * session is placed, "what should I look at first" puts a finished turn ahead
 * of one still being written: the finished one wants reading, the running one
 * wants nothing.
 */
export const OPEN_ORDER = { waiting: 0, done: 1, running: 2, idle: 3 };

/**
 * @typedef {object} SessionState
 * @property {Set<string>} attention      blocked on the user
 * @property {Map<string, boolean>} busy  mid-turn
 * @property {Set<string>} responseReady  finished, unread
 * @property {Set<string>} readPending    finished, read, not yet put away
 */

/**
 * @param {string} sessionId
 * @param {SessionState} state
 * @returns {'waiting'|'running'|'done'|'idle'}
 */
export function columnOf(sessionId, state) {
  if (state.attention?.has(sessionId)) return 'waiting';
  if (state.busy?.get(sessionId)) return 'running';
  if (state.responseReady?.has(sessionId) || state.readPending?.has(sessionId)) return 'done';
  return 'idle';
}

/** The four collections, read off the Vue store. */
export function stateFromStore(store) {
  return {
    attention: store.attentionSessions,
    busy: store.sessionBusyState,
    responseReady: store.responseReadySessions,
    readPending: store.readPendingSessions,
  };
}

/**
 * The one to open. A project with a dozen sessions has exactly one that wants
 * you right now — the one holding a dialog — and clicking the project should
 * land on it rather than on whichever was touched last.
 *
 * Ties inside a lane go to the most recently active, which is the only ordering
 * that means anything among sessions in the same state.
 *
 * @param {Array<{sessionId: string, modified?: string}>} sessions
 * @param {SessionState} state
 * @returns {object|null}
 */
export function mostUrgent(sessions, state) {
  let best = null;
  let bestRank = Infinity;
  let bestTime = -Infinity;

  for (const session of sessions || []) {
    if (!session?.sessionId) continue;
    const rank = OPEN_ORDER[columnOf(session.sessionId, state)];
    const time = new Date(session.modified || 0).getTime() || 0;
    if (rank < bestRank || (rank === bestRank && time > bestTime)) {
      best = session;
      bestRank = rank;
      bestTime = time;
    }
  }
  return best;
}

/** The worst lane anything in this list is in — a project's status in one word. */
export function worstColumn(sessions, state) {
  let worst = 'idle';
  for (const session of sessions || []) {
    if (!session?.sessionId) continue;
    const column = columnOf(session.sessionId, state);
    if (OPEN_ORDER[column] < OPEN_ORDER[worst]) worst = column;
  }
  return worst;
}
