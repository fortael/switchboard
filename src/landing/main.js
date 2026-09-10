import { createApp } from 'vue';
import { store } from '../vue/store.js';
import LandingApp from './LandingApp.vue';
import {
  MOCK_PROJECTS,
  MOCK_ACCOUNTS,
  MOCK_ACTIVE_ACCOUNT_ID,
  MOCK_ACTIVE_PTY_IDS,
  MOCK_BUSY_PTY_IDS,
  MOCK_WAITING_PTY_IDS,
  MOCK_RESPONSE_READY_PTY_IDS,
  MOCK_PROJECT_INFO,
  MOCK_PROJECT_DETAIL,
  MOCK_PANEL_SHELL_LINES,
  MOCK_BOARD_SUMMARIES,
  MOCK_COMMIT_MESSAGES,
  getProjectAvatar,
} from './mock-data.js';
import '../../public/style.css';
// fonts-brand.css is deliberately NOT imported here: vite's library mode
// inlines url() assets as base64, which quadrupled docs/landing.css. It is
// copied to docs/css/ by build:landing and linked from docs/index.html after
// landing.css instead.
// Redesign layer — same list, same order as public/index.html loads it. Keep
// the two in step: a stylesheet the app loads and the landing does not is a
// component that silently renders unstyled in the demo.
import '../../public/css/controls.css';
import '../../public/css/shell.css';
import '../../public/css/sidebar-redesign.css';
import '../../public/css/session-view.css';
import '../../public/css/accounts-view.css';
import '../../public/css/projects-view.css';
import '../../public/css/usage-ring.css';
import '../../public/css/board-view.css';
import '../../public/css/session-menu.css';
import '../../public/css/side-panel.css';
import '../../public/css/terminal-preview.css';
import '../../public/css/theme-light.css';
// Landing-only CSS. Lives here rather than in a .vue <style> block: the app's
// `vite build` writes its CSS asset straight over public/style.css.
import './landing.css';

const MOCK_DIFF_CONTENT = `const { RateLimiterMemory } = require('rate-limiter-flexible');

const limiters = new Map();

module.exports = function rateLimit({ points = 100, duration = 60 } = {}) {
  return async (req, res, next) => {
    const key = req.ip ?? 'anonymous';
    if (!limiters.has(key)) {
      limiters.set(key, new RateLimiterMemory({ points, duration }));
    }
    try {
      await limiters.get(key).consume(key);
      next();
    } catch {
      res.status(429).json({ error: 'Too many requests', retryAfter: duration });
    }
  };
};`;

// A generated file's whole content reads as one big + hunk, which is what the
// unified diff polyfill below draws.
const MOCK_FILE_CONTENT = {
  'src/middleware/rate-limit.js': MOCK_DIFF_CONTENT,

  'src/landing/LandingApp.vue': `<div
  id="terminal-area"
  :class="{ 'has-side-panel': sidePanelVisible }"
  :style="{ '--sbx-sidepanel-w': store.sidePanelWidth + 'px' }"
>
  <div id="vue-session-header">
    <SessionHeaderApp />
  </div>

  <!-- The panel toggles, Stop and Close all live on this rail now —
       overlaid on the terminal's top-right corner rather than in the
       session header, so they reach the board's bottom split too. -->
  <SessionPanelRail v-if="store.headerSession" />
  <SessionSidePanelApp v-if="sidePanelVisible" />
</div>`,

  'src/landing/landing.css': `/* css/side-panel.css shifts #terminal-split / #terminals / #grid-viewer
   out from under the floating panel. The landing's static transcript is
   none of those, so it needs the same margin under its own selector. */
.lp-app-window #terminal-area.has-side-panel > .lp-term {
  margin-right: calc(var(--sbx-sidepanel-w) + var(--sbx-sidepanel-gap) * 2);
}`,

  'src/landing/mock-data.js': `// Live PTYs. Three of the projects below own at least one, so AttentionRail
// renders a row per project and CollapsedRailApp has avatars to show.
export const MOCK_ACTIVE_PTY_IDS = new Set([
  'sess-001', 'sess-004', 'sess-006', 'sess-003', 'sess-term',
]);

// Deliberately NOT every live PTY. SessionBoardApp's columnFor() ranks busy
// above response-ready, so marking sess-006 busy would empty the DONE column.
export const MOCK_BUSY_PTY_IDS = new Set(['sess-001', 'sess-004']);`,

  'src/landing/main.js': `import '../../public/css/board-view.css';
import '../../public/css/session-menu.css';
import '../../public/css/side-panel.css';`,

  'docs/index.html': `<meta name="description" content="A native desktop app that brings
  order to your Claude Code workflow.">`,
};

