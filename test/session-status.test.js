const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionStatusTracker } = require('../session-status');
const { buildHookSettings, HOOK_EVENTS } = require('../hook-settings');

function makeTracker() {
  const changes = [];
  const tracker = new SessionStatusTracker({
    onChange: (sessionId, snapshot) => changes.push({ sessionId, ...snapshot }),
  });
  return { tracker, changes };
}

const hook = (event, extra = {}) => ({ session_id: 's1', hook_event_name: event, ...extra });

test('a fresh session reports nothing until an event arrives', () => {
  const { tracker } = makeTracker();
  assert.equal(tracker.get('s1'), null);
});

test('a submitted prompt runs and a Stop returns to idle', () => {
  const { tracker, changes } = makeTracker();
  tracker.apply(hook('UserPromptSubmit'));
  assert.equal(tracker.get('s1').state, 'running');
  tracker.apply(hook('Stop', { last_assistant_message: 'done' }));
  assert.equal(tracker.get('s1').state, 'idle');
  assert.equal(tracker.get('s1').lastAssistantMessage, 'done');
  assert.deepEqual(changes.map(c => c.state), ['running', 'idle']);
});

// The bug this module exists for: the turn ended, but the only idle signal the
// old detector had was a title update it could miss.
test('Stop clears a running session even with no preceding events', () => {
  const { tracker } = makeTracker();
  tracker.applyOsc('s1', true);
  assert.equal(tracker.get('s1').state, 'running');
  tracker.apply(hook('Stop'));
  assert.equal(tracker.get('s1').state, 'idle');
});

test('StopFailure lands on idle and records the error rather than staying busy', () => {
  const { tracker } = makeTracker();
  tracker.apply(hook('UserPromptSubmit'));
  tracker.apply(hook('StopFailure', { error_details: 'overloaded_error' }));
  const snap = tracker.get('s1');
  assert.equal(snap.state, 'idle');
  assert.equal(snap.error, 'overloaded_error');
});

test('a Stop parked on background work stays running', () => {
  const { tracker } = makeTracker();
  tracker.apply(hook('UserPromptSubmit'));
  tracker.apply(hook('Stop', { background_tasks: [{ id: 'bg1' }] }));
  assert.equal(tracker.get('s1').state, 'running');
});

test('PermissionRequest parks the session in requires_action', () => {
  const { tracker } = makeTracker();
  tracker.apply(hook('UserPromptSubmit'));
  tracker.apply(hook('PreToolUse', { tool_name: 'Bash' }));
  assert.equal(tracker.get('s1').tool, 'Bash');
  tracker.apply(hook('PermissionRequest'));
  assert.equal(tracker.get('s1').state, 'requires_action');
  tracker.apply(hook('PostToolUse', { tool_name: 'Bash' }));
  assert.equal(tracker.get('s1').state, 'running');
  assert.equal(tracker.get('s1').tool, null);
});

test('a permission_prompt notification requires action, idle_prompt goes idle', () => {
  const { tracker } = makeTracker();
  tracker.apply(hook('UserPromptSubmit'));
  tracker.apply(hook('Notification', { notification_type: 'permission_prompt', message: 'needs your permission' }));
  assert.equal(tracker.get('s1').state, 'requires_action');
  assert.equal(tracker.get('s1').message, 'needs your permission');
  tracker.apply(hook('Notification', { notification_type: 'idle_prompt' }));
  assert.equal(tracker.get('s1').state, 'idle');
});

// notification_type is typed `string` in the SDK, not a closed union — the CLI
// adds new ones. An unknown one must not move the session to a wrong column.
test('an unknown notification_type records the message but not a state', () => {
  const { tracker, changes } = makeTracker();
  tracker.apply(hook('UserPromptSubmit'));
  const before = changes.length;
  tracker.apply(hook('Notification', { notification_type: 'something_new_in_2027', message: 'hi' }));
  assert.equal(tracker.get('s1').state, 'running');
  assert.equal(tracker.get('s1').message, 'hi');
  assert.equal(changes.length, before);
});

test('an unknown hook event is absorbed without changing state', () => {
  const { tracker } = makeTracker();
  tracker.apply(hook('UserPromptSubmit'));
  tracker.apply(hook('SomeFutureHook'));
  assert.equal(tracker.get('s1').state, 'running');
  assert.equal(tracker.get('s1').hooksSeen, true);
});

