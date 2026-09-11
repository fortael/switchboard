// DOM refs — App.vue (in vue-bundle.js) has mounted and rendered these before this script runs
const terminalsEl = document.getElementById('terminals');
const sidebarContent = document.getElementById('sidebar-content'); // used by grid-view.js for DOM session order
const placeholder = document.getElementById('placeholder');
const terminalHeader = document.getElementById('terminal-header');
const terminalHeaderName = document.getElementById('terminal-header-name');
const terminalHeaderId = document.getElementById('terminal-header-id');
const terminalHeaderStatus = document.getElementById('terminal-header-status');
const terminalHeaderShell = document.getElementById('terminal-header-shell');
const terminalStopBtn = document.getElementById('terminal-stop-btn');
const terminalArea = document.getElementById('terminal-area');
const projectViewer = document.getElementById('project-viewer');
const gridViewer = document.getElementById('grid-viewer');
let gridViewActive = localStorage.getItem('gridViewActive') === '1';

// Map<sessionId, { terminal, element, fitAddon, session, closed }>
const openSessions = new Map();
window._openSessions = openSessions;
let activeSessionId = sessionStorage.getItem('activeSessionId') || null;
function setActiveSession(id) {
  // Leaving a session you have already read retires its card. Only a read one:
  // a session in responseReady has never been looked at and keeps its card
  // until it is.
  //
  // "Read and left" is the honest reading of closed here. You can only look at
  // one session at a time, and a session you are not looking at has no close
  // button to press — so switching away is the only gesture that means done
  // with it. Requiring the explicit close left cards stranded in DONE with no
  // way to clear them.
  for (const sid of readPendingSessions) {
    if (sid !== id) setReadPending(sid, false);
  }
  activeSessionId = id;
  if (id) sessionStorage.setItem('activeSessionId', id);
  else sessionStorage.removeItem('activeSessionId');
  if (typeof switchPanel === 'function') switchPanel(id);
  window.vueSidebar?.setActiveSession(id);
}
let showArchived = false;
let showStarredOnly = false;
let showRunningOnly = false;
let showTodayOnly = false;
let cachedProjects = [];
let cachedAllProjects = [];
let activePtyIds = new Set();
let sortedOrder = []; // kept for grid-view.js project-heading ordering; no longer updated by sidebar
let activeTab = 'sessions';
let visibleSessionCount = 10;
let sessionMaxAgeDays = 3;
const pendingSessions = new Map(); // sessionId → { session, projectPath, folder }

window._setVisibleSessionCount = (v) => { visibleSessionCount = v; };
window._setSessionMaxAge = (v) => { sessionMaxAgeDays = v; };
window._applyTerminalTheme = (themeName) => {
  currentThemeName = themeName;
  TERMINAL_THEME = getTerminalTheme();
  for (const [, entry] of openSessions) {
    entry.terminal.options.theme = TERMINAL_THEME;
    entry.element.style.backgroundColor = TERMINAL_THEME.background;
  }
  // The side panel's scratch shell is not in openSessions — see terminal-manager.js.
  window._applyPanelTerminalTheme?.(TERMINAL_THEME);
};
let searchMatchIds = null; // null = no search active; Set<string> = matched session IDs
let searchMatchProjectPaths = null; // Set<string> of project paths matched by name

// --- Activity tracking ---
//
// Activity is determined by two signals:
//   1. OSC 0 braille spinner (authoritative: Claude CLI sets title to spinner chars)
//   2. Noise-filtered terminal output (fallback: non-noise, non-TUI-repaint data)
//
// Both feed into setActivity(sessionId, active):
//   active=true  → cli-busy (spinner dot)
//   active=false → response-ready if not focused (terminal state until user clicks)
// OSC 0 idle signal is the authoritative source for marking sessions as idle.
//
const attentionSessions = new Set(); // sessions needing user action (OSC 9)
// The subset of the above that is *blocked*: a permission prompt, a question, an
// MCP elicitation. The difference matters because attention has two sources
// with opposite lifetimes. A notification is dismissed by being read, so
// opening the session clears it. A session parked on a dialog is still parked
// after you look at it and after you close the view — nothing but an answer
// releases it, and the status tracker in the main process is the only thing
// that knows one arrived.
const blockedSessions = new Set();
const responseReadySessions = new Set(); // Claude finished, user hasn't looked (terminal state)
// Claude finished and the user has already seen it — either because the
// session was open when the turn landed, or because they opened it afterwards.
// The sidebar clears its blue dot on open, which is what people expect from an
// unread marker, but the board's DONE column means "finished and not yet put
// away". So the id is parked here rather than dropped, and leaving the session
// or closing its view retires it. Board state = responseReady || readPending.
const readPendingSessions = new Set();
const sessionBusyState = new Map(); // sessionId → boolean (currently active)
const lastActivityTime = new Map(); // sessionId → Date of last terminal output
window.lastActivityTime = lastActivityTime; // exposed for Vue components

// Noise patterns — these don't count as activity
const activityNoiseRe = /file-history-snapshot|^\s*$/;

// A finished turn is the moment the .jsonl gets its last write, so it is also
// the moment the cached message count and context usage stop matching what the
// session is really at. The sidebar's timeago comes from terminal output and
// keeps ticking regardless, which is what made a stale row look current.
// Debounced: several sessions can settle at once.
let counterRefreshTimer = null;
function scheduleCounterRefresh() {
  clearTimeout(counterRefreshTimer);
  counterRefreshTimer = setTimeout(() => {
    counterRefreshTimer = null;
    loadProjects();
  }, 1500);
}

// SDK-backed sessions render from `sdk-message`, not from terminal bytes.
// The set drives which component App.vue mounts over the session area.
function markSessionMode(sessionId, mode) {
  if (mode === 'sdk') window.vueStore?.sdkSessionIds?.add(sessionId);
  else window.vueStore?.sdkSessionIds?.delete(sessionId);
}

// Central activity dispatcher
function setActivity(sessionId, active) {
  if (responseReadySessions.has(sessionId)) return;

  const wasActive = sessionBusyState.get(sessionId) || false;
  sessionBusyState.set(sessionId, active);
  if (wasActive && !active) scheduleCounterRefresh();

  if (wasActive && !active) {
    // A finished turn always owes the board a DONE card, whether or not you
    // happened to be looking when it landed. Which set it goes in decides only
    // the sidebar's unread dot: a session you are watching is read on arrival,
    // one you are not is not.
    if (sessionId === activeSessionId) {
      setReadPending(sessionId, true);
    } else {
      responseReadySessions.add(sessionId);
      window.vueSidebar?.setResponseReady(sessionId);
    }
  }

  window.vueSidebar?.setBusy(sessionId, active);
}

// Terminal output activity — updates lastActivityTime only, busy state driven by backend
function trackActivity(sessionId, data) {
  if (activityNoiseRe.test(data)) return;
  lastActivityTime.set(sessionId, new Date());
}

// The board reads this set straight off the store, so every write has to be
// mirrored there — app.js owns the truth, Vue only renders it.
function setReadPending(sessionId, pending) {
  if (pending) {
    readPendingSessions.add(sessionId);
    window.vueStore?.readPendingSessions?.add(sessionId);
  } else {
    readPendingSessions.delete(sessionId);
    window.vueStore?.readPendingSessions?.delete(sessionId);
  }
}

