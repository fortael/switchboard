const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readSessionFile } = require('../read-session-file');

function makeTmpSession(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-session-'));
  const file = path.join(dir, 'abc123.jsonl');
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return { dir, file };
}

test('parses a minimal valid session', () => {
  const { file, dir } = makeTmpSession([
    { type: 'user', message: 'Hello world', cwd: '/some/project', sessionId: 'abc123' },
    { type: 'assistant', message: 'Hi there' },
  ]);
  try {
    const session = readSessionFile(file, 'some-folder', '/some/project');
    assert.ok(session, 'should return a session object');
    assert.equal(session.sessionId, 'abc123');
    assert.equal(session.summary, 'Hello world');
    assert.equal(session.messageCount, 2);
    assert.equal(session.folder, 'some-folder');
    assert.equal(session.projectPath, '/some/project');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('returns null when no user messages', () => {
  const { file, dir } = makeTmpSession([
    { type: 'assistant', message: 'Only assistant' },
  ]);
  try {
    const session = readSessionFile(file, 'folder', '/path');
    assert.equal(session, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('extracts slug from first entry that has it', () => {
  const { file, dir } = makeTmpSession([
    { type: 'user', message: 'Start', slug: 'my-task' },
    { type: 'assistant', message: 'Response' },
  ]);
  try {
    const session = readSessionFile(file, 'folder', '/path');
    assert.equal(session.slug, 'my-task');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('extracts aiTitle', () => {
  const { file, dir } = makeTmpSession([
    { type: 'user', message: 'Do something' },
    { type: 'ai-title', aiTitle: 'Generated Title' },
    { type: 'assistant', message: 'Done' },
  ]);
  try {
    const session = readSessionFile(file, 'folder', '/path');
    assert.equal(session.aiTitle, 'Generated Title');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('extracts customTitle', () => {
  const { file, dir } = makeTmpSession([
    { type: 'user', message: 'Do something' },
    { type: 'custom-title', customTitle: 'My Custom Name' },
    { type: 'assistant', message: 'Done' },
  ]);
  try {
    const session = readSessionFile(file, 'folder', '/path');
    assert.equal(session.customTitle, 'My Custom Name');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('skips local command messages for summary', () => {
  const { file, dir } = makeTmpSession([
    { type: 'user', message: '<local-command-caveat>! ls</local-command-caveat>' },
    { type: 'user', message: 'Real first message' },
    { type: 'assistant', message: 'Response' },
  ]);
  try {
    const session = readSessionFile(file, 'folder', '/path');
    assert.equal(session.summary, 'Real first message');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The CLI's envelope for a slash command, indentation and all — the indentation is
// what pushes it past the summary limit, so it is part of the case.
const slashCommand = (name, message, args = '') =>
  `<command-name>/${name}</command-name>\n` +
  `            <command-message>${message}</command-message>\n` +
  `            <command-args>${args}</command-args>`;

test('a session started with a slash command is titled with the command', () => {
  // Cutting to length before stripping markup titled this "/clear clear </com":
  // 120 characters of the envelope ended partway through `</command-args>`, and
  // half a tag matches no tag.
  const { file, dir } = makeTmpSession([
    { type: 'user', message: slashCommand('clear', 'clear') },
    { type: 'assistant', message: 'Response' },
  ]);
  try {
    assert.equal(readSessionFile(file, 'folder', '/path').summary, '/clear');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a slash command keeps its arguments, which are what tell two runs apart', () => {
  const { file, dir } = makeTmpSession([
    { type: 'user', message: slashCommand('code-review', 'code-review', '--fix') },
    { type: 'assistant', message: 'Response' },
  ]);
  try {
    assert.equal(readSessionFile(file, 'folder', '/path').summary, '/code-review --fix');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a tag straddling the length limit leaves no half tag behind', () => {
  // The general form of the bug, without a slash command: the cut lands inside a
  // closing tag, and half a tag matches no tag, so it used to survive stripping.
  // Tag *contents* are text and are kept — that is what cleanDisplayName has
  // always done, and this only moves the cut to after the stripping.
  const prose = 'Rewrite the payment retry logic so a declined card is not retried forever again';
  const { file, dir } = makeTmpSession([
    { type: 'user', message: `${prose} <system-reminder>keep going</system-reminder>` },
    { type: 'assistant', message: 'Response' },
  ]);
  try {
    const summary = readSessionFile(file, 'folder', '/path').summary;
    assert.ok(summary.startsWith(prose), `prose missing from ${JSON.stringify(summary)}`);
    assert.doesNotMatch(summary, /[<>]/, 'no markup, whole or partial, survives');
    assert.ok(summary.length <= 120);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a message that is nothing but markup defers to the next one', () => {
  const { file, dir } = makeTmpSession([
    { type: 'user', message: '<system-reminder></system-reminder>' },
    { type: 'user', message: 'The actual question' },
    { type: 'assistant', message: 'Response' },
  ]);
  try {
    assert.equal(readSessionFile(file, 'folder', '/path').summary, 'The actual question');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a session whose every message is markup is still listed', () => {
  // Stripping before cutting means such a session summarizes to nothing, and a
  // session with no summary is dropped from the list entirely. It keeps its raw
  // text instead — a poor title is not the same as disappearing.
  const { file, dir } = makeTmpSession([
    { type: 'user', message: '<system-reminder></system-reminder>' },
    { type: 'assistant', message: 'Response' },
  ]);
  try {
    const session = readSessionFile(file, 'folder', '/path');
    assert.ok(session, 'the session must still be listed');
    assert.ok(session.summary.length > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a scheduled task still names itself', () => {
  const { file, dir } = makeTmpSession([
    { type: 'user', message: '<scheduled-task name="nightly-audit">run the audit</scheduled-task>' },
    { type: 'assistant', message: 'Response' },
  ]);
  try {
    assert.equal(readSessionFile(file, 'folder', '/path').summary, 'Scheduled: nightly-audit');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('returns null for empty file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-session-'));
  const file = path.join(dir, 'empty.jsonl');
  fs.writeFileSync(file, '', 'utf8');
  try {
    const session = readSessionFile(file, 'folder', '/path');
    assert.equal(session, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('returns null for non-existent file', () => {
  const session = readSessionFile('/nonexistent/path/file.jsonl', 'folder', '/path');
  assert.equal(session, null);
});

test('uses scheduled task name in summary', () => {
  const { file, dir } = makeTmpSession([
    { type: 'user', message: '<scheduled-task name="Daily Digest">run the task</scheduled-task>' },
    { type: 'assistant', message: 'Done' },
  ]);
  try {
    const session = readSessionFile(file, 'folder', '/path');
    assert.ok(session.summary.includes('Daily Digest'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
