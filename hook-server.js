// hook-server.js — one local HTTP endpoint that Claude Code hooks POST to.
//
// The CLI supports `type: "http"` hooks: it POSTs the hook input JSON to a URL
// and reads the response body back as the hook's decision. That gives us a
// status feed that does not depend on parsing the PTY byte stream — see the
// rationale at the top of session-status.js for why the stream cannot be
// trusted for this.
//
// One server for the whole app, not one per session, unlike mcp-bridge.js. The
// IDE protocol forces a socket per session because the lock file *is* the
// discovery mechanism; nothing here needs that. Every payload carries
// `session_id`, so a single endpoint demultiplexes fine — and an external
// orchestrator spawning ten sessions at once does not cost ten listeners.
//
// Two listeners do get created when a WSL account is present: hooks configured
// for a session running inside a distribution execute *in* that distribution,
// where 127.0.0.1 is the distro's own loopback and not ours. Those sessions are
// handed the vEthernet (WSL) address instead. Same handler, same token.

const http = require('http');
const net = require('net');
const crypto = require('crypto');
const os = require('os');

const { wslHostAddressFrom } = require('./shell-profiles');

// A hook body is lifecycle metadata, not content: session id, tool name, a
// notification string. Anything past this is malformed or hostile, and reading
// it would only serve to fill memory.
const MAX_BODY_BYTES = 256 * 1024;

// Wire name, not a stale one. It is written into the settings file every
// running session was spawned with, so renaming it would silently stop
// every already-running CLI from being able to report its state.
const HEADER_TOKEN = 'x-switchboard-hook-token';
const HOOK_PATH = '/hook';

// ── Helpers ──

/** Get a random free port from the OS. Mirrors mcp-bridge.js:findFreePort. */
function findFreePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, host, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

// ── Server ──

let state = null;
let starting = null;

/**
 * Start the hook endpoint. Idempotent, and safe to call concurrently: sessions
 * spawned in a batch (an external launcher firing several `wootonpad://` opens
 * at once) all await the same startup rather than racing to bind their own.
 *
 * @param {object} opts
 * @param {(payload: object) => void} opts.onEvent  called with each hook body
 * @param {object} [opts.log]                       electron-log, injected
 * @returns {Promise<{ port: number, token: string, urlFor: (isWsl: boolean) => string|null }>}
 */
function startHookServer({ onEvent, log = null } = {}) {
  if (state) return Promise.resolve(state.handle);
  if (starting) return starting;
  starting = _start({ onEvent, log }).finally(() => { starting = null; });
  return starting;
}

async function _start({ onEvent, log }) {
  const token = crypto.randomBytes(32).toString('hex');

  const handler = (req, res) => {
    // Respond to anything unexpected without reading a body: a stray GET from a
    // browser or a port scanner should cost nothing.
    if (req.method !== 'POST' || (req.url || '').split('?')[0] !== HOOK_PATH) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    // The token is the only thing standing between this endpoint and any other
    // process on the machine driving the session indicators. It is generated
    // per app start and only ever written to the per-session settings file.
    if (req.headers[HEADER_TOKEN] !== token) {
      if (log) log.warn('[hooks] rejected a POST with a bad or missing token');
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }

    let body = '';
    let tooBig = false;
    req.on('data', chunk => {
      if (tooBig) return;
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        tooBig = true;
        body = '';
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooBig) return;
      // Answer before doing anything with the payload. The CLI blocks on this
      // response — a hook that is slow to reply is a session that is slow to
      // run its next tool, so no parsing, no IPC and no rendering happens on
      // this side of the write. An empty object is "no decision, carry on".
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');

      setImmediate(() => {
        let payload;
        try {
          payload = JSON.parse(body);
        } catch {
          if (log) log.debug('[hooks] discarded a body that was not JSON');
          return;
        }
        try {
          onEvent(payload);
        } catch (err) {
          if (log) log.error(`[hooks] onEvent threw: ${err.message}`);
        }
      });
    });
    req.on('error', () => { /* client vanished mid-body; nothing to do */ });
  };

  const port = await findFreePort('127.0.0.1');
  const loopback = http.createServer(handler);
  await listen(loopback, port, '127.0.0.1');

  // The distribution reaches the host over the vEthernet (WSL) adapter. Binding
  // there is additive: loopback sessions keep using 127.0.0.1, so nothing is
  // exposed beyond what a WSL account already requires.
  let wslHost = null;
  let wslServer = null;
  const candidate = wslHostAddressFrom(os.networkInterfaces());
  if (candidate) {
    try {
      wslServer = http.createServer(handler);
      await listen(wslServer, port, candidate);
      wslHost = candidate;
    } catch (err) {
      wslServer = null;
      if (log) log.warn(`[hooks] could not bind ${candidate}:${port} for WSL sessions: ${err.message}`);
    }
  }

  const handle = {
    port,
    token,
    /**
     * Base URL a session should POST to. Returns null for a WSL session when no
     * vEthernet address could be bound — the caller then skips hook injection
     * for that session rather than handing the CLI a URL it cannot reach.
     */
    urlFor(isWsl) {
      if (isWsl) return wslHost ? `http://${wslHost}:${port}${HOOK_PATH}` : null;
      return `http://127.0.0.1:${port}${HOOK_PATH}`;
    },
  };

  state = { handle, loopback, wslServer };
  if (log) {
    log.info(`[hooks] listening on 127.0.0.1:${port}${wslHost ? ` and ${wslHost}:${port}` : ''}`);
    if (!wslHost) log.debug('[hooks] no vEthernet (WSL) address — WSL sessions will fall back to OSC detection');
  }
  return handle;
}

/** Close both listeners. Safe to call when nothing was started. */
function stopHookServer() {
  if (!state) return;
  try { state.loopback.close(); } catch {}
  if (state.wslServer) {
    try { state.wslServer.close(); } catch {}
  }
  state = null;
  starting = null;
}

module.exports = {
  startHookServer,
  stopHookServer,
  findFreePort,
  MAX_BODY_BYTES,
  HEADER_TOKEN,
  HOOK_PATH,
};