function clearUnread(sessionId) {
  const wasUnread = responseReadySessions.delete(sessionId);
  // Opening a finished session is not the same as leaving it: hold the card in
  // DONE until setActiveSession() moves the focus somewhere else.
  if (wasUnread && sessionId === activeSessionId) setReadPending(sessionId, true);
  window.vueSidebar?.clearResponseReady(sessionId);
}

function clearNotifications(sessionId) {
  clearUnread(sessionId);
  // Looking at a blocked session is not answering it. Opening one used to clear
  // its attention here, which turned it green and dropped the card into IDLE
  // while Claude was still sitting on the dialog.
  if (blockedSessions.has(sessionId)) return;
  attentionSessions.delete(sessionId);
  window.vueSidebar?.clearNotifications(sessionId);
}

/** Only the status tracker moves this — see applySessionStatus. */
function setBlocked(sessionId, blocked) {
  if (blocked) blockedSessions.add(sessionId);
  else blockedSessions.delete(sessionId);
}
// Terminal themes, utils (cleanDisplayName, formatDate, escapeHtml, shellEscape)
// are defined in terminal-themes.js and utils.js (loaded before app.js).

// Terminal key bindings, write buffering, isAtBottom, safeFit, fitAndScroll → terminal-manager.js

// --- IPC listeners from main process ---

window.api.onTerminalData((sessionId, data) => {
  const entry = openSessions.get(sessionId);
  if (entry) {
    let buf = terminalWriteBuffers.get(sessionId);
    if (!buf) {
      buf = { chunks: [], syncDepth: 0, rafId: 0, timerId: 0 };
      terminalWriteBuffers.set(sessionId, buf);
    }
    buf.chunks.push(data);

    // Track sync start/end nesting
    if (data.includes(ESC_SYNC_START)) buf.syncDepth++;
    if (data.includes(ESC_SYNC_END)) buf.syncDepth = Math.max(0, buf.syncDepth - 1);

    if (buf.syncDepth > 0) {
      // Inside a synchronized update — keep buffering.
      // Set a safety timeout so we never hold data forever.
      cancelAnimationFrame(buf.rafId);
      if (!buf.timerId) {
        buf.timerId = setTimeout(() => flushTerminalBuffer(sessionId), SYNC_BUFFER_TIMEOUT);
      }
    } else {
      // Not in a sync block (or sync just ended) — flush on next frame.
      clearTimeout(buf.timerId);
      buf.timerId = 0;
      scheduleFlush(sessionId, buf);
    }
  }
  // Update last activity time (noise-filtered)
  trackActivity(sessionId, data);
});

window.api.onSessionDetected((tempId, realId) => {
  const entry = openSessions.get(tempId);
  if (!entry) return;

  entry.session.sessionId = realId;
  if (activeSessionId === tempId) setActiveSession(realId);

  // Re-key in openSessions
  openSessions.delete(tempId);
  openSessions.set(realId, entry);

  terminalHeaderId.textContent = realId;
  terminalHeaderName.textContent = 'New session';

  // Refresh sidebar to show the new session, then select it
  loadProjects().then(() => {
    const item = document.querySelector(`[data-session-id="${realId}"]`);
    if (item) {
      document.querySelectorAll('.session-item.active').forEach(el => el.classList.remove('active'));
      item.classList.add('active');
    }
  });
  pollActiveSessions();
});

window.api.onSessionForked((oldId, newId) => {
  const entry = openSessions.get(oldId);
  if (!entry) return;

  entry.session.sessionId = newId;
  if (activeSessionId === oldId) setActiveSession(newId);

  openSessions.delete(oldId);
  openSessions.set(newId, entry);

  // Re-key file panel state for the new session ID
  if (typeof rekeyFilePanelState === 'function') rekeyFilePanelState(oldId, newId);

  // Re-key pending session to newId so sidebar item persists until DB has real data
  const pendingEntry = pendingSessions.get(oldId);
  pendingSessions.delete(oldId);
  if (pendingEntry) {
    pendingEntry.sessionId = newId;
    pendingSessions.set(newId, pendingEntry);
  }
  sessionMap.delete(oldId);
  sessionMap.set(newId, entry.session);

  terminalHeaderId.textContent = newId;

  loadProjects().then(() => {
    const item = document.querySelector(`[data-session-id="${newId}"]`);
    if (item) {
      document.querySelectorAll('.session-item.active').forEach(el => el.classList.remove('active'));
      item.classList.add('active');
      const summary = item.querySelector('.session-summary');
      if (summary) terminalHeaderName.textContent = summary.textContent;
    }
  });
  pollActiveSessions();
});

window.api.onProcessExited((sessionId, exitCode) => {
  const entry = openSessions.get(sessionId);
  const session = sessionMap.get(sessionId);
  if (entry) {
    entry.closed = true;
  }

  // Clean up terminal UI on exit (uses destroySession to handle grid cards too)
  if (entry) {
    destroySession(sessionId);
  }
  if (gridViewActive) {
    if (window.vueStore) window.vueStore.gridViewerCount = gridCards.size + ' session' + (gridCards.size !== 1 ? 's' : '');
  } else if (activeSessionId === sessionId) {
    setActiveSession(null);
    terminalHeader.style.display = 'none';
    window.vueSidebar?.clearHeader();
    placeholder.style.display = '';
  }

  // Plain terminal sessions: remove from sidebar entirely (ephemeral)
  if (session?.type === 'terminal') {
    pendingSessions.delete(sessionId);
    for (const projList of [cachedProjects, cachedAllProjects]) {
      for (const proj of projList) {
        proj.sessions = proj.sessions.filter(s => s.sessionId !== sessionId);
      }
    }
    sessionMap.delete(sessionId);
    refreshSidebar();
    pollActiveSessions();
    return;
  }

  // Clean up no-op pending sessions (never created a .jsonl)
  if (pendingSessions.has(sessionId)) {
    pendingSessions.delete(sessionId);
    // Remove from cached project data
    for (const projList of [cachedProjects, cachedAllProjects]) {
      for (const proj of projList) {
        proj.sessions = proj.sessions.filter(s => s.sessionId !== sessionId);
      }
    }
    sessionMap.delete(sessionId);
    refreshSidebar();
  }

  pollActiveSessions();
});

// --- Terminal notifications (iTerm2 OSC 9 — "needs attention") ---
window.api.onTerminalNotification((sessionId, message) => {
  // Only mark as needing attention for "attention" messages, not "waiting for input"
  // Matches all four CLI notification types:
  // 1. "Claude Code needs your attention"         → attention
  // 2. "Claude Code needs your approval for the plan" → approval, needs your
  // 3. "Claude needs your permission to use {tool}"   → permission, needs your
  // 4. "Claude Code wants to enter plan mode"         → wants to enter
  if (/attention|approval|permission|needs your|wants to enter/i.test(message) && sessionId !== activeSessionId) {
    attentionSessions.add(sessionId);
    window.vueSidebar?.addAttention(sessionId);
  } else if (/waiting for your input/i.test(message)) {
    // "Claude is waiting for your input" — delayed idle notification, mark response-ready
    setActivity(sessionId, false);
  }

  // Show in header if active
  if (sessionId === activeSessionId && terminalHeaderPtyTitle) {
    terminalHeaderPtyTitle.textContent = message;
    terminalHeaderPtyTitle.style.display = '';
  }
});

