// --- Terminal management ---
// Key bindings, write buffering, xterm instance lifecycle, drag-and-drop.
//
// Depends on globals: openSessions, activeSessionId, TERMINAL_THEME, terminalsEl,
// gridViewActive, gridCards, gridViewerCount, placeholder, terminalHeader,
// sessionMap, activePtyIds (app.js)
// Depends on: toggleGridView, isSessionNavKey, handleSessionNavKey, focusGridCard,
// wrapInGridCard, showGridView (grid-view.js)
// Depends on: shellEscape (utils.js)

// Current terminal typography — read from settings on startup, changed via
// _applyTerminalFont / _applyTerminalMetrics. Defaults must match
// UI_METRIC_DEFAULTS in public/ui-metrics.js.
let currentFontFamily = (window.TERMINAL_FONTS?.['default']?.family) || "'SF Mono', Menlo, monospace";
let currentFontSize = 12;
let currentLineHeight = 1.25;

window._getTerminalMetrics = () => ({ fontSize: currentFontSize, lineHeight: currentLineHeight });

function reapplyTerminalTypography() {
  for (const entry of allTerminalEntries()) {
    entry.terminal.options.fontFamily = currentFontFamily;
    entry.terminal.options.fontSize = currentFontSize;
    entry.terminal.options.lineHeight = currentLineHeight;
    safeFit(entry);
  }
}

// Every live xterm instance: the session terminals plus the side panel's
// scratch shell, which is deliberately not in openSessions (see below).
function* allTerminalEntries() {
  for (const [, entry] of openSessions) {
    if (!entry.closed) yield entry;
  }
  if (panelTerm) yield panelTerm;
}

// Something outside the terminal changed its width — the session side panel
// opened, closed or was dragged. xterm keeps its own cols/rows and pushes them
// to the PTY, so without a refit the CLI keeps wrapping at the old width.
window._refitOpenTerminals = () => {
  for (const entry of allTerminalEntries()) safeFit(entry);
};

window._applyTerminalFont = (fontFamily) => {
  currentFontFamily = fontFamily;
  reapplyTerminalTypography();
};

// Font size and line height change the character box, so every open terminal
// has to be refitted or the PTY keeps the old cols/rows.
window._applyTerminalMetrics = ({ fontSize, lineHeight } = {}) => {
  if (Number.isFinite(fontSize)) currentFontSize = fontSize;
  if (Number.isFinite(lineHeight)) currentLineHeight = lineHeight;
  reapplyTerminalTypography();
};

// --- Terminal key bindings ---
// Shift+Enter → kitty protocol (CSI 13;2u) so Claude Code treats it as newline, not submit.
// Two layers needed:
//   1. attachCustomKeyEventHandler returning false — blocks xterm's key pipeline (onKey/onData)
//   2. preventDefault on capture-phase keydown — prevents browser inserting \n into textarea
const isMac = window.api.platform === 'darwin';
function setupTerminalKeyBindings(terminal, container, getSessionId, { onFind } = {}) {
  terminal.attachCustomKeyEventHandler((e) => {
    // Cmd/Ctrl+F → open terminal search bar
    if (e.key === 'f' && (isMac ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey) {
      if (e.type === 'keydown' && onFind) onFind();
      return false;
    }

    // Cmd/Ctrl+Shift+G → toggle grid view
    if (e.key === 'g' && (isMac ? e.metaKey : e.ctrlKey) && e.shiftKey && !e.altKey) {
      if (e.type === 'keydown') { e._handled = true; toggleGridView(); }
      return false;
    }

    // Session navigation: Cmd+Shift+[/], Cmd+Arrow
    if (isSessionNavKey(e)) {
      if (e.type === 'keydown') { e._handled = true; handleSessionNavKey(e); }
      return false;
    }

    // Shift+Enter → newline (kitty protocol CSI 13;2u) so Claude Code treats it as newline, not submit.
    if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      if (e.type === 'keydown') {
        window.api.sendInput(getSessionId(), '\x1b[13;2u');
      }
      return false;
    }

    // Ctrl+Enter → newline on Windows/Linux (matches PowerShell convention).
    // Send the same Shift+Enter kitty sequence that Claude Code recognizes as newline.
    if (!isMac && e.key === 'Enter' && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
      if (e.type === 'keydown') {
        window.api.sendInput(getSessionId(), '\x1b[13;2u');
      }
      return false;
    }

    // On Windows/Linux, Ctrl+V is captured by xterm as a control character (0x16)
    // instead of triggering a paste. Return false to block xterm's key pipeline and
    // let Electron's Edit menu { role: 'paste' } handle the actual clipboard paste.
    if (!isMac && e.key === 'v' && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
      return false;
    }

    // On Windows/Linux, Ctrl+C with a selection should copy instead of sending SIGINT.
    // When nothing is selected, Ctrl+C falls through to xterm (sends SIGINT as normal).
    if (!isMac && e.key === 'c' && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
      if (terminal.hasSelection()) {
        if (e.type === 'keydown') {
          navigator.clipboard.writeText(terminal.getSelection()).catch(() => {});
        }
        return false;
      }
    }

    // Space → send directly on keydown (including key-repeat) to ensure reliable
    // delivery to the PTY. xterm.js's evaluateKeyboardEvent does not handle plain
    // Space in keydown (keyCode 32 < 48 threshold) and instead relies on the
    // deprecated 'keypress' event, which Electron/Chromium may not fire reliably
    // for key-repeat events. This fixes Claude Code's "Hold Space to record"
    // push-to-talk voice feature, which depends on rapid key-repeat characters
    // arriving at stdin to detect a held key.
    if (e.key === ' ' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      if (e.type === 'keydown') {
        e.preventDefault();
        window.api.sendInput(getSessionId(), ' ');
      }
      return false;
    }

    return true;
  });

  const textarea = container.querySelector('.xterm-helper-textarea');
  if (textarea) {
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.shiftKey || (!isMac && e.ctrlKey)) && !e.altKey && !e.metaKey) {
        e.preventDefault();
      }
    }, { capture: true });
  }
}

