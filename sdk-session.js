// sdk-session.js — sessions driven by the Claude Agent SDK instead of a PTY.
//
// The PTY path spawns `claude` in a terminal and reads back a byte stream that
// has already been rendered for a human: colours, cursor moves, a redrawn box.
// Everything WootonPad wants from it — which tool is running, whether the
// turn is over, what the assistant actually said — has to be inferred from
// that rendering, which is why session-status.js exists at all.
//
// The SDK hands over the same conversation as structured messages. Same CLI,
// same account, same `.jsonl` on disk; only the transport differs. A session
// started here is indistinguishable from a PTY one everywhere it matters:
// `sessionId` pins the UUID the CLI would otherwise invent, so the transcript
// lands in the folder the cache already watches.
//
// This module owns the transport and nothing else. It does not know what a
// message looks like on screen — it forwards them — and it does not decide
// what a session's status is; it reports `session_state_changed`, which the
// CLI calls the authoritative turn-over signal, to whoever is listening.

const { HOOK_EVENTS } = require('./hook-settings');

// The SDK ships as ESM and main.js is CommonJS, so the import is dynamic and
// deferred: a user who never opens an SDK session never pays for loading it.
let _sdk = null;
async function sdk() {
  if (!_sdk) _sdk = await import('@anthropic-ai/claude-agent-sdk');
  return _sdk;
}

// Injected by main.js — see CLAUDE.md on modules that cannot reach
// activeConfigDir() for themselves.
let deps = {
  log: null,
  /** () => string — absolute path to the user's own `claude`. */
  resolveClaudeBinary: () => 'claude',
  /** () => string — PATH the CLI's own child processes need. */
  claudeChildPath: () => process.env.PATH || '',
};

function configure(next) {
  deps = { ...deps, ...next };
}

const log = {
  info: (m) => deps.log?.info(m),
  warn: (m) => deps.log?.warn(m),
  error: (m) => deps.log?.error(m),
  debug: (m) => deps.log?.debug(m),
};

/**
 * `request_user_dialog` kinds this app can actually draw — see the comment at
 * the call site. Adding a name here without a matching branch in
 * RequestDialog.vue is worse than leaving it out: the CLI would start parking
 * dialogs on a screen that cannot answer them.
 */
const DIALOG_KINDS = ['refusal_fallback_prompt'];

/** @type {Map<string, object>} sessionId → entry */
const sessions = new Map();

// ── Streaming input ───────────────────────────────────────────────

/**
 * An async iterable the caller can push into. `query()` takes the conversation
 * as an iterable of user messages and consumes it for as long as the session
 * lives, so the queue has to outlive any single turn — one push per prompt,
 * many prompts per session.
 *
 * Type-ahead works: a prompt pushed while a turn is still running gets a turn
 * of its own once that one finishes, which is what typing ahead into the
 * terminal does. Measured both with and without the `priority` field on
 * SDKUserMessage; neither was needed for the ordinary case.
 */