// --- Session status (Claude Code lifecycle hooks; OSC fallback) ---
// The main process owns the state machine — see session-status.js. Three states
// arrive here; this maps them onto the sets the sidebar and board already read.
function applySessionStatus(sessionId, status) {
  if (!status) return;
  const state = status.state;

  if (state === 'exited') {
    // Belt and braces with onProcessExited: whichever lands first wins, and the
    // sets must not keep a spinner for a session that is gone.
    sessionBusyState.delete(sessionId);
    window.vueStore?.sessionBusyState?.delete(sessionId);
    setBlocked(sessionId, false);   // a session that is gone is not waiting
    clearNotifications(sessionId);
    setReadPending(sessionId, false);
    return;
  }

  if (state === 'requires_action') {
    // The session is blocked on the user — a permission prompt, a set of
    // questions, an MCP elicitation. Distinct from "finished a turn", which is
    // what setActivity(false) records.
    //
    // Recorded for the open session too. It used to be skipped there, on the
    // grounds that you can already see the dialog — but the board reads this
    // same set to place a card, and a session waiting on an answer would drop
    // out of WAITING INPUT into IDLE for exactly as long as you had it open.
    // The card has to say what the session is doing, not what you are.
    sessionBusyState.delete(sessionId);
    window.vueSidebar?.setBusy(sessionId, false);
    setBlocked(sessionId, true);
    attentionSessions.add(sessionId);
    window.vueSidebar?.addAttention(sessionId);
    return;
  }

  // 'running' | 'idle' — a real turn boundary, so whatever the session was
  // blocked on is resolved.
  setBlocked(sessionId, false);
  if (attentionSessions.has(sessionId)) {
    attentionSessions.delete(sessionId);
    window.vueSidebar?.clearNotifications(sessionId);
  }
  // setActivity ignores everything while a session sits in responseReady, which
  // is normally fine because opening a session clears it. A session that starts
  // a new turn without ever being opened — an external launcher driving it —
  // would otherwise never show as running again.
  if (state === 'running') clearUnread(sessionId);
  setActivity(sessionId, state === 'running');
}

window.api.onSessionStatus(applySessionStatus);

// The traffic lights vanish in full screen; css/shell.css drops the gap it
// keeps for them when this flips.
window.api.onWindowFullscreen((isFullscreen) => {
  document.documentElement.dataset.fullscreen = isFullscreen ? '1' : '0';
});

// A renderer reload loses every set above while the sessions keep running, so
// ask the main process for the states it is still holding.
window.api.getSessionStatuses().then(list => {
  for (const status of list || []) applySessionStatus(status.sessionId, status);
}).catch(() => {});

// --- Single entry point for all sidebar renders ---
// resort=true: re-sort items by priority+time (use for user-initiated actions)
// resort=false (default): preserve existing DOM order, new items go to top
function refreshSidebar({ resort = false } = {}) {
  // When searching, always use all projects (search ignores archive filter)
  const projects = (searchMatchIds !== null)
    ? cachedAllProjects
    : (showArchived ? cachedAllProjects : cachedProjects);

  // Vue sidebar handles its own filtering; just pass the full project list
  window.vueSidebar?.setProjects(projects);
  // The project page is not downstream of the sidebar's filter tab — it shows
  // a project's archived sessions whether or not the sidebar is.
  window.vueSidebar?.setAllProjects(cachedAllProjects);
  window.vueSidebar?.setSearch(searchMatchIds, searchMatchProjectPaths);
  window.vueSidebar?.setFilters({ showStarredOnly, showRunningOnly, showTodayOnly, showArchived });
}

// --- Search & filter handlers moved to App.vue ---
// App.vue calls window.__sb.search(query, titlesOnly) and window.__sb.clearSearch()
// App.vue calls window.__sb.onFilterChange(filters) for filter toggles

function clearSearch() {
  const activeTab = window.vueStore?.activeTab || 'sessions';
  searchMatchIds = null;
  searchMatchProjectPaths = null;
  window.vueSidebar?.setSearch(null, null);
  if (activeTab === 'sessions') {
    refreshSidebar({ resort: true });
  } else if (activeTab === 'plans') {
    renderPlans();
  } else if (activeTab === 'projects') {
    projectsSearchQuery = '';
    window.vueProjects?.setSearch('');
  }
}

// --- Stop session helper (exposed globally for Vue components) ---
let _stoppingSession = false;
async function confirmAndStopSession(sessionId) {
  if (_stoppingSession) return;
  _stoppingSession = true;
  try {
    if (!confirm('Stop this session?')) return;
    await window.api.stopSession(sessionId);
    activePtyIds.delete(sessionId);

    const session = sessionMap.get(sessionId);
    if (session?.type === 'terminal') {
      // Plain terminals are ephemeral — clean up immediately without waiting for process-exited
      destroySession(sessionId);
      pendingSessions.delete(sessionId);
      for (const projList of [cachedProjects, cachedAllProjects]) {
        for (const proj of projList) {
          proj.sessions = proj.sessions.filter(s => s.sessionId !== sessionId);
        }
      }
      sessionMap.delete(sessionId);
      if (activeSessionId === sessionId) {
        setActiveSession(null);
        placeholder.style.display = '';
      }
      refreshSidebar();
      pollActiveSessions();
      return;
    }

    if (!gridViewActive && activeSessionId === sessionId) {
      setActiveSession(null);
      terminalHeader.style.display = 'none';
      placeholder.style.display = '';
    }
    refreshSidebar();
  } finally {
    _stoppingSession = false;
  }
}

window.confirmAndStopSession = confirmAndStopSession;

// --- Terminal header controls ---
terminalStopBtn.addEventListener('click', () => {
  if (activeSessionId) confirmAndStopSession(activeSessionId);
});


// --- Poll for active PTY sessions ---
async function pollActiveSessions() {
  try {
    const ids = await window.api.getActiveSessions();
    activePtyIds = new Set(ids);
    window.vueSidebar?.setActivePtyIds(ids);
    updateRunningIndicators();
    updateTerminalHeader();
  } catch {}
}

function updateRunningIndicators() {
  document.querySelectorAll('.session-item').forEach(item => {
    const id = item.dataset.sessionId;
    const running = activePtyIds.has(id);
    item.classList.toggle('has-running-pty', running);
    if (!running) {
      item.classList.remove('needs-attention', 'response-ready', 'cli-busy');
      setBlocked(id, false);   // no process, nothing left to answer
      attentionSessions.delete(id);
      responseReadySessions.delete(id);
      setReadPending(id, false);
      sessionBusyState.delete(id);
      // The board and the header read the store, not these local sets. Clearing
      // only the local copies left the Vue side showing "Working…" for a
      // session that had already exited.
      window.vueStore?.sessionBusyState?.delete(id);
      window.vueSidebar?.clearNotifications(id);
    }
    const dot = item.querySelector('.session-status-dot');
    if (dot) dot.classList.toggle('running', running);
  });
  // Update slug group running dots
  document.querySelectorAll('.slug-group').forEach(group => {
    const hasRunning = group.querySelector('.session-item.has-running-pty') !== null;
    const dot = group.querySelector('.slug-group-dot');
    if (dot) dot.classList.toggle('running', hasRunning);
  });
  // Update grid cards via Vue
  for (const [sid] of gridCards) {
    const running = activePtyIds.has(sid);
    const busy = sessionBusyState.get(sid) || false;
    const time = formatDate(lastActivityTime.get(sid) || new Date(sessionMap.get(sid)?.modified));
    window.vueGrid?.updateCard(sid, running, busy, time);
  }
}

function updateTerminalHeader() {
  if (!activeSessionId) return;
  const running = activePtyIds.has(activeSessionId);
  terminalHeaderStatus.className = running ? 'running' : 'stopped';
  terminalHeaderStatus.textContent = running ? 'Running' : 'Stopped';
  terminalStopBtn.style.display = running ? '' : 'none';
  updatePtyTitle();
}

