const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { startHookServer, stopHookServer, HEADER_TOKEN } = require('../hook-server');
const { SessionStatusTracker } = require('../session-status');

function post(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
    }, res => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
}

/** The server answers before it processes, so give the setImmediate a turn. */
const settle = () => new Promise(r => setTimeout(r, 20));

test('hook payloads reach the tracker and unauthenticated ones do not', async (t) => {
  const tracker = new SessionStatusTracker();
  const server = await startHookServer({ onEvent: p => tracker.apply(p) });
  t.after(() => stopHookServer());

  const url = server.urlFor(false);
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/hook$/);
  const auth = { [HEADER_TOKEN]: server.token };

  const ok = await post(url, { session_id: 's1', hook_event_name: 'UserPromptSubmit' }, auth);
  assert.equal(ok.status, 200);
  assert.equal(ok.text, '{}', 'an empty decision means "carry on"');
  await settle();
  assert.equal(tracker.get('s1').state, 'running');

  // Any other local process must not be able to drive the indicators.
  const bad = await post(url, { session_id: 's1', hook_event_name: 'Stop' }, { [HEADER_TOKEN]: 'wrong' });
  assert.equal(bad.status, 401);
  const none = await post(url, { session_id: 's1', hook_event_name: 'Stop' });
  assert.equal(none.status, 401);
  await settle();
  assert.equal(tracker.get('s1').state, 'running', 'rejected posts changed nothing');

  const stop = await post(url, { session_id: 's1', hook_event_name: 'Stop' }, auth);
  assert.equal(stop.status, 200);
  await settle();
  assert.equal(tracker.get('s1').state, 'idle');
});

test('a malformed body is answered and discarded without throwing', async (t) => {
  const tracker = new SessionStatusTracker();
  const server = await startHookServer({ onEvent: p => tracker.apply(p) });
  t.after(() => stopHookServer());

  const res = await post(server.urlFor(false), 'not json at all', { [HEADER_TOKEN]: server.token });
  assert.equal(res.status, 200);
  await settle();
  assert.equal(tracker.all().length, 0);
});

test('a handler that throws does not take the server down', async (t) => {
  const server = await startHookServer({ onEvent: () => { throw new Error('boom'); } });
  t.after(() => stopHookServer());

  const url = server.urlFor(false);
  const auth = { [HEADER_TOKEN]: server.token };
  assert.equal((await post(url, { session_id: 's1', hook_event_name: 'Stop' }, auth)).status, 200);
  await settle();
  assert.equal((await post(url, { session_id: 's1', hook_event_name: 'Stop' }, auth)).status, 200);
});

test('concurrent starts share one listener', async (t) => {
  const handles = await Promise.all([
    startHookServer({ onEvent: () => {} }),
    startHookServer({ onEvent: () => {} }),
    startHookServer({ onEvent: () => {} }),
  ]);
  t.after(() => stopHookServer());
  assert.equal(new Set(handles.map(h => h.port)).size, 1, 'a batch of sessions must not each bind a port');
  assert.equal(new Set(handles.map(h => h.token)).size, 1);
});

test('unknown paths and methods are refused cheaply', async (t) => {
  const server = await startHookServer({ onEvent: () => {} });
  t.after(() => stopHookServer());

  const base = server.urlFor(false).replace('/hook', '');
  const auth = { [HEADER_TOKEN]: server.token };
  assert.equal((await post(`${base}/elsewhere`, {}, auth)).status, 404);

  const got = await new Promise((resolve, reject) => {
    const target = new URL(server.urlFor(false));
    http.get({ hostname: target.hostname, port: target.port, path: target.pathname, headers: auth },
      res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(got, 404);
});