// A demo has no backend, so anything that would mutate a repo resolves with a
// friendly refusal rather than pretending it worked.
const DEMO_ONLY = async () => ({ ok: false, error: 'Not available in the browser demo — grab the app.' });

// Stub Electron IPC bridge
window.api = new Proxy({}, {
  get: (_, prop) => {
    if (prop === 'onProjectInfoUpdated') return () => {};
    if (prop === 'getProjectAvatar') return async () => null;
    // The rail badges its Changes/Containers buttons from this row before any
    // panel has been opened, so it has to answer with the same shape.
    if (prop === 'getProjectGitCache') return async (path) => MOCK_PROJECT_DETAIL[path] ?? null;
    if (prop === 'getSetting') return async () => null;
    if (prop === 'setSetting') return async () => ({ ok: true });
    if (prop === 'getProjectInfo') return async (path) => MOCK_PROJECT_INFO[path] ?? null;
    if (prop === 'getProjectDetail') return async (path) => MOCK_PROJECT_DETAIL[path] ?? null;
    if (prop === 'gitBranches') return async () => ({ ok: true, branches: ['feat/rate-limiting', 'main'], remotes: ['origin/main'] });
    if (prop === 'getProjectSessions') return async () => ({ ok: true, sessions: [] });
    if (prop === 'getActiveTerminals') return async () => ({});
    if (prop === 'getGitUserInfo') return async () => ({ ok: true, name: 'Demo User', email: 'demo@example.com' });
    if (prop === 'getFileDiff') return async (_path, filePath) => ({
      ok: true,
      oldContent: '',
      newContent: MOCK_FILE_CONTENT[filePath] ?? `// ${filePath}\n// Open the app to see the real diff.`,
    });
    // Generating a message is the one git action that costs nothing to fake:
    // it only writes into a textarea the demo already owns.
    if (prop === 'gitGenerateCommitMsg') {
      return async (_path, style) => {
        await new Promise(r => setTimeout(r, 700));
        return { ok: true, message: MOCK_COMMIT_MESSAGES[style] || MOCK_COMMIT_MESSAGES.short };
      };
    }
    if (prop === 'gitCommit' || prop === 'gitPush' || prop === 'gitCheckout') return DEMO_ONLY;
    if (prop === 'boardSummarizeAbort') return async () => ({ ok: true });
    if (prop === 'boardSummarizeSessions') {
      return async (sessions) => {
        await new Promise(r => setTimeout(r, 900));
        return {
          ok: true,
          summaries: (sessions || [])
            .filter(s => MOCK_BOARD_SUMMARIES[s.sessionId])
            .map(s => ({ sessionId: s.sessionId, summary: MOCK_BOARD_SUMMARIES[s.sessionId] })),
          usage: { inputTokens: 18_432, outputTokens: 611, costUSD: 0.042 },
        };
      };
    }
    // Default: return { ok: false } so bare `res.ok` checks don't throw on null
    return async () => ({ ok: false });
  },
});

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

// Minimal CodeMirror diff viewer polyfill for the landing page
window.createReadOnlyMergeViewer = function(el, _old, newContent, filePath) {
  const rows = newContent.split('\n').map(l =>
    `<div class="lp-diff-line lp-diff-add"><span class="lp-diff-gutter">+</span><span class="lp-diff-code">${escapeHtml(l)}</span></div>`
  ).join('');
  el.innerHTML = `<div class="lp-diff-wrap"><div class="lp-diff-filename">${escapeHtml(filePath)}</div><div class="lp-diff-body">${rows}</div></div>`;
  return { destroy() { el.innerHTML = ''; } };
};

