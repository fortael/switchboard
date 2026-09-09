import { computed } from 'vue';
import { store } from './store.js';

const STANDARD_WINDOW = 200_000;
const LONG_WINDOW = 1_000_000;

// Preferred source: the session's own `cost-state` names its models with a
// `[1m]` suffix when the long context is in play, which read-session-file.js
// turns into contextLimit. Sessions indexed before that, or too short to have
// written a cost-state, fall back to the app-wide guess below.
export const inferredWindowLimit = computed(() => {
  for (const project of store.projects) {
    for (const session of project.sessions || []) {
      if (session.contextLimit) return session.contextLimit;
      if ((session.contextTokens || 0) > STANDARD_WINDOW) return LONG_WINDOW;
    }
  }
  return STANDARD_WINDOW;
});

export function contextLimitFor(session) {
  return session?.contextLimit || inferredWindowLimit.value;
}

// null when the session has no usage recorded yet — the ring is hidden rather
// than drawn empty, which would read as "0% used" instead of "unknown".
export function contextPercent(tokens, session) {
  const n = Number(tokens) || 0;
  if (n <= 0) return null;
  return Math.min(100, Math.round((n / contextLimitFor(session)) * 100));
}

export function formatContextLabel(tokens, session) {
  const pct = contextPercent(tokens, session);
  if (pct === null) return '';
  const k = Math.round(Number(tokens) / 1000);
  return `Context ${pct}% — ${k}k of ${Math.round(contextLimitFor(session) / 1000)}k tokens`;
}
