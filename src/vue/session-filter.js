// The single place that decides whether a session is visible right now.
//
// The sidebar list and the board are two views of the same set. When each of
// them kept its own copy of these rules they drifted immediately — the board
// showed only sessions with a live PTY while the list showed everything, so the
// same project read as "two tasks" on the left and "nothing" on the right.
//
// Callers pass the flags explicitly rather than reading the store here, because
// ProjectGroup receives them as props from its parent.

function sameDay(iso, now = new Date()) {
  if (!iso) return false;
  const d = new Date(iso);
  return d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
}

export function filterSessions(sessions, {
  showArchived = false,
  showStarredOnly = false,
  showRunningOnly = false,
  showTodayOnly = false,
  searchMatchIds = null,
  activePtyIds = null,
} = {}) {
  let out = sessions || [];
  // A search result is already an explicit choice; archived hits stay in it.
  if (!showArchived && !searchMatchIds) out = out.filter(s => !s.archived);
  if (showStarredOnly) out = out.filter(s => s.starred);
  if (showRunningOnly && activePtyIds) out = out.filter(s => activePtyIds.has(s.sessionId));
  if (showTodayOnly) {
    const now = new Date();
    out = out.filter(s => sameDay(s.modified, now));
  }
  if (searchMatchIds) out = out.filter(s => searchMatchIds.has(s.sessionId));
  return out;
}
