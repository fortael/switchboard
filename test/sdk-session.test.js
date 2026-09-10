const test = require('node:test');
const assert = require('node:assert/strict');
const { createInputQueue, userMessage } = require('../sdk-session');

test('a queued message is delivered to a later reader', async () => {
  const q = createInputQueue();
  q.push('a');
  q.push('b');
  const it = q[Symbol.asyncIterator]();
  assert.deepEqual(await it.next(), { value: 'a', done: false });
  assert.deepEqual(await it.next(), { value: 'b', done: false });
});

// The whole point of the queue: query() asks for the next prompt long before
// the user has typed it, so the read has to park rather than end the stream.
test('a reader waiting on an empty queue is woken by a push', async () => {
  const q = createInputQueue();
  const it = q[Symbol.asyncIterator]();
  const pending = it.next();
  let settled = false;
  pending.then(() => { settled = true; });
  await new Promise(r => setImmediate(r));
  assert.equal(settled, false, 'the read parked instead of ending the stream');
  q.push('typed later');
  assert.deepEqual(await pending, { value: 'typed later', done: false });
});

test('closing ends the stream and wakes a parked reader', async () => {
  const q = createInputQueue();
  const it = q[Symbol.asyncIterator]();
  const pending = it.next();
  q.close();
  assert.deepEqual(await pending, { value: undefined, done: true });
  assert.equal(q.closed, true);
});

test('messages queued before a close are still drained', async () => {
  const q = createInputQueue();
  q.push('first');
  q.close();
  const it = q[Symbol.asyncIterator]();
  assert.deepEqual(await it.next(), { value: 'first', done: false });
  assert.deepEqual(await it.next(), { value: undefined, done: true });
});

test('a closed queue refuses new input', () => {
  const q = createInputQueue();
  q.close();
  assert.equal(q.push('too late'), false);
});

test('the queue is iterable with for-await', async () => {
  const q = createInputQueue();
  q.push('one');
  q.push('two');
  q.close();
  const seen = [];
  for await (const m of q) seen.push(m);
  assert.deepEqual(seen, ['one', 'two']);
});

test('a prompt is wrapped in the shape the SDK expects', () => {
  const m = userMessage('hello');
  assert.equal(m.type, 'user');
  assert.equal(m.message.role, 'user');
  assert.equal(m.message.content, 'hello');
  assert.equal(m.parent_tool_use_id, null);
});
