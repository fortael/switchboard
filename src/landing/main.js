import { createApp } from 'vue';
import { store } from '../vue/store.js';
import LandingApp from './LandingApp.vue';
import {
  MOCK_PROJECTS,
  MOCK_ACCOUNTS,
  MOCK_ACTIVE_ACCOUNT_ID,
  MOCK_ACTIVE_PTY_IDS,
  MOCK_WAITING_PTY_IDS,
  MOCK_RESPONSE_READY_PTY_IDS,
  MOCK_PROJECT_INFO,
  MOCK_PROJECT_DETAIL,
  getProjectAvatar,
} from './mock-data.js';
import '../../public/style.css';
// fonts-brand.css is deliberately NOT imported here: vite's library mode
// inlines url() assets as base64, which quadrupled docs/landing.css. It is
// copied to docs/css/ by build:landing and linked from docs/index.html after
// landing.css instead.
// Redesign layer — same order as public/index.html loads it.
import '../../public/css/shell.css';
import '../../public/css/sidebar-redesign.css';
import '../../public/css/session-view.css';
import '../../public/css/accounts-view.css';
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

// Stub Electron IPC bridge
window.api = new Proxy({}, {
  get: (_, prop) => {
    if (prop === 'onProjectInfoUpdated') return () => {};
    if (prop === 'getProjectAvatar') return async () => null;
    if (prop === 'getProjectGitCache') return async () => null;
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
      newContent: filePath === 'src/middleware/rate-limit.js' ? MOCK_DIFF_CONTENT : '// mock content',
    });
    // Default: return { ok: false } so bare `res.ok` checks don't throw on null
    return async () => ({ ok: false });
  },
});

// Minimal CodeMirror diff viewer polyfill for the landing page
window.createReadOnlyMergeViewer = function(el, _old, newContent, filePath) {
  const lines = newContent.split('\n');
  const rows = lines.map(l => {
    const esc = l.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    return `<div class="lp-diff-line lp-diff-add"><span class="lp-diff-gutter">+</span><span class="lp-diff-code">${esc}</span></div>`;
  }).join('');
  el.innerHTML = `<div class="lp-diff-wrap"><div class="lp-diff-filename">${filePath}</div><div class="lp-diff-body">${rows}</div></div>`;
  return { destroy() { el.innerHTML = ''; } };
};

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
store.activePtyIds = MOCK_ACTIVE_PTY_IDS;
store.sessionBusyState = new Map([...MOCK_ACTIVE_PTY_IDS].map(id => [id, true]));
store.attentionSessions = MOCK_WAITING_PTY_IDS;
store.responseReadySessions = MOCK_RESPONSE_READY_PTY_IDS;
store.headerAccount = MOCK_ACCOUNTS.find(a => a.id === MOCK_ACTIVE_ACCOUNT_ID)?.name || null;
store.sessionMaxAgeDays = 30;
store.visibleSessionCount = 20;

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
  openMemory() {},
  openAccountHomeSession() {},
  renameAccount() {},
  deleteAccount() {},
  createAccount() { return null; },
  discoverWslClaudeHomes() { return []; },
  createWslAccount() { return null; },
};
window.vuePlans = {};
window.vueMemory = {};
window.vueAccounts = {};
window.vueProjects = {};
window.vuePlanViewer = {};
window.vueMemoryViewer = {};
window.vueStatusBar = {};
window.vueAccountDropdown = {};
window.vueGrid = {};
window.vueDialogs = {};
window.vueStore = store;

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
