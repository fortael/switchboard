const test = require('node:test');
const assert = require('node:assert/strict');
const {
  describePermission, permissionChoices, clip, MAX_LINES, MAX_CHARS,
} = require('../src/vue/permission-describe.js');

test('a write names the file and previews what goes in it', () => {
  const d = describePermission('Write', { file_path: '/a/b/note.txt', content: 'banana\n' });
  assert.equal(d.question, 'Write to note.txt?');
  assert.equal(d.subject, '/a/b/note.txt');
  assert.equal(d.detail, 'banana\n');
});

test('an edit shows the replacement, which is what will exist afterwards', () => {
  const d = describePermission('Edit', {
    file_path: '/src/app.js', old_string: 'let a = 1', new_string: 'const a = 1',
  });
  assert.equal(d.question, 'Edit app.js?');
  assert.equal(d.detail, 'const a = 1');
});

test('a multi-edit joins its replacements', () => {
  const d = describePermission('MultiEdit', {
    file_path: '/src/app.js',
    edits: [{ new_string: 'first' }, { new_string: 'second' }],
  });
  assert.equal(d.detail, 'first\nsecond');
});

test('a shell command is the body, and its description is the question', () => {
  const d = describePermission('Bash', { command: 'rm -rf build', description: 'Clean the build' });
  assert.equal(d.question, 'Run: Clean the build?');
  assert.equal(d.detail, 'rm -rf build');
});

test('a shell command with no description still asks plainly', () => {
  assert.equal(describePermission('Bash', { command: 'ls' }).question, 'Run a shell command?');
});

test('a fetch is named by its host, not its whole URL', () => {
  const d = describePermission('WebFetch', { url: 'https://example.com/a/very/long/path?q=1' });
  assert.equal(d.question, 'Fetch example.com?');
  assert.equal(d.subject, 'https://example.com/a/very/long/path?q=1');
});

test('a malformed URL degrades to the raw string instead of throwing', () => {
  assert.equal(describePermission('WebFetch', { url: 'not a url' }).question, 'Fetch not a url?');
});

test('an unknown tool still asks a real question and shows its payload', () => {
  const d = describePermission('mcp__something__do_it', { any: 'shape' });
  assert.equal(d.question, 'Allow mcp__something__do_it?');
  assert.match(d.detail, /"any": "shape"/);
});

test('a missing tool name and input never throw', () => {
  const d = describePermission(undefined, undefined);
  assert.equal(d.question, 'Allow a tool?');
  assert.equal(typeof d.detail, 'string');
});

// The body is a glance, not a read: a long file must not push the buttons off
// the screen.
test('the body is clipped to three lines and says it was', () => {
  const clipped = clip('one\ntwo\nthree\nfour\nfive');
  assert.equal(clipped, 'one\ntwo\nthree\n…');
  assert.equal(clipped.split('\n').length, MAX_LINES + 1);
});

test('the body is clipped by length as well as by lines', () => {
  const clipped = clip('x'.repeat(MAX_CHARS + 500));
  assert.equal(clipped.length, MAX_CHARS + 2);   // + newline + ellipsis
  assert.ok(clipped.endsWith('\n…'));
});

test('short bodies are left exactly as they are', () => {
  assert.equal(clip('one\ntwo'), 'one\ntwo');
  assert.equal(clip(''), '');
});

test('a non-string body is rendered rather than dropped', () => {
  assert.match(clip({ a: 1 }), /"a": 1/);
});

// The CLI sends the sentence it would have rendered itself. It knows about
// tools this build has never heard of, so it wins over a reconstruction.
test('the sentence the CLI rendered wins over the one built here', () => {
  const d = describePermission('Read', { file_path: '/a/b/note.txt' },
    { title: 'Claude wants to read note.txt' });
  assert.equal(d.question, 'Claude wants to read note.txt?');
  // The local branch still knows which part of the payload is worth showing.
  assert.equal(d.subject, '/a/b/note.txt');
});

test('a bridge sentence that already ends in punctuation is not given a second mark', () => {
  const d = describePermission('Read', {}, { title: 'Allow this?' });
  assert.equal(d.question, 'Allow this?');
});

test('an absent or blank bridge title leaves the local sentence alone', () => {
  assert.equal(describePermission('WebSearch', { query: 'x' }, {}).question, 'Search the web?');
  assert.equal(describePermission('WebSearch', { query: 'x' }, { title: '  ' }).question, 'Search the web?');
});

// ── Choices ───────────────────────────────────────────────────────

test('a permission is answered yes or no, in that order', () => {
  const choices = permissionChoices({});
  assert.deepEqual(choices.map(c => c.id), ['allow', 'deny']);
});

// "Always" only means something when the CLI handed over rules to install.
test('always-allow appears only when the CLI offered rules for it', () => {
  const choices = permissionChoices({ suggestions: [{ type: 'addRules', rules: [] }] });
  assert.deepEqual(choices.map(c => c.id), ['allow', 'always', 'deny']);
});

test('no request at all still yields an answerable list', () => {
  assert.equal(permissionChoices(undefined).length, 2);
});