const terminalHeaderPtyTitle = document.getElementById('terminal-header-pty-title');

function updatePtyTitle() {
  if (!activeSessionId) return;
  const entry = openSessions.get(activeSessionId);
  const title = entry?.ptyTitle || '';
  window.vueSidebar?.setHeaderPtyTitle(title || null);
  // Legacy DOM fallback
  if (terminalHeaderPtyTitle) {
    terminalHeaderPtyTitle.textContent = title;
    terminalHeaderPtyTitle.style.display = title ? '' : 'none';
  }
}

setInterval(pollActiveSessions, 3000);

// Refresh sidebar timeago labels every 30s so "just now" ticks forward
setInterval(() => {
  for (const [sessionId, time] of lastActivityTime) {
    const item = document.getElementById('si-' + sessionId);
    if (!item) continue;
    // Write into the dedicated text span, never into .session-meta itself:
    // setting textContent on the container wipes its element children, and the
    // context-usage ring SessionItem renders there is one of them.
    const target = item.querySelector('.session-meta-text') || item.querySelector('.session-meta');
    if (!target) continue;
    const session = sessionMap.get(sessionId);
    const msgSuffix = session?.messageCount ? ' \u00b7 ' + session.messageCount + ' msgs' : '';
    target.textContent = formatDate(time) + msgSuffix;
  }
}, 30000);

// Shared session map so all caches reference the same objects
const sessionMap = new Map();

function dedup(projects) {
  for (const p of projects) {
    for (let i = 0; i < p.sessions.length; i++) {
      const s = p.sessions[i];
      if (sessionMap.has(s.sessionId)) {
        Object.assign(sessionMap.get(s.sessionId), s);
        p.sessions[i] = sessionMap.get(s.sessionId);
      } else {
        sessionMap.set(s.sessionId, s);
      }
    }
  }
}

async function loadProjects({ resort = false } = {}) {
  const wasEmpty = cachedProjects.length === 0;
  if (wasEmpty && window.vueStore) window.vueStore.loadingStatus = 'Loading\u2026';
  const [defaultProjects, allProjects] = await Promise.all([
    window.api.getProjects(false),
    window.api.getProjects(true),
  ]);
  cachedProjects = defaultProjects;
  cachedAllProjects = allProjects;
  if (window.vueStore) window.vueStore.loadingStatus = '';
  dedup(cachedProjects);
  dedup(cachedAllProjects);

  // Reconcile pending sessions: remove ones that now have real data
  let hasReinjected = false;
  for (const [sid, pending] of [...pendingSessions]) {
    const realExists = allProjects.some(p => p.sessions.some(s => s.sessionId === sid));
    if (realExists) {
      pendingSessions.delete(sid);
    } else {
      hasReinjected = true;
      // Still pending — re-inject into cached data
      for (const projList of [cachedProjects, cachedAllProjects]) {
        let proj = projList.find(p => p.projectPath === pending.projectPath);
        if (!proj) {
          // Project not in list (no other sessions) — create a synthetic entry
          proj = { folder: pending.folder, projectPath: pending.projectPath, sessions: [] };
          projList.unshift(proj);
        }
        if (!proj.sessions.some(s => s.sessionId === sid)) {
          proj.sessions.unshift(pending.session);
        }
      }
    }
  }

  // Track active plain terminals in pendingSessions/sessionMap (data now comes from backend)
  try {
    const activeTerminals = await window.api.getActiveTerminals();
    for (const { sessionId, projectPath } of activeTerminals) {
      if (pendingSessions.has(sessionId)) continue; // already tracked
      const folder = encodeProjectPath(projectPath);
      // Find the session object already injected by the backend
      let session;
      for (const proj of cachedAllProjects) {
        session = proj.sessions.find(s => s.sessionId === sessionId);
        if (session) break;
      }
      if (!session) continue;
      pendingSessions.set(sessionId, { session, projectPath, folder });
      sessionMap.set(sessionId, session);
    }
  } catch {}

  await pollActiveSessions();
  refreshSidebar({ resort });
  renderDefaultStatus();
}




async function launchNewSession(project, sessionOptions) {
  const sessionId = crypto.randomUUID();
  const projectPath = project.projectPath;
  const session = {
    sessionId,
    summary: 'New session',
    firstPrompt: '',
    projectPath,
    name: null,
    starred: 0,
    archived: 0,
    messageCount: 0,
    modified: new Date().toISOString(),
    created: new Date().toISOString(),
    accountId: activeAccountId,
  };

  // Track as pending (no .jsonl yet)
  const folder = encodeProjectPath(projectPath);
  pendingSessions.set(sessionId, { session, projectPath, folder });

  // Inject into cached project data so it appears in sidebar immediately
  sessionMap.set(sessionId, session);
  for (const projList of [cachedProjects, cachedAllProjects]) {
    let proj = projList.find(p => p.projectPath === projectPath);
    if (!proj) {
      proj = { folder, projectPath, sessions: [] };
      projList.unshift(proj);
    }
    proj.sessions.unshift(session);
  }
  refreshSidebar();

  // Switch to sessions tab and highlight the new session
  if (window.vueStore?.activeTab !== 'sessions') {
    window.vueApp?.setTab('sessions');
  }
  setActiveSession(sessionId);

  // Expand the project group in sidebar if it's collapsed
  const _folderId = 'project-' + projectPath.replace(/[^a-zA-Z0-9_-]/g, '_');
  const _groupHeader = document.getElementById('ph-' + _folderId);
  if (_groupHeader?.classList.contains('collapsed')) _groupHeader.click();

  const entry = createTerminalEntry(session);

  // Open terminal in main process with session options
  const result = await window.api.openTerminal(sessionId, projectPath, true, sessionOptions || null);
  if (!result.ok) {
    entry.terminal.write(`\r\nError: ${result.error}\r\n`);
    entry.closed = true;
    return;
  }
  if (typeof setSessionMcpActive === 'function') setSessionMcpActive(sessionId, !!result.mcpActive);
  // A session's transport decides which view renders it — terminal bytes or
  // structured messages. main.js reports which one it started.
  markSessionMode(sessionId, result.mode);

  showSession(sessionId);
  pollActiveSessions();
}

// Legacy alias
function openNewSession(project) {
  return launchNewSession(project);
}

async function showTerminalHeader(session) {
  // Drive Vue header
  window.vueSidebar?.setHeaderSession(session);

  // Account badge
  if (accounts.length > 1) {
    const acc = getAccountById(session.accountId || 'default');
    window.vueSidebar?.setHeaderAccount(acc.name);
  } else {
    window.vueSidebar?.setHeaderAccount(null);
  }

  // Shell profile (async)
  try {
    const effective = await window.api.getEffectiveSettings(session.projectPath);
    const profileId = effective.shellProfile || 'auto';
    if (profileId !== 'auto') {
      const profiles = await window.api.getShellProfiles();
      const profile = profiles.find(p => p.id === profileId);
      window.vueSidebar?.setHeaderShellProfile(profile ? profile.name : profileId);
    } else {
      window.vueSidebar?.setHeaderShellProfile(null);
    }
  } catch {
    window.vueSidebar?.setHeaderShellProfile(null);
  }

  // Keep legacy DOM header hidden (Vue header renders instead)
  terminalHeader.style.display = 'none';
}