// Check whether a terminal is scrolled to the bottom using xterm's buffer API.
function isAtBottom(terminal) {
  const buf = terminal.buffer.active;
  return buf.viewportY >= buf.baseY;
}

// Fit terminal to container, subtracting 1 row to avoid partial-row clipping.
function safeFit(entry) {
  const dims = entry.fitAddon.proposeDimensions();
  if (dims && dims.rows > 1) {
    entry.terminal.resize(dims.cols, dims.rows);
  } else {
    entry.fitAddon.fit();
  }
}

// Fit a terminal that just became visible (from display:none or reparent).
// Defers to requestAnimationFrame so the container has dimensions.
function fitAndScroll(entry) {
  const wasAtBottom = isAtBottom(entry.terminal);
  requestAnimationFrame(() => {
    safeFit(entry);
    if (wasAtBottom) {
      entry.terminal.scrollToBottom();
    }
  });
}

// --- Terminal write buffering ---
// Batch incoming terminal data to coalesce IPC chunks into fewer write() calls.
const ESC_SYNC_START = '\x1b[?2026h';
const ESC_SYNC_END = '\x1b[?2026l';
const SYNC_BUFFER_TIMEOUT = 500; // max ms to hold data waiting for sync end
const terminalWriteBuffers = new Map(); // sessionId → { chunks, syncDepth, rafId, timerId }

function flushTerminalBuffer(sessionId) {
  const buf = terminalWriteBuffers.get(sessionId);
  if (!buf) return;
  clearTimeout(buf.timerId);
  cancelAnimationFrame(buf.rafId);
  terminalWriteBuffers.delete(sessionId);

  const entry = openSessions.get(sessionId);
  if (!entry) return;

  const data = buf.chunks.join('');
  const wasAtBottom = isAtBottom(entry.terminal);
  const savedViewportY = entry.terminal.buffer.active.viewportY;
  entry.terminal.write(data, () => {
    if (sessionId !== activeSessionId) return;
    if (wasAtBottom) {
      entry.terminal.scrollToBottom();
    } else {
      // Restore scroll position so redraws don't yank the user away
      entry.terminal.scrollLines(savedViewportY - entry.terminal.buffer.active.viewportY);
    }
  });
}

function scheduleFlush(sessionId, buf) {
  cancelAnimationFrame(buf.rafId);
  buf.rafId = requestAnimationFrame(() => flushTerminalBuffer(sessionId));
}

// --- Terminal lifecycle helpers ---

