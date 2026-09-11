const test = require('node:test');
const assert = require('node:assert/strict');
const {
  columnOf, mostUrgent, worstColumn, OPEN_ORDER,
} = require('../src/vue/session-column.js');

const state = (over = {}) => ({
  attention: new Set(over.attention || []),
  busy: new Map((over.busy || []).map(id => [id, true])),
  responseReady: new Set(over.responseReady || []),
  readPending: new Set(over.readPending || []),
  ...(over.raw || {}),
});

const at = (sessionId, minutesAgo) => ({
  sessionId,
  modified: new Date(Date.now() - minutesAgo * 60000).toISOString(),
});

// ── Placement ─────────────────────────────────────────────────────

test('a session with nothing on it is idle', () => {
  assert.equal(columnOf('a', state()), 'idle');
});

test('blocked on the user outranks everything else', () => {
  const s = state({ attention: ['a'], busy: ['a'], responseReady: ['a'] });
  assert.equal(columnOf('a', s), 'waiting');
});

// A session you read and then sent back to work is working, not finished.
test('running outranks a turn that was already read', () => {
  assert.equal(columnOf('a', state({ busy: ['a'], readPending: ['a'] })), 'running');
});

test('a finished turn is done whether it was read or not', () => {
  assert.equal(columnOf('a', state({ responseReady: ['a'] })), 'done');
  assert.equal(columnOf('a', state({ readPending: ['a'] })), 'done');
});

test('missing collections never throw', () => {
  assert.equal(columnOf('a', {}), 'idle');
});

// ── Which one to open ─────────────────────────────────────────────

// The whole point: a project with a dozen sessions has one holding a dialog,
// and clicking the project should land there rather than on the newest.
test('the session holding a dialog wins over a more recent one', () => {
  const sessions = [at('busy', 1), at('waiting', 90), at('quiet', 0)];
  const s = state({ attention: ['waiting'], busy: ['busy'] });
  assert.equal(mostUrgent(sessions, s).sessionId, 'waiting');
});

test('a finished turn is opened before one still being written', () => {
  const sessions = [at('busy', 0), at('done', 30)];
  assert.equal(mostUrgent(sessions, state({ busy: ['busy'], responseReady: ['done'] })).sessionId, 'done');
});

test('and a running one before an idle one', () => {
  const sessions = [at('idle', 0), at('busy', 60)];
  assert.equal(mostUrgent(sessions, state({ busy: ['busy'] })).sessionId, 'busy');
});

test('inside one lane the most recent wins', () => {
  const sessions = [at('old', 120), at('new', 2), at('mid', 40)];
  assert.equal(mostUrgent(sessions, state()).sessionId, 'new');
});

test('two sessions waiting: the one touched last', () => {
  const sessions = [at('first', 200), at('second', 5)];
  assert.equal(mostUrgent(sessions, state({ attention: ['first', 'second'] })).sessionId, 'second');
});

test('an empty or malformed list yields nothing rather than throwing', () => {
  assert.equal(mostUrgent([], state()), null);
  assert.equal(mostUrgent(undefined, state()), null);
  assert.equal(mostUrgent([null, {}], state()), null);
});

test('a session with no timestamp is still openable', () => {
  assert.equal(mostUrgent([{ sessionId: 'a' }], state()).sessionId, 'a');
});

// ── A project's status ────────────────────────────────────────────

test('a project takes the worst state anything in it is in', () => {
  const sessions = [at('a', 1), at('b', 2), at('c', 3)];
  assert.equal(worstColumn(sessions, state({ busy: ['a'] })), 'running');
  assert.equal(worstColumn(sessions, state({ busy: ['a'], attention: ['c'] })), 'waiting');
  assert.equal(worstColumn(sessions, state({ busy: ['a'], responseReady: ['b'] })), 'done');
  assert.equal(worstColumn(sessions, state()), 'idle');
});

test('the open order puts an answer before a read and a read before work', () => {
  assert.ok(OPEN_ORDER.waiting < OPEN_ORDER.done);
  assert.ok(OPEN_ORDER.done < OPEN_ORDER.running);
  assert.ok(OPEN_ORDER.running < OPEN_ORDER.idle);
});