// Terminal lifecycle (createTerminalEntry, destroySession, showSession, setupDragAndDrop) → terminal-manager.js

async function openSession(session, customOptions) {
  const { sessionId, projectPath } = session;

  // If already open, handle closed-session cleanup or just show it
  if (openSessions.has(sessionId)) {
    const entry = openSessions.get(sessionId);
    if (entry.closed) {
      destroySession(sessionId);
      if (session.type === 'terminal') {
        launchTerminalSession({ projectPath: session.projectPath });
        return;
      }
    } else {
      showSession(sessionId);
      return;
    }
  }

  // Create new terminal entry (hidden until showSession)
  const entry = createTerminalEntry(session);

  // Open terminal in main process
  const resumeOptions = customOptions || await resolveDefaultSessionOptions({ projectPath });
  const result = await window.api.openTerminal(sessionId, projectPath, false, resumeOptions);
  if (!result.ok) {
    entry.terminal.write(`\r\nError: ${result.error}\r\n`);
    entry.closed = true;
    return;
  }
  if (typeof setSessionMcpActive === 'function') setSessionMcpActive(sessionId, !!result.mcpActive);
  // A session's transport decides which view renders it — terminal bytes or
  // structured messages. main.js reports which one it started.
  markSessionMode(sessionId, result.mode);

  showSession(sessionId);
  pollActiveSessions();
}

// Handle window resize
window.addEventListener('resize', () => {
  window.fitPanelTerminal?.();
  if (gridViewActive) {
    for (const entry of openSessions.values()) {
      fitAndScroll(entry);
    }
    return;
  }
  if (activeSessionId && openSessions.has(activeSessionId)) {
    const entry = openSessions.get(activeSessionId);
    safeFit(entry);
  }
});

// Tab switching is handled by App.vue (store.activeTab).
// App.vue calls window.__sb.onTabChange(tabName) — defined near bottom of this file.

// Grid view → grid-view.js
// Initialize grid observers now that DOM refs are ready
initGridObservers();


// Stats view (loadStats, buildUsageSection, buildDailyBarChart, buildHeatmap, calculateStreak, buildStatsSummary) → stats-view.js

// Dialogs (resolveDefaultSessionOptions, forkSession, showNewSessionPopover,
// showNewSessionDialog, showResumeSessionDialog, showAddProjectDialog, launchTerminalSession) → dialogs.js


// Sidebar toggle is handled by App.vue (store.sidebarCollapsed).

// --- Sidebar resize ---
{
  const sidebar = document.getElementById('sidebar');
  const handle = document.getElementById('sidebar-resize-handle');
  let dragging = false;

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const width = Math.min(600, Math.max(200, e.clientX));
    sidebar.style.width = width + 'px';
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    // Refit active terminal
    if (!gridViewActive && activeSessionId && openSessions.has(activeSessionId)) {
      const entry = openSessions.get(activeSessionId);
      safeFit(entry);
    }
    // Save sidebar width to settings
    const width = parseInt(sidebar.style.width);
    if (width) {
      window.api.getSetting('global').then(g => {
        const global = g || {};
        global.sidebarWidth = width;
        window.api.setSetting('global', global);
      });
    }
  });
}

// Grid toggle button is rendered by App.vue. Global keyboard shortcuts:
// When a terminal is focused, xterm's customKeyEventHandler fires first and sets
// e._handled to prevent the document listener from double-firing the same action.
document.addEventListener('keydown', (e) => {
  if (e._handled) return;
  // Cmd/Ctrl+Shift+G → toggle grid view
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (e.key === 'g' && mod && e.shiftKey && !e.altKey) {
    e.preventDefault();
    toggleGridView();
    return;
  }
  // Session navigation: Cmd+Shift+[/], Cmd+Arrow
  handleSessionNavKey(e);
});

// Warm up xterm.js renderer so first terminal open is fast
setTimeout(() => {
  const warmEl = document.createElement('div');
  warmEl.style.cssText = 'position:absolute;left:-9999px;width:400px;height:200px;';
  document.body.appendChild(warmEl);
  const warmTerm = new Terminal({ cols: 80, rows: 10 });
  const warmFit = new FitAddon.FitAddon();
  warmTerm.loadAddon(warmFit);
  warmTerm.open(warmEl);
  warmTerm.write(' ');
  requestAnimationFrame(() => {
    warmTerm.dispose();
    warmEl.remove();
  });
}, 100);


// --- Init: restore settings ---
(async () => {
  const global = await window.api.getSetting('global');
  if (global) {
    if (global.sidebarWidth) {
      document.getElementById('sidebar').style.width = global.sidebarWidth + 'px';
    }
    if (global.visibleSessionCount) {
      visibleSessionCount = global.visibleSessionCount;
    }
    if (global.sessionMaxAgeDays) {
      sessionMaxAgeDays = global.sessionMaxAgeDays;
    }
    if (global.terminalTheme && TERMINAL_THEMES[global.terminalTheme]) {
      currentThemeName = global.terminalTheme;
      TERMINAL_THEME = getTerminalTheme();
    }
    if (global.monoFont && window.TERMINAL_FONTS?.[global.monoFont]) {
      window._applyTerminalFont?.(window.TERMINAL_FONTS[global.monoFont].family);
    }
    // Must land before the first terminal is constructed: font size and line
    // height change the character box, so applying them later refits a live
    // terminal and leaves whatever the CLI already painted mis-wrapped until
    // its next redraw.
    window._applyUiMetrics?.(global);
    if (global.uiFont && global.uiFont !== 'default' && window.TERMINAL_FONTS?.[global.uiFont]) {
      document.documentElement.style.setProperty('--font-ui', window.TERMINAL_FONTS[global.uiFont].family);
    }
    if (global.showAvatars === false) {
      document.body.classList.add('hide-avatars');
    }
    window._setReduceMotion?.(global.reduceMotion === true);
  }
})();

window._setShowAvatars = (val) => {
  document.body.classList.toggle('hide-avatars', !val);
};

// The board reads this off the store when deciding whether to fly a card.
window._setReduceMotion = (val) => {
  if (window.vueStore) window.vueStore.reduceMotion = val === true;
};

window._applyUiFont = (fontKey) => {
  if (fontKey === 'default' || !window.TERMINAL_FONTS?.[fontKey]) {
    document.documentElement.style.removeProperty('--font-ui');
  } else {
    document.documentElement.style.setProperty('--font-ui', window.TERMINAL_FONTS[fontKey].family);
  }
};

// Called by SettingsPanelApp (and window.closeSettingsViewer) after settings closes.
// Restores whichever main-area panel was active before settings opened.
window._restoreAfterSettings = () => {
  if (gridViewActive) {
    terminalArea.style.display = '';
  } else if (activeSessionId && openSessions.has(activeSessionId)) {
    terminalArea.style.display = '';
  } else {
    placeholder.style.display = '';
  }
};

// ── UI state persistence ──────────────────────────────────────────
let _uiState = {};

async function saveUiState(patch) {
  Object.assign(_uiState, patch);
  try { await window.api.setSetting('ui_state', _uiState); } catch {}
}