// Create an xterm instance, wire up IPC, and register in openSessions.
// Returns the entry. Does NOT make it visible or fit it — call showSession() for that.
function createTerminalEntry(session) {
  const { sessionId } = session;
  const container = document.createElement('div');
  container.className = 'terminal-container';
  terminalsEl.appendChild(container);

  const terminal = new Terminal({
    fontSize: currentFontSize,
    lineHeight: currentLineHeight,
    fontFamily: currentFontFamily,
    theme: TERMINAL_THEME,
    cursorBlink: false,
    scrollback: 10000,
    convertEol: true,
    allowProposedApi: true,
    linkHandler: {
      activate: (_event, uri) => {
        if (uri.startsWith('file://') && typeof openFileInPanel === 'function') {
          try { openFileInPanel(sessionId, decodeURIComponent(new URL(uri).pathname)); } catch {}
        } else {
          window.api.openExternal(uri);
        }
      },
      allowNonHttpProtocols: true,
    },
  });

  const fitAddon = new FitAddon.FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new WebLinksAddon.WebLinksAddon((_event, url) => {
    if (url.startsWith('file://') && typeof openFileInPanel === 'function') {
      try { openFileInPanel(sessionId, decodeURIComponent(new URL(url).pathname)); } catch {}
    } else {
      window.api.openExternal(url);
    }
  }));
  const searchAddon = new SearchAddon.SearchAddon();
  terminal.loadAddon(searchAddon);
  terminal.loadAddon(new UnicodeGraphemesAddon.UnicodeGraphemesAddon());
  terminal.unicode.activeVersion = '15';
  terminal.open(container);
  container.style.backgroundColor = TERMINAL_THEME.background;

  // GPU-accelerated rendering via WebGL — drops renderer+compositor CPU ~50-70%.
  // Must be loaded after terminal.open() (needs attached DOM). Fails silently on
  // machines without WebGL support; xterm falls back to the default DOM renderer.
  try {
    const webglAddon = new WebglAddon.WebglAddon();
    webglAddon.onContextLoss(() => webglAddon.dispose());
    terminal.loadAddon(webglAddon);
  } catch (e) {
    console.warn('[terminal] WebGL addon failed, falling back to DOM renderer', e);
  }

  // --- Terminal search bar (Cmd/Ctrl+F) ---
  const searchBar = document.createElement('div');
  searchBar.className = 'terminal-search-bar';
  searchBar.style.display = 'none';
  searchBar.innerHTML = `
    <input type="text" class="terminal-search-input" placeholder="Find..." />
    <span class="terminal-search-count"></span>
    <button class="terminal-search-prev" data-tooltip="Previous (Shift+Enter)">&#x25B2;</button>
    <button class="terminal-search-next" data-tooltip="Next (Enter)">&#x25BC;</button>
    <button class="terminal-search-close" data-tooltip="Close (Escape)">&times;</button>
  `;
  container.appendChild(searchBar);
  const searchInput = searchBar.querySelector('.terminal-search-input');
  const searchCount = searchBar.querySelector('.terminal-search-count');
  const searchOpts = { decorations: { matchBackground: '#515C6A', activeMatchBackground: '#EAA549', matchOverviewRuler: '#515C6A', activeMatchColorOverviewRuler: '#EAA549' } };

  function openSearchBar() {
    searchBar.style.display = 'flex';
    searchInput.focus();
    const sel = terminal.getSelection();
    if (sel) { searchInput.value = sel; searchAddon.findNext(sel, searchOpts); }
  }
  function closeSearchBar() {
    searchBar.style.display = 'none';
    searchAddon.clearDecorations();
    searchInput.value = '';
    searchCount.textContent = '';
    terminal.focus();
  }
  searchInput.addEventListener('input', () => {
    const q = searchInput.value;
    if (q) { searchAddon.findNext(q, searchOpts); } else { searchAddon.clearDecorations(); searchCount.textContent = ''; }
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeSearchBar(); e.preventDefault(); }
    else if (e.key === 'Enter' && e.shiftKey) { searchAddon.findPrevious(searchInput.value, searchOpts); e.preventDefault(); }
    else if (e.key === 'Enter') { searchAddon.findNext(searchInput.value, searchOpts); e.preventDefault(); }
  });
  searchBar.querySelector('.terminal-search-next').addEventListener('click', () => searchAddon.findNext(searchInput.value, searchOpts));
  searchBar.querySelector('.terminal-search-prev').addEventListener('click', () => searchAddon.findPrevious(searchInput.value, searchOpts));
  searchBar.querySelector('.terminal-search-close').addEventListener('click', closeSearchBar);

  const entry = { terminal, element: container, fitAddon, searchAddon, openSearchBar, closeSearchBar, session, closed: false };
  openSessions.set(sessionId, entry);

  // Wire up IPC (use entry.session.sessionId so fork re-keying works)
  terminal.onData(data => {
    if (data === '\x1b[I' || data === '\x1b[O') return;
    window.api.sendInput(entry.session.sessionId, data);
  });
  setupTerminalKeyBindings(terminal, container, () => entry.session.sessionId, { onFind: openSearchBar });
  setupDragAndDrop(container, () => entry.session.sessionId);
  terminal.onResize(({ cols, rows }) => {
    window.api.resizeTerminal(entry.session.sessionId, cols, rows);
  });
  terminal.onTitleChange(title => {
    entry.ptyTitle = title;
    if (activeSessionId === entry.session.sessionId) updatePtyTitle();
  });
  terminal.onBell(() => {
    trackActivity(entry.session.sessionId, '\x07');
  });

  return entry;
}