// The session side panel is 380px wide, so it asks for the unified viewer
// rather than the side-by-side one. Same polyfill — it only ever draws one
// column — minus the filename strip, which the panel's own header already
// shows above the diff.
window.createReadOnlyUnifiedMergeViewer = function(el, _old, newContent) {
  const rows = newContent.split('\n').map(l =>
    `<div class="lp-diff-line lp-diff-add"><span class="lp-diff-gutter">+</span><span class="lp-diff-code">${escapeHtml(l)}</span></div>`
  ).join('');
  el.innerHTML = `<div class="lp-diff-wrap"><div class="lp-diff-body">${rows}</div></div>`;
  return { destroy() { el.innerHTML = ''; } };
};

// ── Scratch shell ────────────────────────────────────────────────────────
// terminal-manager.js owns a real xterm + PTY in the app. On a page there is
// neither, so the side panel's shell pane gets the same static transcript
// treatment the session terminal gets, rendered with the same .lp-term classes.
const SHELL_ROW = {
  'sh-prompt': (l) => `<div class="lp-term-line lp-term-sh-prompt"><span class="lp-sh-cwd">${escapeHtml(l.cwd)}</span>${
    l.branch ? `<span class="lp-sh-branch">&nbsp;on <span class="lp-sh-branch-name">${escapeHtml(l.branch)}</span></span>` : ''
  }</div>`,
  'sh-cmd': (l) => `<div class="lp-term-line lp-term-sh-cmd"><span class="lp-sh-arrow">❯</span> ${escapeHtml(l.v)}</div>`,
  'sh-cursor': () => '<div class="lp-term-line lp-term-sh-cmd"><span class="lp-sh-arrow">❯</span> <span class="lp-sh-block-cursor">█</span></div>',
  'sh-out': (l) => `<div class="lp-term-line lp-term-sh-out">${escapeHtml(l.v)}</div>`,
};

window.createPanelTerminal = async function(host) {
  host.innerHTML = `<div class="lp-term lp-term--panel">${
    MOCK_PANEL_SHELL_LINES.map(l => (SHELL_ROW[l.t] || SHELL_ROW['sh-out'])(l)).join('')
  }</div>`;
  return { demo: true };
};
window.destroyPanelTerminal = () => {};
window.focusPanelTerminal = () => {};
// Opening/closing/resizing the panel refits every xterm in the app. Nothing to
// refit here, but the components call it unconditionally.
window._refitOpenTerminals = () => {};

// Stub globals used by Vue components
window.cleanDisplayName = (name) => (name || '').replace(/\n/g, ' ').trim();
window.lastActivityTime = new Map();
window.getProjectAvatar = getProjectAvatar;

window.formatDate = (date) => {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
};

// Prevent confirm dialogs in the demo
window.confirm = () => false;

// Stub stop button — no-op in demo
window.confirmAndStopSession = () => {};

// Populate store with mock data
store.projects = MOCK_PROJECTS;
store.allProjects = MOCK_PROJECTS;
store.activePtyIds = MOCK_ACTIVE_PTY_IDS;
store.sessionBusyState = new Map([...MOCK_BUSY_PTY_IDS].map(id => [id, true]));
store.attentionSessions = MOCK_WAITING_PTY_IDS;
store.responseReadySessions = MOCK_RESPONSE_READY_PTY_IDS;
store.headerAccount = MOCK_ACCOUNTS.find(a => a.id === MOCK_ACTIVE_ACCOUNT_ID)?.name || null;
store.headerShellProfile = 'zsh';
store.sessionMaxAgeDays = 30;
store.visibleSessionCount = 20;
// The panel opens on Changes so the pane the rail leads with is the pane the
// demo shows. The app persists the user's last choice instead.
store.sidePanelTab = 'changes';
store.sidePanelWidth = 340;
// The app defaults to 380px against a full-height window. The demo frame is
// 620px tall, where that would leave the board a single squeezed row.
store.boardSplitHeight = 260;

