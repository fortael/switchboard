// Session status: the single source of truth for "what is this session doing".
//
// Before this module the answer was inferred from the PTY byte stream — OSC 0
// title changes (a braille spinner meant busy, ✳ meant idle) plus OSC 9;4
// progress reports. That inference has two structural faults that no amount of
// tuning fixes:
//
//   1. The regex runs per `onData` chunk with no carry buffer, so an escape
//      sequence split across two chunks is never matched. A missed ✳ leaves the
//      session "working" forever.
//   2. OSC 9;4 can only ever *set* busy — level 0 is explicitly ignored as
//      unreliable — so the only idle signal in the whole pipeline was that one
//      ✳ title. One missed byte, one stuck spinner.
//
// Claude Code hooks give the same information out of band: a POST per lifecycle
// event carrying `session_id`, delivered independently of the terminal stream.
// This module turns that event feed into a state machine.
//
// The vocabulary is deliberately the one the Claude Agent SDK already emits as
// `{type:'system', subtype:'session_state_changed', state}` — 'idle' |
// 'running' | 'requires_action'. When the SDK-backed session mode lands it
// feeds this same tracker without a translation layer.

/** @typedef {'idle'|'running'|'requires_action'|'exited'} SessionState */

const STATES = ['idle', 'running', 'requires_action', 'exited'];

// Notification hook payloads carry `notification_type` as a free-form string —
// the CLI is free to add new ones, and does. Only the types that genuinely move
// the state machine are listed; anything else is recorded as a message and
// leaves the state alone. Never switch exhaustively on a string from the wire.
const NOTIFICATION_STATE = {
  permission_prompt: 'requires_action',
  elicitation_dialog: 'requires_action',
  agent_needs_input: 'requires_action',
  idle_prompt: 'idle',
  agent_completed: 'idle',
};

/**
 * How each hook event moves the state, when the move is unconditional.
 * Events needing payload inspection (Notification, Stop) are handled in apply().
 */
const EVENT_STATE = {
  SessionStart: 'idle',        // session is up and waiting for a first prompt
  UserPromptSubmit: 'running',
  PreToolUse: 'running',
  PostToolUse: 'running',
  PostToolUseFailure: 'running',
  PostToolBatch: 'running',
  PermissionRequest: 'requires_action',
  PermissionDenied: 'running', // decision already made; the turn continues
  Elicitation: 'requires_action',
  ElicitationResult: 'running',
  PreCompact: 'running',
  PostCompact: 'running',
  SubagentStart: 'running',
  SubagentStop: 'running',     // the parent turn is still going
  StopFailure: 'idle',         // turn died on an API error — idle, not busy
  SessionEnd: 'exited',
};

class SessionStatus {
  /**
   * @param {string} sessionId
   */
  constructor(sessionId) {
    this.sessionId = sessionId;
    /** @type {SessionState} */
    this.state = 'idle';
    /** Tool name of the most recent PreToolUse, cleared when the turn ends. */
    this.tool = null;
    /** Last human-readable notification text, for the header chip. */
    this.message = null;
    /** Text of the last assistant message, handed over by the Stop hook. */
    this.lastAssistantMessage = null;
    /** Populated by StopFailure so the UI can distinguish "done" from "died". */
    this.error = null;
    /** ms epoch of the last event that reached this tracker. */
    this.updatedAt = 0;
    /**
     * Whether a hook has ever been seen for this session. Until one has, the
     * legacy OSC inference is still allowed to drive the state; from the first
     * hook onward OSC input is ignored. That keeps sessions working when hooks
     * cannot run at all — `--bare`, `disableAllHooks`, a CLI too old to know
     * the events — without ever letting the unreliable signal override the
     * reliable one.
     */
    this.hooksSeen = false;
  }
}

class SessionStatusTracker {
  /**
   * @param {{ onChange?: (sessionId: string, snapshot: object) => void, now?: () => number }} [opts]
   */
  constructor({ onChange = null, now = Date.now } = {}) {
    /** @type {Map<string, SessionStatus>} */
    this.sessions = new Map();
    this._onChange = onChange;
    this._now = now;
  }

  /** @returns {SessionStatus} */
  _get(sessionId) {
    let entry = this.sessions.get(sessionId);
    if (!entry) {
      entry = new SessionStatus(sessionId);
      this.sessions.set(sessionId, entry);
    }
    return entry;
  }

  /** Public read. Returns null for a session that has never reported. */
  get(sessionId) {
    const entry = this.sessions.get(sessionId);
    return entry ? this._snapshot(entry) : null;
  }

  /** Every tracked session, for repopulating a reloaded renderer. */
  all() {
    return [...this.sessions.values()].map(e => this._snapshot(e));
  }

  _snapshot(entry) {
    return {
      sessionId: entry.sessionId,
      state: entry.state,
      tool: entry.tool,
      message: entry.message,
      lastAssistantMessage: entry.lastAssistantMessage,
      error: entry.error,
      updatedAt: entry.updatedAt,
      hooksSeen: entry.hooksSeen,
    };
  }