// Clean up a closed session entry (dispose terminal, remove DOM, remove from maps).
function destroySession(sessionId) {
  const entry = openSessions.get(sessionId);
  if (!entry) return;
  window.api.closeTerminal(sessionId);
  entry.terminal.dispose();
  entry.element.remove();
  openSessions.delete(sessionId);
  const card = gridCards.get(sessionId);
  if (card) { card.remove(); gridCards.delete(sessionId); }
}

// Make a session visible in the current view mode (grid or single).
// Handles sidebar highlight, notifications, header, fit, and focus.
function showSession(sessionId) {
  const entry = openSessions.get(sessionId);
  const session = sessionMap.get(sessionId) || (entry && entry.session);

  // Update sidebar active state
  document.querySelectorAll('.session-item.active').forEach(el => el.classList.remove('active'));
  const item = document.querySelector(`[data-session-id="${sessionId}"]`);
  if (item) item.classList.add('active');
  setActiveSession(sessionId);
  clearNotifications(sessionId);

  if (gridViewActive) {
    // Ensure grid layout is set up (e.g. on first session after startup restore)
    if (!terminalsEl.classList.contains('grid-layout')) {
      showGridView();
    }
    if (entry && gridCards.has(sessionId)) {
      // Already in grid — just focus it
      focusGridCard(sessionId);
    } else if (entry) {
      // New entry not yet in grid — wrap and focus
      wrapInGridCard(sessionId);
      fitAndScroll(entry);
      requestAnimationFrame(() => focusGridCard(sessionId));
      gridViewerCount.textContent = gridCards.size + ' session' + (gridCards.size !== 1 ? 's' : '');
    }
  } else {
    // Single terminal view
    document.querySelectorAll('.terminal-container').forEach(el => el.classList.remove('visible'));
    placeholder.style.display = 'none';
    hidePlanViewer();
    if (session) showTerminalHeader(session);
    if (entry) {
      entry.element.classList.add('visible');
      entry.terminal.focus();
      fitAndScroll(entry);
    }
  }
}

// --- Session side-panel scratch shell ---------------------------------------
//
// A plain login shell that lives exactly as long as the session side panel is
// open. It is deliberately kept OUT of `openSessions`: nothing about it should
// reach the sidebar, the session list or the grid view, and app.js's own
// terminal-data / process-exited handlers therefore never match its id.
//
// Ownership: created by SessionSidePanelApp.vue on mount (and whenever the open
// session's project path changes), destroyed on unmount, on a project change,
// and on renderer unload. main.js additionally reaps any earlier ephemeral PTY
// when a new one is requested, which covers a renderer reload.

let panelTerm = null;

// Its own id namespace, so nothing can confuse it with a Claude session UUID.
// Hyphen, not colon: session ids occasionally end up in file names.
const PANEL_TERM_ID_PREFIX = 'sbx-panel-shell-';

window.api.onTerminalData((sessionId, data) => {
  if (panelTerm && sessionId === panelTerm.id) panelTerm.terminal.write(data);
});

window.api.onProcessExited((sessionId) => {
  if (panelTerm && sessionId === panelTerm.id) {
    panelTerm.exited = true;
    panelTerm.terminal.write('\r\n\x1b[90m[shell exited]\x1b[0m\r\n');
  }
});

