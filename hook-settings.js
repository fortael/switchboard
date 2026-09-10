// hook-settings.js — builds the settings blob handed to `claude --settings`.
//
// `--settings <file-or-json>` loads *additional* settings for one run: the
// user's own ~/.claude/settings.json and the project's .claude/settings.json
// are still read and still win where they overlap. So Switchboard can subscribe
// to lifecycle events for a session it launched without writing anything into
// files the user owns, and without a cleanup step that has to survive a crash.

// Events worth a round trip. Every entry here costs the CLI one local HTTP
// request at that point in its lifecycle, so this list is deliberately not the
// full HookEvent union:
//
//   * PostToolBatch is redundant with PostToolUse for status purposes.
//   * MessageDisplay and FileChanged fire far too often to pay for.
//   * The model-switch, worktree and config events do not move the state.
//
// PreToolUse/PostToolUse do fire per tool call, which is the price of knowing
// which tool a session is sitting in rather than just that it is busy.
const HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionDenied',
  'Notification',
  'Stop',
  'StopFailure',
  'PreCompact',
  'PostCompact',
  'SubagentStart',
  'SubagentStop',
  'Elicitation',
  'ElicitationResult',
];

// Seconds. The endpoint answers before it parses anything, so a healthy round
// trip is sub-millisecond; this bound only matters when Switchboard has died
// with sessions still running. Short enough that a dead app costs a session a
// couple of seconds per turn rather than the 600s default.
const HOOK_TIMEOUT_SECONDS = 5;

/**
 * @param {object} opts
 * @param {string} opts.url    endpoint from hookServer.urlFor(isWsl)
 * @param {string} opts.token  shared secret for the x-switchboard-hook-token header
 * @param {string[]} [opts.events]
 * @returns {object} a settings object suitable for JSON.stringify
 */
function buildHookSettings({ url, token, events = HOOK_EVENTS }) {
  const hooks = {};
  for (const event of events) {
    hooks[event] = [
      {
        hooks: [
          {
            type: 'http',
            url,
            timeout: HOOK_TIMEOUT_SECONDS,
            // Written literally rather than through allowedEnvVars: the token
            // never needs to reach the session's environment, where a `claude`
            // subprocess or a tool call could read it back out.
            headers: { 'x-switchboard-hook-token': token },
          },
        ],
      },
    ];
  }
  return { hooks };
}

module.exports = { buildHookSettings, HOOK_EVENTS, HOOK_TIMEOUT_SECONDS };