loadProjects().then(async () => {
  // Restore grid view preference before opening sessions so they enter grid mode
  if (localStorage.getItem('gridViewActive') === '1') {
    showGridView();
  }
  // Restore active session after reload. Awaited: openSession only calls
  // showSession() after the openTerminal round trip, and showSession hides every
  // main-area viewer — so leaving it in flight lets the terminal reappear on top
  // of whichever panel the restore below just opened.
  if (activeSessionId && !openSessions.has(activeSessionId)) {
    const session = sessionMap.get(activeSessionId);
    if (session) await openSession(session);
  }
  // Restore last open panel + sidebar tab
  try {
    _uiState = (await window.api.getSetting('ui_state')) || {};
    // Before the panel restore below, so the board or a project page that is
    // about to be reopened draws with the right setting rather than flipping
    // under the cursor. Absent means never touched, which keeps the default on.
    if (typeof _uiState.highlightFresh === 'boolean' && window.vueStore) {
      window.vueStore.highlightFresh = _uiState.highlightFresh;
    }
    // Restore sidebar tab first
    if (_uiState.sidebarTab && _uiState.sidebarTab !== 'sessions') {
      window.vueApp?.setTab(_uiState.sidebarTab);
    }
    // Restore main panel
    if (_uiState.panel === 'project' && _uiState.projectPath) {
      const proj = cachedAllProjects.find(p => p.projectPath === _uiState.projectPath);
      if (proj) {
        openProjectViewer(proj);
        if (_uiState.pvTab) setTimeout(() => window.vueProjectViewer?.setTab(_uiState.pvTab), 50);
      }
    } else if (_uiState.panel === 'board') {
      hideAllViewers();
      terminalArea.style.display = 'none';
      if (window.vueStore) window.vueStore.showBoard = true;
    }
  } catch {}
});

window.api.onLaunchProjectSession((projectPath, continueSession) => {
  if (continueSession) {
    const proj = cachedProjects.find(p => p.projectPath === projectPath);
    const last = proj?.sessions?.find(s => !s.archived);
    if (last) {
      if (window.vueStore?.activeTab !== 'sessions') window.vueApp?.setTab('sessions');
      setActiveSession(last.sessionId);
      openSession(last);
      return;
    }
  }
  launchNewSession({ projectPath });
});

// Live-reload sidebar when filesystem changes are detected
let projectsChangedTimer = null;
let projectsChangedWhileAway = false;
window.api.onProjectsChanged(() => {
  if (projectsChangedTimer) clearTimeout(projectsChangedTimer);

  if (pendingAccountSwitch) {
    pendingAccountSwitch = false;
    if (window.vueStore) window.vueStore.accountSwitching = false;
    loadProjects();
    return;
  }

  const activeTab = window.vueStore?.activeTab || 'sessions';
  if (activeTab !== 'sessions' && activeTab !== 'projects') {
    projectsChangedWhileAway = true;
    return;
  }
  projectsChangedTimer = setTimeout(() => {
    projectsChangedTimer = null;
    const tab = window.vueStore?.activeTab || 'sessions';
    if (tab === 'sessions') {
      loadProjects();
    } else if (tab === 'projects') {
      loadProjects().then(() => renderProjectsPanel());
    }
  }, 300);
});

// Status bar
function renderDefaultStatus() {
  const totalSessions = cachedAllProjects.reduce((n, p) => n + p.sessions.length, 0);
  const totalProjects = cachedAllProjects.length;
  const running = activePtyIds.size;
  const parts = [];
  if (running > 0) parts.push(`${running} running`);
  parts.push(`${totalSessions} sessions`);
  parts.push(`${totalProjects} projects`);
  window.vueStatusBar?.setInfo(parts.join(' \u00b7 '));
}

window.api.onStatusUpdate((text, type) => {
  window.vueStatusBar?.setActivity(text, type);
});

// --- Auto-update status + toast ---
function setUpdaterStatus(text, duration) {
  window.vueStatusBar?.setUpdater(text, duration);
}
const updaterHandler = (type, data) => {
  switch (type) {
    case 'checking':
      setUpdaterStatus('Checking for updates…');
      break;
    case 'update-available':
      setUpdaterStatus(`Update available: v${data.version}`);
      break;
    case 'update-not-available':
      setUpdaterStatus('Up to date', 3000);
      break;
    case 'download-progress':
      setUpdaterStatus(`Updating… ${Math.round(data.percent)}%`);
      break;
    case 'update-downloaded': {
      setUpdaterStatus(`v${data.version} ready — restart to update`);
      const dismissed = localStorage.getItem('update-dismissed');
      if (dismissed === data.version) return;
      const toast = document.getElementById('update-toast');
      const msg = document.getElementById('update-toast-msg');
      const notice = (data.releaseName && data.releaseName !== `v${data.version}` && data.releaseName !== data.version) ? `<span class="update-summary">${escapeHtml(data.releaseName)}</span>` : '';
      msg.innerHTML = `New Version Ready<br><span class="update-version">v${data.version}</span> (<a href="https://github.com/fortael/wootonpad/releases" target="_blank" class="update-notes-link">release notes</a>)${notice}`;
      toast.classList.remove('hidden');
      document.getElementById('update-restart-btn').onclick = () => window.api.updaterInstall();
      document.getElementById('update-dismiss-btn').onclick = () => {
        toast.classList.add('hidden');
        localStorage.setItem('update-dismissed', data.version);
      };
      break;
    }
    case 'error':
      setUpdaterStatus('Update check failed', 5000);
      break;
  }
};
window.api.onUpdaterEvent(updaterHandler);

// --- Initialize file panel (MCP bridge UI) ---
if (typeof initFilePanel === 'function') initFilePanel();

// ─── Multi-account ────────────────────────────────────────────────────────────

let accounts = [];
let activeAccountId = 'default';
let accountsUsage = {};
let pendingAccountSwitch = false;

const terminalHeaderAccount = document.getElementById('terminal-header-account');

function getAccountById(id) {
  return accounts.find(a => a.id === id) || { id: 'default', name: 'Default', configDir: '' };
}

function buildUsageChips(usage) {
  if (!usage || usage._error || usage._rateLimited) return [];
  const chips = [];
  if (usage.session != null) chips.push(`${usage.session}% 5h`);
  return chips;
}

function updateAccountDropdown() {
  window.vueAccountDropdown?.setAccounts(accounts, activeAccountId, accountsUsage);
}

function closeAccountDropdown() {
  window.vueAccountDropdown?.close();
}

async function openAccountHomeSession(account) {
  const homedir = await window.api.getHomedir();

  // Reuse an already-open home-dir terminal for this account
  for (const [sid, entry] of openSessions) {
    if (!entry.closed &&
        (entry.session?.accountId || 'default') === account.id &&
        entry.session?.projectPath === homedir) {
      showSession(sid);
      return;
    }
  }

  // Nothing open yet — launch a new session (stays on accounts tab, terminal appears in main area)
  await launchNewSession({ projectPath: homedir }, {});
}

async function switchAccount(id) {
  if (id === activeAccountId) return;
  activeAccountId = id;
  updateAccountDropdown();
  renderAccountsPanel();

  if (window.vueStore) window.vueStore.accountSwitching = true;
  pendingAccountSwitch = true;

  await window.api.setActiveAccountId(id);

  const activeTab = window.vueStore?.activeTab || 'sessions';
  if (activeTab === 'projects') loadProjects().then(() => renderProjectsPanel());
  // The detail panel labels one account "Active" — that badge just moved.
  if (activeTab === 'accounts') window.vueAccountViewer?.reload();
  // accountSwitching stays true — cleared in onProjectsChanged once new data arrives
}

// makeGroup is defined in utils.js (loaded first)
// Keep old name as alias for any remaining callers
function makePanelHeader(titleText, btnLabel, onBtnClick) {
  return makeGroup(titleText, btnLabel, onBtnClick).group;
}