// ── window.__sb — the app's renderer bridge ──────────────────────────────
// public/app.js installs the real one; everything it does is Electron IPC or
// xterm. The landing gets the same surface, implemented against the mock
// store: actions that make sense without a backend (select, search, star,
// archive, rename, stop) mutate the store so the demo feels live; everything
// else is a no-op. Shared components stay landing-unaware.
function findSession(sessionId) {
  for (const p of store.projects) {
    const s = p.sessions.find(x => x.sessionId === sessionId);
    if (s) return { session: s, project: p };
  }
  return null;
}

window.__sb = {
  openSession(session) {
    if (!session?.sessionId) return;
    store.activeSessionId = session.sessionId;
    store.attentionProject = findSession(session.sessionId)?.project.projectPath || null;
  },

  search(query, titlesOnly) {
    const q = String(query || '').toLowerCase();
    const ids = new Set();
    const paths = new Set();
    for (const p of store.projects) {
      if (!titlesOnly && p.projectPath.toLowerCase().includes(q)) paths.add(p.projectPath);
      for (const s of p.sessions) {
        const haystack = `${s.name || ''} ${s.aiTitle || ''}`.toLowerCase();
        if (haystack.includes(q)) ids.add(s.sessionId);
      }
    }
    store.searchMatchIds = ids;
    store.searchMatchProjectPaths = paths;
  },

  clearSearch() {
    store.searchMatchIds = null;
    store.searchMatchProjectPaths = null;
  },

  toggleGridView() { store.gridViewActive = !store.gridViewActive; },

  toggleStar(sessionId) {
    const hit = findSession(sessionId);
    if (hit) hit.session.starred = !hit.session.starred;
  },

  archiveSession(sessionId) {
    const hit = findSession(sessionId);
    if (hit) hit.session.archived = !hit.session.archived;
  },

  archiveSessions(sessions) {
    for (const s of sessions || []) window.__sb.archiveSession(s.sessionId);
  },

  renameSession(sessionId, name) {
    const hit = findSession(sessionId);
    if (hit && name) hit.session.name = name;
  },

  stopSession(sessionId) {
    store.activePtyIds.delete(sessionId);
    store.sessionBusyState.delete(sessionId);
    store.attentionSessions.delete(sessionId);
    store.responseReadySessions.delete(sessionId);
  },

  // The rail's X. In the app this closes whichever of the two views is
  // showing and leaves the session running; here that is the same thing.
  closeSessionView() {
    store.boardPreviewId = null;
    store.activeSessionId = null;
    store.headerSession = null;
  },

  switchAccount(id) {
    store.headerAccount = MOCK_ACCOUNTS.find(a => a.id === id)?.name || null;
  },

  // Everything below needs a real Electron main process — nothing to do here.
  onTabChange() {},
  onFilterChange() {},
  onPvTabChange() {},
  resort() {},
  addProject() {},
  removeProject() {},
  projectRemoved() {},
  openProject() {},
  openSettings() {},
  openGlobalSettings() {},
  newSession() {},
  forkSession() {},
  showJsonl() {},
  launchConfig() {},
  openPlan() {},
  openAccountHomeSession() {},
  openAccountViewer() {},
  renameAccount() {},
  deleteAccount() {},
  createAccount() { return null; },
  discoverWslClaudeHomes() { return []; },
  createWslAccount() { return null; },
};
window.vuePlans = {};
window.vueAccounts = {};
window.vueProjects = {};
window.vuePlanViewer = {};
window.vueStatusBar = {};
window.vueAccountDropdown = {};
window.vueGrid = {};
window.vueDialogs = {};
window.vueStore = store;
// SessionBoardApp opens a card by handing the user to the session view. On the
// landing that is the same tab switch, so LandingApp fills this in on mount.
window.vueApp = {};

window.MOCK_ACCOUNTS = MOCK_ACCOUNTS;

createApp(LandingApp).mount('#landing-app');

// Tooltip system (mirrors public/app.js)
setTimeout(() => {
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
}, 100);