function createInputQueue() {
  const pending = [];
  const waiting = [];
  let closed = false;

  return {
    push(message) {
      if (closed) return false;
      const next = waiting.shift();
      if (next) next({ value: message, done: false });
      else pending.push(message);
      return true;
    },
    close() {
      if (closed) return;
      closed = true;
      // Release anyone parked on the next message so the generator can finish.
      while (waiting.length) waiting.shift()({ value: undefined, done: true });
    },
    get closed() { return closed; },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (pending.length) return Promise.resolve({ value: pending.shift(), done: false });
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise(resolve => waiting.push(resolve));
        },
        return() {
          closed = true;
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

/** Wrap plain text as the SDKUserMessage shape the SDK expects. */
function userMessage(text) {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    session_id: '',
  };
}

// ── Lifecycle ─────────────────────────────────────────────────────

/**
 * Start an SDK-backed session.
 *
 * @param {string} sessionId          UUID WootonPad already allocated
 * @param {object} opts
 * @param {string} opts.projectPath   cwd for the session
 * @param {boolean} [opts.isNew]      false means resume `sessionId`
 * @param {string} [opts.forkFrom]    resume this id and fork into `sessionId`
 * @param {string} [opts.permissionMode]
 * @param {string} [opts.model]
 * @param {Record<string,string>} [opts.env]
 * @param {(sessionId: string, message: object) => void} opts.onMessage
 * @param {(sessionId: string, state: string) => void} [opts.onState]
 * @param {(sessionId: string, realId: string) => void} [opts.onSessionId]
 * @param {(toolName: string, input: object, ctx: object) => Promise<object>} [opts.canUseTool]
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function startSdkSession(sessionId, opts) {
  if (sessions.has(sessionId)) return { ok: false, error: 'Session already running' };

  const inputs = createInputQueue();
  const abort = new AbortController();

  // Registered before the first await. Loading the SDK and starting the CLI
  // takes a moment, and a prompt sent in that window has to queue rather than
  // be rejected for a session the caller has already been told to start.
  const entry = {
    sessionId,
    realSessionId: sessionId,
    projectPath: opts.projectPath,
    inputs,
    abort,
    exited: false,
    startedAt: Date.now(),
  };
  sessions.set(sessionId, entry);

  let query;
  try {
    ({ query } = await sdk());
  } catch (err) {
    sessions.delete(sessionId);
    return { ok: false, error: `Could not load the Agent SDK: ${err.message}` };
  }
  if (entry.exited) return { ok: false, error: 'Session stopped before it started' };

  const options = {
    cwd: opts.projectPath,
    abortController: abort,
    // The user's own CLI, not the 200MB copy the SDK would otherwise bundle:
    // same version, same account resolution, same `.jsonl` layout as every
    // PTY session WootonPad has already indexed.
    pathToClaudeCodeExecutable: deps.resolveClaudeBinary(),
    // Partial messages are what makes the answer appear as it is written
    // rather than in one lump when the turn ends.
    includePartialMessages: true,
    // The CLI runs as a child process; without this its stderr goes nowhere
    // and a session that fails to start is indistinguishable from one that is
    // simply quiet.
    stderr: (data) => {
      const line = String(data).trim();
      if (line) log.debug(`[sdk] session=${sessionId} stderr: ${line.slice(0, 500)}`);
      opts.onStderr?.(sessionId, String(data));
    },
    env: {
      ...process.env,
      ...(opts.env || {}),
      PATH: deps.claudeChildPath(),
    },
  };

  if (opts.forkFrom) {
    // Fork keeps the parent transcript intact and starts a new one; naming the
    // child id here is what lets session-transitions.js stay out of it.
    options.resume = opts.forkFrom;
    options.forkSession = true;
    options.sessionId = sessionId;
  } else if (opts.isNew) {
    options.sessionId = sessionId;
  } else {
    options.resume = sessionId;
  }

  if (opts.permissionMode) options.permissionMode = opts.permissionMode;
  if (opts.model) options.model = opts.model;
  if (opts.canUseTool) options.canUseTool = opts.canUseTool;

  // The second way a session can stop and wait for a person: an MCP server
  // asking for input directly rather than through a tool call. Without this
  // the SDK declines every one of them automatically, which looks from the
  // outside like a server that silently refuses to connect.
  if (opts.onElicitation) {
    options.onElicitation = (request) => opts.onElicitation(entry.realSessionId, request);
  }

  // The third way, and the one that fails closed: the CLI only emits a dialog
  // kind that the host has declared it can draw. Declare nothing and the flow
  // behind it degrades silently — a refusal ends the turn with the classic
  // error instead of offering to retry on the fallback model.
  //
  // So the list is exactly what RequestDialog renders, no more. A kind that
  // turns up anyway is answered `cancelled`, which is what the SDK requires of
  // a host that does not recognise one: the CLI then applies that dialog's own
  // default rather than waiting out its park deadline.
  if (opts.onUserDialog && DIALOG_KINDS.length) {
    options.supportedDialogKinds = [...DIALOG_KINDS];
    options.onUserDialog = (request) => (DIALOG_KINDS.includes(request?.dialogKind)
      ? opts.onUserDialog(entry.realSessionId, request)
      : Promise.resolve({ behavior: 'cancelled' }));
  }

  // Lifecycle hooks, in process. The PTY path has to reach these through a
  // local HTTP server and a generated settings file (hook-server.js) because
  // there is no other way to talk to a CLI running in a terminal. Here they
  // are plain callbacks: same payloads, same event names, same state machine
  // on the other end — minus the socket, the token and the temp file.
  if (opts.onHook) {
    options.hooks = {};
    for (const event of HOOK_EVENTS) {
      options.hooks[event] = [{
        hooks: [async (input) => {
          try { opts.onHook(entry.realSessionId, input); }
          catch (err) { log.error(`[sdk] hook ${event} handler threw: ${err.message}`); }
          return {};   // no decision — observe only
        }],
      }];
    }
  }

  let q;
  try {
    q = query({ prompt: inputs, options });
  } catch (err) {
    sessions.delete(sessionId);
    return { ok: false, error: err.message };
  }
  entry.query = q;

  // Drained in the background: query() is an async generator that runs for the
  // life of the session, so awaiting it here would never return.
  (async () => {
    try {
      for await (const message of q) {
        if (entry.exited) break;
        route(entry, message, opts);
      }
    } catch (err) {
      if (!entry.exited) {
        log.error(`[sdk] session=${sessionId} stream failed: ${err.message}`);
        opts.onMessage?.(entry.realSessionId, {
          type: 'system', subtype: 'error', error: err.message, session_id: entry.realSessionId,
        });
      }
    } finally {
      entry.exited = true;
      sessions.delete(sessionId);
      opts.onState?.(entry.realSessionId, 'exited');
      log.info(`[sdk] session=${entry.realSessionId} ended`);
    }
  })();

  log.info(`[sdk] session=${sessionId} started cwd=${opts.projectPath} mode=${opts.forkFrom ? 'fork' : opts.isNew ? 'new' : 'resume'}`);
  return { ok: true };
}

/**
 * Everything the stream produces goes to the renderer; two message types are
 * also acted on here.
 */
function route(entry, message, opts) {
  // `system/init` arrives at the head of every turn and carries the id the CLI
  // actually used. It should equal the one we asked for, but a fork or an
  // older CLI can disagree, and the transcript on disk follows the CLI.
  if (message.type === 'system' && message.subtype === 'init' && message.session_id) {
    if (message.session_id !== entry.realSessionId) {
      const previous = entry.realSessionId;
      entry.realSessionId = message.session_id;
      log.info(`[sdk] session=${previous} re-keyed to ${message.session_id}`);
      opts.onSessionId?.(previous, message.session_id);
    }
  }

  // Status, when the caller has not wired lifecycle hooks. With `onHook` the
  // session reports the same events a PTY session reports over HTTP, which is
  // richer than anything derivable here — it names the running tool and knows
  // when a permission prompt is up — so this path stays out of the way.
  //
  // Without it: `session_state_changed` is documented as the authoritative
  // turn-over signal and speaks the same three states, so it wins when it
  // appears, but it was not observed in this mode at all. `system/init` opens
  // every turn and `result` closes it; both were seen on every turn.
  if (!opts.onHook) {
    if (message.type === 'system' && message.subtype === 'session_state_changed') {
      entry.sawStateMessages = true;
      opts.onState?.(entry.realSessionId, message.state);
    } else if (!entry.sawStateMessages) {
      if (message.type === 'system' && message.subtype === 'init') {
        opts.onState?.(entry.realSessionId, 'running');
      } else if (message.type === 'result') {
        opts.onState?.(entry.realSessionId, 'idle');
      }
    }
  }

  opts.onMessage?.(entry.realSessionId, message);
}

/** Queue a prompt. Accepted while a turn is running — it lands after it. */
function sendSdkInput(sessionId, text) {
  const entry = find(sessionId);
  if (!entry || entry.exited) return { ok: false, error: 'No such session' };
  if (typeof text !== 'string' || !text) return { ok: false, error: 'Empty input' };
  entry.inputs.push(userMessage(text));
  return { ok: true };
}

/** Stop the current turn without ending the session — the Escape key. */
async function interruptSdkSession(sessionId) {
  const entry = find(sessionId);
  if (!entry || entry.exited) return { ok: false, error: 'No such session' };
  try {
    await entry.query?.interrupt();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Session-scoped knobs the composer's control bar drives. Each is a control
 * request, so each needs a live session and a streaming input — which is
 * exactly what this module keeps.
 */
async function sdkControl(sessionId, fn) {
  const entry = find(sessionId);
  if (!entry || entry.exited || !entry.query) return { ok: false, error: 'No such session' };
  try {
    return { ok: true, value: await fn(entry.query) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Commands with their descriptions, for the composer's menu. */
const listSdkCommands = (sessionId) => sdkControl(sessionId, q => q.supportedCommands());

/** Available models, for the picker. */
const listSdkModels = (sessionId) => sdkControl(sessionId, q => q.supportedModels());

/** Switch the model for everything after this turn. */
const setSdkModel = (sessionId, model) => sdkControl(sessionId, q => q.setModel(model || undefined));

/**
 * Effort is not a dedicated setter: it rides the session-scoped flag layer,
 * which is also the only place 'max' is accepted.
 */
const setSdkEffort = (sessionId, effortLevel) =>
  sdkControl(sessionId, q => q.applyFlagSettings({ effortLevel }));

/** What the CLI's own /context would show, for the ring in the control bar. */
const getSdkContextUsage = (sessionId) =>
  sdkControl(sessionId, q => q.getContextUsage({ detail: 'summary' }));

/** Change the permission mode of a live session. */
async function setSdkPermissionMode(sessionId, mode) {
  const entry = find(sessionId);
  if (!entry || entry.exited) return { ok: false, error: 'No such session' };
  try {
    await entry.query?.setPermissionMode(mode);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** End the session. Closing the input is the graceful path; abort is the fallback. */
function stopSdkSession(sessionId) {
  const entry = find(sessionId);
  if (!entry) return { ok: false, error: 'No such session' };
  entry.exited = true;
  try { entry.inputs.close(); } catch {}
  try { entry.abort.abort(); } catch {}
  sessions.delete(entry.sessionId);
  return { ok: true };
}

function stopAllSdkSessions() {
  for (const id of [...sessions.keys()]) stopSdkSession(id);
}

/** Sessions are addressable by the id they were started with or their real one. */
function find(sessionId) {
  const direct = sessions.get(sessionId);
  if (direct) return direct;
  for (const entry of sessions.values()) {
    if (entry.realSessionId === sessionId) return entry;
  }
  return null;
}

function isSdkSession(sessionId) {
  return !!find(sessionId);
}

function activeSdkSessions() {
  return [...sessions.values()].map(e => e.realSessionId);
}

module.exports = {
  configure,
  startSdkSession,
  listSdkCommands,
  listSdkModels,
  setSdkModel,
  setSdkEffort,
  getSdkContextUsage,
  sendSdkInput,
  interruptSdkSession,
  setSdkPermissionMode,
  stopSdkSession,
  stopAllSdkSessions,
  isSdkSession,
  activeSdkSessions,
  DIALOG_KINDS,
  // exported for tests
  createInputQueue,
  userMessage,
};