function renderAccountsPanel() {
  window.vueAccounts?.setAccounts(accounts, activeAccountId);
  window.vueAccounts?.setUsage(accountsUsage);
}

// Accounts tab main area: same shape as the stats branch — clear whatever the
// previous tab had open, hide the terminal so xterm can't eat clicks, then show
// the account detail panel.
function showAccountViewer(accountId) {
  if (!accountId) return;
  hideAllViewers();
  terminalArea.style.display = 'none';
  if (window.vueStore) {
    window.vueStore.accountViewerId = accountId;
    window.vueStore.accountViewerOpen = true;
  }
  window.vueAccountViewer?.load(accountId);
}

let projectsSearchQuery = '';
let projectsSortOrder = 'name'; // 'name' | 'changes'
const projectInfoCache = new Map(); // persists across renders

function openProjectViewer(project) {
  hideAllViewers();
  placeholder.style.display = 'none';
  terminalArea.style.display = 'none';
  projectViewer.style.display = 'flex';
  window.vueProjectViewer?.open(project);
  saveUiState({ panel: 'project', projectPath: project.projectPath });
}

function renderProjectsPanel() {
  window.vueProjects?.setProjects(cachedAllProjects);
}

async function refreshAccountUsage() {
  try {
    accountsUsage = await window.api.getAccountsUsage();
    window.vueAccounts?.setUsage(accountsUsage);
    window.vueAccountDropdown?.setUsage(accountsUsage);
  } catch {}
}

async function initAccounts() {
  [accounts, activeAccountId] = await Promise.all([
    window.api.getAccounts(),
    window.api.getActiveAccountId(),
  ]);
  await refreshAccountUsage();
  updateAccountDropdown();
}

// Custom tooltip system
(function () {
  const tip = document.getElementById('app-tooltip');
  if (!tip) return;
  let timer = null;
  let activeEl = null;

  function showTip(el) {
    tip.textContent = el.dataset.tooltip;
    tip.style.display = 'block';
    tip.style.opacity = '0';

    const rect = el.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let left = rect.left + rect.width / 2 - tw / 2;
    let top = rect.bottom + 6;
    if (left < 4) left = 4;
    if (left + tw > window.innerWidth - 4) left = window.innerWidth - tw - 4;
    if (top + th > window.innerHeight - 4) top = rect.top - th - 6;

    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
    tip.style.opacity = '1';
  }

  function hideTip() {
    clearTimeout(timer);
    tip.style.opacity = '0';
    activeEl = null;
  }

  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest('[data-tooltip]');
    if (el === activeEl) return;
    clearTimeout(timer);
    tip.style.opacity = '0';
    activeEl = el;
    if (!el) return;
    timer = setTimeout(() => showTip(el), 350);
  });

  document.addEventListener('mouseout', (e) => {
    if (!activeEl) return;
    if (!activeEl.contains(e.relatedTarget)) hideTip();
  });

  document.addEventListener('click', hideTip);
  document.addEventListener('scroll', hideTip, true);
}());

initAccounts();

