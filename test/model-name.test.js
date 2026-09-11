const test = require('node:test');
const assert = require('node:assert/strict');
const { modelName, modelLabels, defaultModelValue } = require('../src/vue/model-name.js');

// The rows a real session reported, verbatim — see supportedModels().
const LIVE = [
  { value: 'default', resolvedModel: 'claude-opus-5[1m]', displayName: 'Default (recommended)' },
  { value: 'opus[1m]', resolvedModel: 'claude-opus-5[1m]', displayName: 'Opus (1M context)' },
  { value: 'claude-fable-5-1[1m]', resolvedModel: 'claude-fable-5-1', displayName: 'Fable' },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet' },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku' },
];

// ── Name ──────────────────────────────────────────────────────────

test('a wire id reads the way the CLI names the model', () => {
  assert.equal(modelName('claude-opus-5'), 'Opus 5');
  assert.equal(modelName('claude-sonnet-5'), 'Sonnet 5');
  assert.equal(modelName('claude-fable-5-1'), 'Fable 5.1');
});

// The date pins a snapshot; nobody reads a model as "Haiku 4.5 20251001".
test('a trailing snapshot date is not part of the name', () => {
  assert.equal(modelName('claude-haiku-4-5-20251001'), 'Haiku 4.5');
});

// [1m] says how much context, not which version.
test('the context marker is stripped rather than read as a version', () => {
  assert.equal(modelName('claude-opus-5[1m]'), 'Opus 5');
  assert.equal(modelName('claude-fable-5-1[1m]'), 'Fable 5.1');
});

// Older ids put the version first. Same model, same reading.
test('digits before the name still land in the version', () => {
  assert.equal(modelName('claude-3-5-sonnet-20241022'), 'Sonnet 3.5');
  assert.equal(modelName('claude-3-opus-20240229'), 'Opus 3');
});

test('an id with no version is just a name', () => {
  assert.equal(modelName('claude-sonnet'), 'Sonnet');
});

test('an unfamiliar id still produces something readable', () => {
  assert.equal(modelName('some-new-model-7'), 'Some New Model 7');
});

test('nothing in, nothing out', () => {
  for (const value of ['', null, undefined, '   ', 'claude-']) {
    assert.equal(modelName(value), '');
  }
});

// ── Labels ────────────────────────────────────────────────────────

test('rows that differ get the short name and nothing else', () => {
  const labels = modelLabels(LIVE);
  assert.equal(labels.get('claude-fable-5-1[1m]'), 'Fable 5.1');
  assert.equal(labels.get('sonnet'), 'Sonnet 5');
  assert.equal(labels.get('haiku'), 'Haiku 4.5');
});

// `default` and `opus[1m]` resolve to the same wire id, so both read "Opus 5".
// True, and useless in a list — the qualifier is what tells them apart.
test('rows that would read the same are told apart by what differs', () => {
  const labels = modelLabels(LIVE);
  assert.equal(labels.get('default'), 'Opus 5 · Default');
  assert.equal(labels.get('opus[1m]'), 'Opus 5 · 1M');
});

// The qualifier is noise when nothing collides, so it is not added.
test('a list with no duplicates carries no qualifiers at all', () => {
  const labels = modelLabels(LIVE.filter(m => m.value !== 'opus[1m]'));
  assert.equal(labels.get('default'), 'Opus 5');
});

test('a row whose id says nothing falls back to its display name', () => {
  const labels = modelLabels([{ value: 'x', displayName: 'Something (recommended)' }]);
  assert.equal(labels.get('x'), 'Something');
});

test('every row gets a label, and none is empty', () => {
  const labels = modelLabels(LIVE);
  assert.equal(labels.size, LIVE.length);
  for (const m of LIVE) assert.ok(labels.get(m.value));
});

test('a malformed list never throws', () => {
  assert.equal(modelLabels(null).size, 0);
  assert.equal(modelLabels([null, undefined, {}]).size, 0);
});

// ── The row a new chat is on ──────────────────────────────────────

// A chat that has not had a turn has no `system/init` to read, and a blank
// picker reads as broken rather than as "not chosen yet".
test('the default row is what a fresh chat shows', () => {
  assert.equal(defaultModelValue(LIVE), 'default');
});

test('with no default row, the first one stands in', () => {
  assert.equal(defaultModelValue(LIVE.slice(2)), 'claude-fable-5-1[1m]');
});

test('an empty list yields no selection rather than throwing', () => {
  assert.equal(defaultModelValue([]), '');
  assert.equal(defaultModelValue(undefined), '');
});