  /**
   * Re-key a session after a fork or a plan-accept, mirroring what
   * session-transitions.js does to the active-session map. Without this the
   * tracker keeps reporting under an id the renderer has already retired.
   */
  rekey(oldId, newId) {
    const entry = this.sessions.get(oldId);
    if (!entry || oldId === newId) return;
    this.sessions.delete(oldId);
    entry.sessionId = newId;
    // A tracker entry may already exist for the new id if a hook raced ahead of
    // the rename; the forked session's own history is the one worth keeping.
    this.sessions.set(newId, entry);
    this._emit(entry);
  }

  /**
   * Declare a freshly spawned or resumed session idle.
   *
   * A session that has just been launched is by definition not mid-turn: the
   * CLI is sitting at its prompt waiting for input. Saying so explicitly
   * matters because hooks are turn-scoped — `SessionStart` is not delivered —
   * so a session that is resumed and then never used produces no events at
   * all, and whatever the terminal stream happened to suggest during startup
   * would otherwise stand as the answer forever.
   */
  seed(sessionId) {
    const entry = this._get(sessionId);
    entry.state = 'idle';
    entry.tool = null;
    entry.error = null;
    entry.updatedAt = this._now();
    this._emit(entry);
  }

  /** Drop a session entirely — the PTY exited and nothing more will arrive. */
  remove(sessionId) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    this.sessions.delete(sessionId);
    if (entry.state !== 'exited') {
      entry.state = 'exited';
      entry.tool = null;
      entry.updatedAt = this._now();
      this._emit(entry);
    }
  }

  /**
   * Legacy OSC-derived busy flag. Only honoured while no hook has been seen for
   * the session — see SessionStatus#hooksSeen.
   * @returns {boolean} whether the state changed
   */
  applyOsc(sessionId, busy) {
    const entry = this._get(sessionId);
    if (entry.hooksSeen) return false;
    return this._transition(entry, busy ? 'running' : 'idle');
  }

  /**
   * Feed one hook payload. Shape is Claude Code's hook input JSON; only
   * `hook_event_name` is required, everything else is optional and defensively
   * read — an unknown event is recorded (so the session counts as hook-backed)
   * but leaves the state untouched.
   *
   * @param {object} payload
   * @returns {boolean} whether the state changed
   */
  apply(payload) {
    if (!payload || typeof payload !== 'object') return false;
    const sessionId = payload.session_id;
    const event = payload.hook_event_name;
    if (typeof sessionId !== 'string' || !sessionId) return false;
    if (typeof event !== 'string' || !event) return false;

    const entry = this._get(sessionId);
    entry.hooksSeen = true;

    let next = EVENT_STATE[event] || null;

    switch (event) {
      case 'PreToolUse':
        entry.tool = typeof payload.tool_name === 'string' ? payload.tool_name : null;
        break;

      case 'PostToolUse':
      case 'PostToolUseFailure':
      case 'PostToolBatch':
        entry.tool = null;
        break;

      case 'Notification': {
        // `notification_type` is an open set. A type this build does not know
        // still updates the message chip but must not move the state, or a new
        // CLI release would silently start parking sessions in the wrong column.
        const type = payload.notification_type;
        next = (typeof type === 'string' && NOTIFICATION_STATE[type]) || null;
        if (typeof payload.message === 'string') entry.message = payload.message;
        break;
      }

      case 'Stop': {
        // `background_tasks` is how the CLI distinguishes "the turn is over"
        // from "the turn is parked waiting for work that will wake it again".
        // Reporting idle in the second case would clear the spinner while the
        // session is still going to produce output.
        const bg = payload.background_tasks;
        const parked = Array.isArray(bg) && bg.length > 0;
        next = parked ? 'running' : 'idle';
        if (typeof payload.last_assistant_message === 'string') {
          entry.lastAssistantMessage = payload.last_assistant_message;
        }
        if (!parked) entry.tool = null;
        entry.error = null;
        break;
      }

      case 'StopFailure':
        entry.tool = null;
        entry.error = typeof payload.error_details === 'string'
          ? payload.error_details
          : (typeof payload.error === 'string' ? payload.error : 'API error');
        if (typeof payload.last_assistant_message === 'string') {
          entry.lastAssistantMessage = payload.last_assistant_message;
        }
        break;

      case 'UserPromptSubmit':
        // A new turn supersedes whatever the last one left on screen.
        entry.error = null;
        entry.message = null;
        entry.lastAssistantMessage = null;
        break;

      case 'SessionEnd':
        entry.tool = null;
        break;
    }

    return this._transition(entry, next);
  }

  /**
   * @param {SessionStatus} entry
   * @param {SessionState|null} next — null means "record the event, keep the state"
   * @returns {boolean}
   */
  _transition(entry, next) {
    entry.updatedAt = this._now();
    if (!next || !STATES.includes(next) || next === entry.state) {
      return false;
    }
    // 'exited' is terminal: a late-arriving hook from a dead session must not
    // resurrect it into the running column.
    if (entry.state === 'exited') return false;
    entry.state = next;
    this._emit(entry);
    return true;
  }

  _emit(entry) {
    if (this._onChange) this._onChange(entry.sessionId, this._snapshot(entry));
  }
}

module.exports = {
  SessionStatusTracker,
  SessionStatus,
  EVENT_STATE,
  NOTIFICATION_STATE,
  STATES,
};