// --- App.vue side-effect callbacks ---
// App.vue calls these when the user interacts with the sidebar shell
// (tabs, filters, search). Each callback syncs local app.js state and
// triggers whatever data loading or rendering is needed.
window.__sb = {
  onTabChange(tabName) {
    activeTab = tabName;
    searchMatchIds = null;
    searchMatchProjectPaths = null;
    window.vueSidebar?.setSearch(null, null);
    saveUiState({ sidebarTab: tabName });

    // Not every branch below routes through hideAllViewers() (the sessions tab
    // with nothing open only un-hides the placeholder), so retire the board
    // here rather than trusting each one to do it.
    if (tabName !== 'board' && window.vueStore) window.vueStore.showBoard = false;

    if (tabName === 'sessions') {
      saveUiState({ panel: 'terminal', sidebarTab: tabName });
      if (gridViewActive) {
        for (const entry of openSessions.values()) {
          if (!entry.closed) fitAndScroll(entry);
        }
      } else if (activeSessionId && openSessions.has(activeSessionId)) {
        showSession(activeSessionId);
      } else {
        placeholder.style.display = '';
      }
      if (projectsChangedWhileAway) {
        projectsChangedWhileAway = false;
        loadProjects();
      }
    } else if (tabName === 'plans') {
      hideAllViewers();
      loadPlans();
    } else if (tabName === 'board') {
      // A main-area panel over the hidden terminal. The board derives
      // everything it draws from the live store, so there is nothing to load
      // here.
      saveUiState({ panel: 'board' });
      hideAllViewers();
      terminalArea.style.display = 'none';
      if (window.vueStore) window.vueStore.showBoard = true;
    } else if (tabName === 'accounts') {
      saveUiState({ panel: 'accounts' });
      renderAccountsPanel();
      // Nothing selected yet — the account you are running on is the one you
      // most likely came here to look at.
      showAccountViewer(window.vueStore?.accountViewerId || activeAccountId);
      refreshAccountUsage().then(() => renderAccountsPanel());
    } else if (tabName === 'projects') {
      if (projectsChangedWhileAway) {
        projectsChangedWhileAway = false;
        loadProjects().then(() => renderProjectsPanel());
      } else {
        renderProjectsPanel();
      }
    }
  },

  onFilterChange({ showStarredOnly: s, showRunningOnly: r, showTodayOnly: t, showArchived: a }) {
    showStarredOnly = s;
    showRunningOnly = r;
    showTodayOnly = t;
    showArchived = a;
    refreshSidebar({ resort: true });
  },

  async search(query, titlesOnly) {
    const tab = activeTab;
    try {
      if (tab === 'sessions') {
        const results = await window.api.search('session', query, titlesOnly);
        searchMatchIds = new Set(results.map(r => r.id));
        searchMatchProjectPaths = null;
        if (titlesOnly) {
          const matchProjects = new Set();
          for (const r of results) {
            const s = sessionMap.get(r.id);
            if (s?.projectPath) matchProjects.add(s.projectPath);
          }
          searchMatchProjectPaths = matchProjects;
        }
        window.vueSidebar?.setSearch(searchMatchIds, searchMatchProjectPaths);
        refreshSidebar({ resort: true });
      } else if (tab === 'plans') {
        const results = await window.api.search('plan', query, titlesOnly);
        const matchIds = new Set(results.map(r => r.id));
        renderPlans(window.cachedPlans.filter(p => matchIds.has(p.filename)));
      } else if (tab === 'projects') {
        projectsSearchQuery = query;
        window.vueProjects?.setSearch(query);
      }
    } catch {
      if (tab === 'sessions') {
        searchMatchIds = null;
        searchMatchProjectPaths = null;
        window.vueSidebar?.setSearch(null, null);
        refreshSidebar({ resort: true });
      }
    }
  },

  clearSearch,

  resort: () => loadProjects({ resort: true }),

  addProject: () => showAddProjectDialog(),

  openGlobalSettings: () => openSettingsViewer('global'),

  toggleGridView: () => toggleGridView(),

  openSession: (session) => openSession(session),

  // Puts the session view away without touching the session. The PTY keeps
  // running and the row stays in the sidebar — this is "stop looking at it",
  // which is a different thing from Stop and from Delete.
  closeSessionView: () => {
    // Closing the view is what retires the DONE card: the turn has been read
    // and put away. Everything else — reading it, switching to another
    // session — leaves it standing.
    const closing = (window.vueStore?.activeTab === 'board' && window.vueStore.boardPreviewId)
      || activeSessionId;
    if (closing) {
      setReadPending(closing, false);
      responseReadySessions.delete(closing);
      // The unread mark only. A session blocked on a dialog is still blocked
      // after you look away — closing the view is not an answer, and clearing
      // its attention here is what used to turn a waiting session green and
      // drop it back into IDLE. Only the status tracker retires that.
      window.vueSidebar?.clearResponseReady(closing);
    }
    // In the board's bottom split the pane belongs to the board, so closing it
    // is the board's own state change; the board stays up.
    if (window.vueStore?.activeTab === 'board' && window.vueStore.boardPreviewId) {
      window.vueStore.boardPreviewId = null;
      return;
    }
    setActiveSession(null);
    window.vueSidebar?.clearHeader();
    terminalHeader.style.display = 'none';
    terminalArea.style.display = 'none';
    placeholder.style.display = '';
    saveUiState({ panel: null });
  },

  stopSession: (id) => confirmAndStopSession(id),

  toggleStar: async (id) => {
    const { starred } = await window.api.toggleStar(id);
    const s = sessionMap.get(id);
    if (s) {
      const updated = { ...s, starred };
      sessionMap.set(id, updated);
      for (const list of [cachedProjects, cachedAllProjects]) {
        for (const p of list) {
          const idx = p.sessions.findIndex(x => x.sessionId === id);
          if (idx !== -1) p.sessions[idx] = updated;
        }
      }
    }
    refreshSidebar({ resort: true });
  },

  archiveSession: async (id) => {
    const session = sessionMap.get(id);
    if (!session) return;
    const newVal = session.archived ? 0 : 1;
    if (newVal && activePtyIds.has(id)) {
      await window.api.stopSession(id);
      pollActiveSessions();
    }
    await window.api.archiveSession(id, newVal);
    session.archived = newVal;
    loadProjects();
  },

  // The menu confirms before calling. Main kills the PTY and removes the
  // transcript; here we only have to stop showing it.
  deleteSession: async (id) => {
    const result = await window.api.deleteSession(id);
    if (!result?.ok) {
      window.vueStatusBar?.setActivity('Delete failed: ' + (result?.error || 'unknown error'), 'error');
      return;
    }
    destroySession(id);
    pendingSessions.delete(id);
    activePtyIds.delete(id);
    sessionMap.delete(id);
    for (const projList of [cachedProjects, cachedAllProjects]) {
      for (const proj of projList) {
        proj.sessions = proj.sessions.filter(s => s.sessionId !== id);
      }
    }
    if (activeSessionId === id) {
      setActiveSession(null);
      placeholder.style.display = '';
    }
    if (window.vueStore?.boardPreviewId === id) window.vueStore.boardPreviewId = null;
    pollActiveSessions();
    loadProjects();
  },

  forkSession: (id) => {
    const session = sessionMap.get(id);
    const project = [...cachedAllProjects, ...cachedProjects].find(p =>
      p.sessions.some(s => s.sessionId === id)
    );
    if (session && project && typeof forkSession === 'function') forkSession(session, project);
  },

  showJsonl: (id) => {
    const session = sessionMap.get(id);
    if (!session) return;
    hideAllViewers();
    terminalArea.style.display = 'none';
    if (window.vueStore) window.vueStore.showJsonl = true;
    window.vueJsonlViewer?.open(session);
  },

  launchConfig: (id) => {
    const session = sessionMap.get(id);
    if (session && typeof showResumeSessionDialog === 'function') showResumeSessionDialog(session);
  },

  renameSession: async (id, name) => {
    await window.api.renameSession(id, name);
    const s = sessionMap.get(id);
    if (s) s.name = name;
    // Replace the session object in Vue's reactive array via splice — this is the
    // only reliable way to force ProjectGroup.allItems to recompute, because simple
    // property mutation on the nested object is not always detected by Vue's watcher.
    if (window.vueStore?.projects) {
      outer: for (const p of window.vueStore.projects) {
        if (!p.sessions) continue;
        for (let i = 0; i < p.sessions.length; i++) {
          if (p.sessions[i]?.sessionId === id) {
            p.sessions.splice(i, 1, { ...p.sessions[i], name });
            break outer;
          }
        }
      }
    }
    refreshSidebar();
  },

  newSession: (project, anchorEl) => {
    if (typeof showNewSessionPopover === 'function') showNewSessionPopover(project, anchorEl);
  },

  openSettings: (path) => openSettingsViewer('project', path),

  archiveSessions: async (sessions) => {
    const active = sessions.filter(s => !s.archived);
    if (!active.length) return;
    const shortName = active[0]?.projectPath?.split('/').filter(Boolean).slice(-2).join('/') || '';
    if (!confirm(`Archive all ${active.length} session${active.length > 1 ? 's' : ''} in ${shortName}?`)) return;
    for (const s of active) {
      if (activePtyIds.has(s.sessionId)) await window.api.stopSession(s.sessionId);
      await window.api.archiveSession(s.sessionId, 1);
      s.archived = 1;
    }
    pollActiveSessions();
    loadProjects();
  },

  removeProject: async (path) => {
    const name = path.split('/').pop();
    if (!confirm(`Hide worktree "${name}"?\n\nSession files are not deleted.`)) return;
    await window.api.removeProject(path);
    loadProjects();
  },

  openPlan: (plan) => openPlan(plan),


  openAccountViewer: (id) => showAccountViewer(id),

  switchAccount: (id) => switchAccount(id),

  openAccountHomeSession: (acc) => openAccountHomeSession(acc),

  renameAccount: async (id, name) => {
    await window.api.renameAccount(id, name);
    updateAccountDropdown();
  },

  deleteAccount: async (id) => {
    if (activeAccountId === id) await switchAccount('default');
    accounts = accounts.filter(a => a.id !== id);
    await window.api.deleteAccount(id);
    updateAccountDropdown();
    renderAccountsPanel();
    // The panel was showing an account that no longer exists.
    if (window.vueStore?.accountViewerId === id) showAccountViewer(activeAccountId);
  },

  createAccount: async (name) => {
    const newAcc = await window.api.createAccount(name);
    if (!newAcc) return null;
    accounts = [...accounts, newAcc];
    await refreshAccountUsage();
    updateAccountDropdown();
    renderAccountsPanel();
    return newAcc;
  },

  discoverWslClaudeHomes: () => window.api.discoverWslClaudeHomes(),

  createWslAccount: async (distro, name) => {
    const newAcc = await window.api.createWslAccount(distro, name);
    if (!newAcc || newAcc.error) return newAcc;
    accounts = [...accounts, newAcc];
    await refreshAccountUsage();
    updateAccountDropdown();
    renderAccountsPanel();
    return newAcc;
  },

  openProject: (project) => openProjectViewer(project),
  onPvTabChange: (tab) => saveUiState({ pvTab: tab }),

  // "Highlight fresh", from either of the two buttons that flip it. Guarded
  // because the watcher driving this also fires when the stored value is
  // restored into the store at startup, which would write back what was just
  // read.
  setHighlightFresh: (on) => {
    if (_uiState.highlightFresh === !!on) return;
    saveUiState({ highlightFresh: !!on });
  },

  openSessionById: (sessionId) => {
    const session = sessionMap.get(sessionId);
    if (!session) return;
    hideAllViewers();
    window.vueApp?.setTab('sessions');
    openSession(session);
  },

  projectRemoved: () => loadProjects().then(() => renderProjectsPanel()),
};

// Sync initial account dropdown state (initAccounts may already have run)
updateAccountDropdown();