// Spawn the panel shell and attach it to `host`. Resolves once the PTY is up.
window.createPanelTerminal = async function createPanelTerminal(host, projectPath) {
  window.destroyPanelTerminal();
  if (!host || !projectPath) return null;

  const id = PANEL_TERM_ID_PREFIX + crypto.randomUUID();
  const terminal = new Terminal({
    fontSize: currentFontSize,
    lineHeight: currentLineHeight,
    fontFamily: currentFontFamily,
    theme: TERMINAL_THEME,
    cursorBlink: false,
    // A scratch shell, not a session log — a short scrollback is plenty and
    // keeps the panel cheap.
    scrollback: 2000,
    convertEol: true,
    allowProposedApi: true,
  });
  const fitAddon = new FitAddon.FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new WebLinksAddon.WebLinksAddon((_event, url) => {
    window.api.openExternal(url);
  }));
  // No WebGL addon here on purpose: the browser caps the number of live WebGL
  // contexts, and the session terminals are the ones that need one.
  terminal.open(host);
  host.style.backgroundColor = TERMINAL_THEME.background;

  const entry = { id, terminal, fitAddon, element: host, projectPath, closed: false, exited: false };
  panelTerm = entry;

  terminal.onData(data => {
    if (data === '\x1b[I' || data === '\x1b[O') return;
    window.api.sendInput(id, data);
  });
  terminal.onResize(({ cols, rows }) => window.api.resizeTerminal(id, cols, rows));
  setupDragAndDrop(host, () => id);

  // The panel is resized by dragging, by collapsing a section above it and by
  // the window itself. An observer is both simpler and more reliable than
  // calling fit from each of those places — and it also catches the first
  // measurement, which xterm cannot make until the font has actually loaded.
  let fitRaf = 0;
  entry.observer = new ResizeObserver(() => {
    cancelAnimationFrame(fitRaf);
    fitRaf = requestAnimationFrame(() => { if (panelTerm === entry) safeFit(entry); });
  });
  entry.observer.observe(host);

  const result = await window.api.openTerminal(id, projectPath, true, { type: 'terminal', ephemeral: true });
  // The panel may have been closed while the PTY was starting.
  if (panelTerm !== entry) return null;
  if (!result?.ok) {
    entry.exited = true;
    terminal.write(`\r\n\x1b[31mError: ${result?.error || 'could not start shell'}\x1b[0m\r\n`);
    return entry;
  }
  safeFit(entry);
  // xterm cannot size a cell before its font has actually loaded, and the
  // first fit can land on the fallback metrics. One deferred fit settles it.
  setTimeout(() => { if (panelTerm === entry) safeFit(entry); }, 150);
  return entry;
};

// Kill the PTY and dispose the xterm instance. Safe to call when none exists.
window.destroyPanelTerminal = function destroyPanelTerminal() {
  const entry = panelTerm;
  if (!entry) return;
  panelTerm = null;
  // close-terminal only detaches; the PTY has to be killed explicitly or it
  // outlives the panel that owns it.
  try { entry.observer?.disconnect(); } catch {}
  if (!entry.exited) { try { window.api.stopSession(entry.id); } catch {} }
  try { window.api.closeTerminal(entry.id); } catch {}
  try { entry.terminal.dispose(); } catch {}
};

window.fitPanelTerminal = function fitPanelTerminal() {
  if (panelTerm) safeFit(panelTerm);
};

window.focusPanelTerminal = function focusPanelTerminal() {
  panelTerm?.terminal.focus();
};

window._applyPanelTerminalTheme = (theme) => {
  if (!panelTerm) return;
  panelTerm.terminal.options.theme = theme;
  panelTerm.element.style.backgroundColor = theme.background;
};

// A renderer reload never reaches SessionSidePanelApp's unmount hook.
window.addEventListener('beforeunload', () => window.destroyPanelTerminal());

function setupDragAndDrop(container, getSessionId) {
  let dragCounter = 0;
  container.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    container.classList.add('drag-over');
  });
  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  container.addEventListener('dragleave', () => {
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      container.classList.remove('drag-over');
    }
  });
  container.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    container.classList.remove('drag-over');
    const files = e.dataTransfer.files;
    if (!files.length) return;
    const paths = Array.from(files).map(f => shellEscape(window.api.getPathForFile(f)));
    window.api.sendInput(getSessionId(), paths.join(' '));
  });
}