// The reported bug: a session resumed at startup, never used, sat in the
// board's IN PROGRESS column indefinitely. Hooks are turn-scoped and
// SessionStart is never delivered, so nothing existed to correct it.
test('a seeded session is idle and reports so', () => {
  const { tracker, changes } = makeTracker();
  tracker.seed('s1');
  assert.equal(tracker.get('s1').state, 'idle');
  assert.equal(changes.at(-1).state, 'idle');
});

test('seeding clears a stale busy left over from a previous life', () => {
  const { tracker } = makeTracker();
  tracker.applyOsc('s1', true);
  assert.equal(tracker.get('s1').state, 'running');
  tracker.seed('s1');
  assert.equal(tracker.get('s1').state, 'idle');
});

test('a seeded session still takes hooks normally', () => {
  const { tracker } = makeTracker();
  tracker.seed('s1');
  tracker.apply(hook('UserPromptSubmit'));
  assert.equal(tracker.get('s1').state, 'running');
  tracker.apply(hook('Stop'));
  assert.equal(tracker.get('s1').state, 'idle');
});

test('OSC drives the state only until the first hook arrives', () => {
  const { tracker } = makeTracker();
  tracker.applyOsc('s1', true);
  assert.equal(tracker.get('s1').state, 'running');

  tracker.apply(hook('Stop'));
  assert.equal(tracker.get('s1').state, 'idle');

  // A stale spinner byte after the turn ended is exactly what used to latch.
  assert.equal(tracker.applyOsc('s1', true), false);
  assert.equal(tracker.get('s1').state, 'idle');
});

test('removing a session emits exited and drops it', () => {
  const { tracker, changes } = makeTracker();
  tracker.apply(hook('UserPromptSubmit'));
  tracker.remove('s1');
  assert.equal(tracker.get('s1'), null);
  assert.equal(changes.at(-1).state, 'exited');
});

test('a hook arriving after exit cannot resurrect the session', () => {
  const { tracker } = makeTracker();
  tracker.apply(hook('SessionEnd'));
  assert.equal(tracker.get('s1').state, 'exited');
  tracker.apply(hook('UserPromptSubmit'));
  assert.equal(tracker.get('s1').state, 'exited');
});

test('rekey moves a session to its post-fork id', () => {
  const { tracker } = makeTracker();
  tracker.apply(hook('UserPromptSubmit'));
  tracker.rekey('s1', 's2');
  assert.equal(tracker.get('s1'), null);
  assert.equal(tracker.get('s2').state, 'running');
  tracker.apply({ session_id: 's2', hook_event_name: 'Stop' });
  assert.equal(tracker.get('s2').state, 'idle');
});

test('sessions are tracked independently', () => {
  const { tracker } = makeTracker();
  tracker.apply({ session_id: 'a', hook_event_name: 'UserPromptSubmit' });
  tracker.apply({ session_id: 'b', hook_event_name: 'PermissionRequest' });
  assert.equal(tracker.get('a').state, 'running');
  assert.equal(tracker.get('b').state, 'requires_action');
  assert.equal(tracker.all().length, 2);
});

test('malformed payloads are ignored', () => {
  const { tracker } = makeTracker();
  assert.equal(tracker.apply(null), false);
  assert.equal(tracker.apply({}), false);
  assert.equal(tracker.apply({ session_id: 's1' }), false);
  assert.equal(tracker.apply({ hook_event_name: 'Stop' }), false);
  assert.equal(tracker.all().length, 0);
});

test('the settings blob subscribes every event to the authenticated endpoint', () => {
  const settings = buildHookSettings({ url: 'http://127.0.0.1:1234/hook', token: 'tok' });
  assert.deepEqual(Object.keys(settings.hooks).sort(), [...HOOK_EVENTS].sort());
  const entry = settings.hooks.Stop[0].hooks[0];
  assert.equal(entry.type, 'http');
  assert.equal(entry.url, 'http://127.0.0.1:1234/hook');
  assert.equal(entry.headers['x-switchboard-hook-token'], 'tok');
  assert.ok(entry.timeout > 0 && entry.timeout <= 10, 'timeout is short enough that a dead app does not stall a turn');
  // Round-trips as JSON — it is written to a file and read back by the CLI.
  assert.deepEqual(JSON.parse(JSON.stringify(settings)), settings);
});
