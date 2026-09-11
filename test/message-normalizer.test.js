const test = require('node:test');
const assert = require('node:assert/strict');
const { normalize, normalizeUntyped, messageLabel } = require('../src/vue/message-normalizer.ts');

const assistant = (content) => ({ type: 'assistant', message: { role: 'assistant', content }, session_id: 's' });
const kinds = (items) => items.map(i => i.kind);

test('assistant text becomes a text item', () => {
  const items = normalize(assistant([{ type: 'text', text: 'hello' }]));
  assert.deepEqual(items, [{ kind: 'text', role: 'assistant', text: 'hello' }]);
});

test('empty and whitespace-only text is dropped rather than rendered blank', () => {
  assert.deepEqual(normalize(assistant([{ type: 'text', text: '   ' }])), []);
});

test('thinking, tool_use and tool_result each get their own item', () => {
  const items = normalize(assistant([
    { type: 'thinking', thinking: 'considering' },
    { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/a' } },
    { type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' },
  ]));
  assert.deepEqual(kinds(items), ['thinking', 'tool_use', 'tool_result']);
  assert.equal(items[1].name, 'Read');
  assert.deepEqual(items[1].input, { file_path: '/tmp/a' });
  assert.equal(items[2].toolUseId, 'toolu_1');
  assert.equal(items[2].isError, false);
});

test('a failed tool result carries its error flag', () => {
  const items = normalize(assistant([
    { type: 'tool_result', tool_use_id: 't', content: 'boom', is_error: true },
  ]));
  assert.equal(items[0].isError, true);
});

test('string content is accepted as well as blocks', () => {
  assert.deepEqual(normalize(assistant('plain')), [{ kind: 'text', role: 'assistant', text: 'plain' }]);
});

// Content blocks are an open set with no exhaustive type to check against, so
// the runtime card is the only thing standing between a new block and silence.
test('an unrecognised content block becomes a visible unknown item', () => {
  const items = normalize(assistant([{ type: 'redacted_thinking', data: 'xx' }]));
  assert.equal(items[0].kind, 'unknown');
  assert.equal(items[0].label, 'block:redacted_thinking');
  assert.deepEqual(items[0].raw, { type: 'redacted_thinking', data: 'xx' });
});

test('a result closes the turn and reports whether it succeeded', () => {
  assert.deepEqual(normalize({ type: 'result', subtype: 'success', result: 'done', session_id: 's' }),
    [{ kind: 'turn_end', ok: true, text: 'done' }]);
  assert.equal(normalize({ type: 'result', subtype: 'error_during_execution', session_id: 's' })[0].ok, false);
});

test('a text delta carries the token that was just written', () => {
  assert.deepEqual(normalize({
    type: 'stream_event',
    session_id: 's',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } },
  }), [{ kind: 'delta', target: 'text', text: 'Hel' }]);
});

test('a thinking delta is told apart from a spoken one', () => {
  assert.deepEqual(normalize({
    type: 'stream_event',
    session_id: 's',
    event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } },
  }), [{ kind: 'delta', target: 'thinking', text: 'hmm' }]);
});

// Frames with nothing to paint still say the turn is alive, which is what
// keeps the working indicator up through a long silence.
test('every other stream frame is a delta with no text', () => {
  for (const event of [undefined, { type: 'message_start' }, { type: 'content_block_stop' },
    { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{' } }]) {
    assert.deepEqual(normalize({ type: 'stream_event', session_id: 's', event }),
      [{ kind: 'delta', target: 'other', text: '' }]);
  }
});

test('session bookkeeping is silent, with the reason recorded', () => {
  const items = normalize({ type: 'system', subtype: 'init', session_id: 's' });
  assert.deepEqual(items, [{ kind: 'silent', reason: 'init' }]);
});

test('a compaction and a refusal each surface as a notice', () => {
  assert.equal(normalize({ type: 'system', subtype: 'compact_boundary', session_id: 's' })[0].kind, 'notice');
  const refusal = normalize({ type: 'system', subtype: 'model_refusal_no_fallback', session_id: 's' })[0];
  assert.equal(refusal.level, 'error');
});

test('a notification renders its text, and an immediate one is raised to a warning', () => {
  const low = normalize({ type: 'system', subtype: 'notification', text: 'heads up', priority: 'low', key: 'k', session_id: 's' });
  assert.deepEqual(low, [{ kind: 'notice', level: 'info', text: 'heads up' }]);
  const urgent = normalize({ type: 'system', subtype: 'notification', text: 'look now', priority: 'immediate', key: 'k', session_id: 's' });
  assert.equal(urgent[0].level, 'warn');
});

// The reason this module exists. Live sessions were seen emitting
// `system:post_turn_summary` and `system:task_summary`, neither of which is in
// the shipped .d.ts — so the compiler could not have caught them.
test('a system subtype nobody has ever seen is surfaced, not swallowed', () => {
  const items = normalize({ type: 'system', subtype: 'something_from_2027', session_id: 's' });
  assert.equal(items[0].kind, 'unknown');
  assert.equal(items[0].label, 'system:something_from_2027');
});

// These two are emitted on every turn but are absent from the shipped types,
// so the compiler cannot route them and they would otherwise raise an unknown
// card per turn. Silencing them is a deliberate, documented exception.
test('subtypes known only from observation are silent, not unknown', () => {
  for (const subtype of ['post_turn_summary', 'task_summary']) {
    const items = normalize({ type: 'system', subtype, session_id: 's' });
    assert.equal(items[0].kind, 'silent', `${subtype} should not cry wolf`);
    assert.equal(items[0].reason, `undeclared:${subtype}`);
  }
});

test('a message type the types do not declare is surfaced too', () => {
  const items = normalize({ type: 'telepathy', session_id: 's' });
  assert.equal(items[0].kind, 'unknown');
  assert.equal(items[0].label, 'telepathy');
});

test('malformed input never throws and never disappears', () => {
  for (const bad of [null, undefined, 42, 'string', {}, { type: 7 }]) {
    const items = normalizeUntyped(bad);
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, 'unknown');
  }
});

test('labels read the way the logs and the card both need', () => {
  assert.equal(messageLabel({ type: 'system', subtype: 'init' }), 'system:init');
  assert.equal(messageLabel({ type: 'assistant' }), 'assistant');
  assert.equal(messageLabel(null), 'malformed');
});
