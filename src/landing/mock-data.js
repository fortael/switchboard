const now = Date.now();
const mins = (n) => new Date(now - n * 60 * 1000).toISOString();
const hours = (n) => new Date(now - n * 60 * 60 * 1000).toISOString();
const days = (n) => new Date(now - n * 24 * 60 * 60 * 1000).toISOString();

// Live PTYs. Three of the projects below own at least one, so AttentionRail
// renders a row per project and CollapsedRailApp has avatars to show.
export const MOCK_ACTIVE_PTY_IDS = new Set(['sess-001', 'sess-004', 'sess-006', 'sess-003', 'sess-term']);
// One project per rail status: wooton-pad waits on input, my-api is working,
// blog-redesign has a reply ready.
export const MOCK_WAITING_PTY_IDS = new Set(['sess-003']);
export const MOCK_RESPONSE_READY_PTY_IDS = new Set(['sess-006']);
// Deliberately NOT every live PTY. SessionBoardApp's columnFor() ranks busy
// above response-ready, so marking sess-006 busy would empty the DONE column
// and the board would demo three states instead of four.
export const MOCK_BUSY_PTY_IDS = new Set(['sess-001', 'sess-004']);

// Session the demo opens with — drives SessionHeaderApp and the fake terminal.
export const MOCK_SELECTED_SESSION_ID = 'sess-001';
// Project the second demo window (ProjectViewerApp) opens.
export const MOCK_VIEWER_PROJECT_PATH = '/Users/demo/Projects/my-api';

// `contextTokens` drives SessionCard's UsageRing and `linesAdded`/`linesRemoved`
// its churn row — both are board-card features, so every session carries them.
export const MOCK_PROJECTS = [
  {
    projectPath: '/Users/demo/Projects/wooton-pad',
    sessions: [
      {
        sessionId: 'sess-001',
        name: 'Add landing page + interactive demo',
        aiTitle: 'GitHub Pages marketing site with Vue components',
        modified: mins(28),
        messageCount: 62,
        contextTokens: 84_000, linesAdded: 412, linesRemoved: 96, changedFiles: 7,
        starred: false, archived: false, type: 'claude', slug: null,
      },
      {
        sessionId: 'sess-term',
        name: 'Terminal',
        aiTitle: '',
        modified: mins(5),
        messageCount: 0,
        starred: false, archived: false, type: 'terminal', slug: null,
      },
      {
        sessionId: 'sess-002',
        name: 'Fix session fork detection',
        aiTitle: 'Session transition JSONL matching logic',
        modified: days(2),
        messageCount: 38,
        contextTokens: 51_000, linesAdded: 88, linesRemoved: 41, changedFiles: 3,
        starred: true, archived: false, type: 'claude', slug: null,
      },
      {
        sessionId: 'sess-003',
        name: 'OAuth integration refactor',
        aiTitle: 'Multi-account credential separation',
        modified: days(4),
        messageCount: 94,
        contextTokens: 148_000, linesAdded: 233, linesRemoved: 187, changedFiles: 11,
        starred: false, archived: false, type: 'claude', slug: null,
      },
    ],
  },
  {
    projectPath: '/Users/demo/Projects/my-api',
    sessions: [
      {
        sessionId: 'sess-004',
        name: 'Add rate limiting middleware',
        aiTitle: 'Token bucket algorithm for Express.js routes',
        modified: mins(51),
        messageCount: 29,
        contextTokens: 37_000, linesAdded: 168, linesRemoved: 12, changedFiles: 4,
        starred: false, archived: false, type: 'claude', slug: null,
      },
      {
        sessionId: 'sess-005',
        name: 'Database migration for v2',
        aiTitle: 'PostgreSQL schema migration with zero downtime',
        modified: hours(26),
        messageCount: 115,
        contextTokens: 172_000, linesAdded: 604, linesRemoved: 58, changedFiles: 9,
        starred: false, archived: false, type: 'claude', slug: null,
      },
    ],
  },
  {
    projectPath: '/Users/demo/Projects/blog-redesign',
    sessions: [
      {
        sessionId: 'sess-006',
        name: 'Homepage hero section',
        aiTitle: 'Responsive hero with animated gradient background',
        modified: hours(2),
        messageCount: 47,
        contextTokens: 66_000, linesAdded: 197, linesRemoved: 74, changedFiles: 5,
        starred: true, archived: false, type: 'claude', slug: null,
      },
      {
        sessionId: 'sess-007',
        name: 'Mobile navigation menu',
        aiTitle: 'Accessible hamburger menu with CSS animations',
        modified: days(2),
        messageCount: 33,
        contextTokens: 44_000, linesAdded: 121, linesRemoved: 19, changedFiles: 3,
        starred: false, archived: false, type: 'claude', slug: null,
      },
      // Archived, so the Archived filter tab has something the other tabs hide.
      {
        sessionId: 'sess-008',
        name: 'Newsletter signup form',
        aiTitle: 'Double opt-in flow with Mailchimp webhook',
        modified: days(9),
        messageCount: 21,
        contextTokens: 29_000, linesAdded: 64, linesRemoved: 8, changedFiles: 2,
        starred: false, archived: true, type: 'claude', slug: null,
      },
    ],
  },
];

export const MOCK_ACCOUNTS = [
  { id: 'default', name: 'Personal', configDir: '~/.claude (default)' },
  { id: 'work', name: 'Work', configDir: '~/.claude-work' },
];

export const MOCK_ACTIVE_ACCOUNT_ID = 'default';

// Usage quota behind the account chip in the top nav ("42% 5h").
export const MOCK_USAGE = {
  default: { session: 42, weekAll: 68, sessionResetIn: '3h', weekAllResetIn: '2d' },
  work: { session: 15, weekAll: 31, sessionResetIn: '4h', weekAllResetIn: '5d' },
};

export const MOCK_PLANS = [
  {
    filename: 'implement-rate-limiting.md',
    title: 'Implement rate limiting middleware',
    modified: hours(3),
  },
  {
    filename: 'database-migration-plan.md',
    title: 'Zero-downtime PostgreSQL migration',
    modified: days(1),
  },
];

// One entry per project, not just the one the Projects window opens: the
// session side panel is scoped to the OPEN SESSION's project, so a demo that
// only knew my-api would show an empty Changes pane for the selected session.
// `unpushedCommits` + `upstream` are what the Commits sub-tab and its Push
// button read.
export const MOCK_PROJECT_DETAIL = {
  '/Users/demo/Projects/wooton-pad': {
    branch: 'feat/landing-refresh',
    upstream: 'origin/feat/landing-refresh',
    totalAdded: 412,
    totalDeleted: 96,
    changedFiles: [
      { file: 'src/landing/LandingApp.vue', added: 186, deleted: 61 },
      { file: 'src/landing/landing.css', added: 104, deleted: 22 },
      { file: 'src/landing/mock-data.js', added: 88, deleted: 9 },
      { file: 'src/landing/main.js', added: 31, deleted: 4 },
      { file: 'docs/index.html', added: 3, deleted: 0 },
    ],
    commits: [
      { hash: '9164def', message: 'feat(session): add session card component', author: 'demo', date: '4h ago' },
      { hash: '56b1034', message: 'feat(board): implement session board view', author: 'demo', date: '1d ago' },
      { hash: '5b368ad', message: 'fix: resolve absolute path for claude binary', author: 'demo', date: '2d ago' },
      { hash: '8f038a5', message: 'chore(release): bump version to 0.6.0', author: 'demo', date: '3d ago' },
    ],
    unpushedCommits: [
      { hash: '9164def', message: 'feat(session): add session card component', author: 'demo', date: '4h ago' },
      { hash: '56b1034', message: 'feat(board): implement session board view', author: 'demo', date: '1d ago' },
    ],
    // The demo opens on a session in this project, so its Containers pane is
    // the one a visitor is most likely to click — it should not be empty.
    containers: [
      { name: 'wooton-pad-docs-1', state: 'running', status: 'Up 12 minutes', ports: '3000→3000' },
      { name: 'wooton-pad-e2e-1', state: 'exited', status: 'Exited (0) 1h ago' },
    ],
    worktreePaths: [],
    readmePath: null,
  },
  '/Users/demo/Projects/my-api': {
    branch: 'feat/rate-limiting',
    upstream: 'origin/feat/rate-limiting',
    totalAdded: 168,
    totalDeleted: 12,
    changedFiles: [
      { file: 'src/middleware/rate-limit.js', added: 89, deleted: 0 },
      { file: 'src/routes/api.js', added: 12, deleted: 3 },
      { file: 'test/rate-limit.test.js', added: 65, deleted: 0 },
      { file: 'package.json', added: 2, deleted: 1 },
    ],
    commits: [
      { hash: 'a3f8c21', message: 'feat: add token bucket rate limiter', author: 'demo', date: '2d ago' },
      { hash: 'b91e4f7', message: 'feat: add middleware scaffolding', author: 'demo', date: '3d ago' },
      { hash: 'c45d2a9', message: 'chore: initial Express setup', author: 'demo', date: '5d ago' },
      { hash: 'd73e1b4', message: 'docs: add README and contributing guide', author: 'demo', date: '6d ago' },
    ],
    unpushedCommits: [
      { hash: 'a3f8c21', message: 'feat: add token bucket rate limiter', author: 'demo', date: '2d ago' },
    ],
    containers: [
      { name: 'my-api-postgres-1', state: 'running', status: 'Up 2 hours', ports: '5432→5432' },
      { name: 'my-api-redis-1', state: 'running', status: 'Up 2 hours', ports: '6379→6379' },
      { name: 'my-api-worker-1', state: 'exited', status: 'Exited (0) 20m ago' },
    ],
    worktreePaths: [],
    readmePath: null,
  },
  '/Users/demo/Projects/blog-redesign': {
    branch: 'feat/homepage-hero',
    upstream: null,
    totalAdded: 197,
    totalDeleted: 74,
    changedFiles: [
      { file: 'src/pages/index.astro', added: 121, deleted: 58 },
      { file: 'src/styles/global.css', added: 76, deleted: 16 },
    ],
    commits: [
      { hash: 'e11a730', message: 'style: tune hero gradient stops', author: 'demo', date: '5h ago' },
      { hash: 'f2c9b88', message: 'feat: scaffold homepage hero', author: 'demo', date: '1d ago' },
    ],
    unpushedCommits: [],
    containers: [],
    worktreePaths: [],
    readmePath: null,
  },
};

// Scratch-shell pane of the session side panel. No PTY on a landing page, so
// window.createPanelTerminal renders this transcript instead of an xterm.
export const MOCK_PANEL_SHELL_LINES = [
  { t: 'sh-prompt', cwd: '~/Projects/wooton-pad', branch: 'feat/landing-refresh' },
  { t: 'sh-cmd', v: 'git status -sb' },
  { t: 'sh-out', v: '## feat/landing-refresh...origin/feat/landing-refresh [ahead 2]' },
  { t: 'sh-out', v: ' M src/landing/LandingApp.vue' },
  { t: 'sh-out', v: ' M src/landing/landing.css' },
  { t: 'sh-prompt', cwd: '~/Projects/wooton-pad', branch: 'feat/landing-refresh' },
  { t: 'sh-cursor' },
];

// Canned answers for the board sidebar's Summarize button — in the app this is
// one headless `claude` call over the last message of each board session.
export const MOCK_BOARD_SUMMARIES = {
  'sess-001': 'Rebuilt the landing demo around the new session panel rail and wired the board tab into the shell.',
  'sess-003': 'Waiting on a decision about where refresh tokens live before the multi-account refactor can continue.',
  'sess-004': 'Added a token-bucket rate limiter and its tests; the suite is running now.',
  'sess-006': 'Finished the animated gradient hero and is ready for review.',
  'sess-002': 'Fixed fork detection by matching parentSessionId in the JSONL; all 14 tests pass.',
  'sess-005': 'Wrote the zero-downtime migration plus a 50M-row backfill script and rehearsed the rollback.',
  'sess-007': 'Shipped an accessible hamburger menu with a focus trap and a pure-CSS slide animation.',
  'sess-term': 'Plain shell — ran the test suite, nothing outstanding.',
};

// Commit messages the "Generate with Claude" buttons produce in the demo.
export const MOCK_COMMIT_MESSAGES = {
  short: 'feat(landing): catch the demo up to the session panel rail and board',
  descriptive: `feat(landing): catch the demo up to the session panel rail and board

- Render SessionPanelRail over the terminal instead of header buttons
- Add the Board tab and its sidebar to the live demo shell
- Drop the removed Agent Files and Stats tabs
- Load board-view, side-panel and controls CSS alongside the rest`,
};

export const MOCK_PROJECT_INFO = {
  '/Users/demo/Projects/my-api': {
    branch: 'feat/rate-limiting',
    added: 47,
    deleted: 12,
    sizeMb: 2.4,
    containers: [
      { name: 'my-api-postgres-1', state: 'running', status: 'Up 2 hours' },
      { name: 'my-api-redis-1', state: 'running', status: 'Up 2 hours' },
      { name: 'my-api-app-1', state: 'running', status: 'Up 1 hour' },
    ],
  },
  '/Users/demo/Projects/wooton-pad': {
    branch: 'main',
    added: 128,
    deleted: 34,
    sizeMb: 8.1,
    containers: [],
  },
  '/Users/demo/Projects/blog-redesign': {
    branch: 'feat/homepage-hero',
    added: 22,
    deleted: 5,
    sizeMb: 0.8,
    containers: [],
  },
};

const AVATAR_PALETTE = ['#e05c3b', '#5b9dff', '#34d399', '#f0b429', '#b48cf2', '#f68b86', '#38bdf8', '#fb923c'];

export function getProjectAvatar(projectPath) {
  const name = (projectPath || '').split('/').filter(Boolean).pop() || '?';
  const initials = name.slice(0, 2).toUpperCase();
  let hash = 0;
  for (const ch of projectPath) hash = (hash * 31 + ch.charCodeAt(0)) & 0xffff;
  const color = AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
  return { initials, color };
}

const LOGO = [' ▐▛███▜▌  ', '▝▜█████▛▘', '  ▘▘ ▝▝ '];

export const MOCK_TERMINAL_LINES = {
  'sess-001': [
    { t: 'logo', logo: LOGO, info: ['Claude Code v2.1.177', 'Opus 4.8 · Claude Max', '~/Projects/wooton-pad'] },
    { t: 'blank' },
    { t: 'sep', v: '─'.repeat(44) },
    { t: 'ok', v: '✓ Read src/landing/LandingApp.vue' },
    { t: 'ok', v: '✓ Read src/landing/mock-data.js' },
    { t: 'ok', v: '✓ Updated MOCK_TERMINAL_LINES' },
    { t: 'spin', v: 'Writing animation CSS…' },
    { t: 'sep', v: '─'.repeat(44) },
    { t: 'hint', v: '? for shortcuts · ← for agents' },
  ],
  'sess-004': [
    { t: 'logo', logo: LOGO, info: ['Claude Code v2.1.177', 'Opus 4.8 · Claude Max', '~/Projects/my-api'] },
    { t: 'blank' },
    { t: 'sep', v: '─'.repeat(44) },
    { t: 'ok', v: '✓ Read src/middleware/auth.js' },
    { t: 'ok', v: '✓ Created src/middleware/rate-limit.js' },
    { t: 'ok', v: '✓ Updated src/routes/api.js' },
    { t: 'spin', v: 'Running test suite…' },
    { t: 'sep', v: '─'.repeat(44) },
    { t: 'hint', v: '? for shortcuts · ← for agents' },
  ],
  'sess-002': [
    { t: 'logo', logo: LOGO, info: ['Claude Code v2.1.177', 'Opus 4.8 · Claude Max', '~/Projects/wooton-pad'] },
    { t: 'blank' },
    { t: 'sep', v: '─'.repeat(44) },
    { t: 'ok', v: '✓ Read session-transitions.js' },
    { t: 'ok', v: '✓ Fixed fork detection logic' },
    { t: 'ok', v: '✓ Updated JSONL parent matching' },
    { t: 'ok', v: '✓ All 14 tests passed' },
    { t: 'done', v: '● Session ended · 38 messages' },
  ],
  'sess-003': [
    { t: 'logo', logo: LOGO, info: ['Claude Code v2.1.177', 'Opus 4.8 · Claude Max', '~/Projects/wooton-pad'] },
    { t: 'blank' },
    { t: 'sep', v: '─'.repeat(56) },
    { t: 'todo', v: '☐ OAuth integration refactor' },
    { t: 'blank' },
    { t: 'question', v: 'Where should refresh_token be stored for multi-account?' },
    { t: 'blank' },
    { t: 'opt-sel', v: ' 1. File system' },
    { t: 'opt-sub', v: '     ~/.claude/credentials/<account>.json — current approach.' },
    { t: 'opt', v: '  2. System keychain' },
    { t: 'opt-sub', v: '     macOS Keychain — secure, no CLI access needed.' },
    { t: 'opt', v: '  3. Environment variables' },
    { t: 'opt-sub', v: '     OAUTH_REFRESH_TOKEN — simple, but not persistent.' },
    { t: 'opt', v: '  4. Not sure' },
    { t: 'opt-sub', v: '     Show me options to determine the current state.' },
    { t: 'opt', v: '  5. Type something.' },
    { t: 'sep', v: '─'.repeat(56) },
    { t: 'opt', v: '  6. Chat about this' },
    { t: 'blank' },
    { t: 'nav', v: 'Enter to select · ↑/↓ to navigate · Esc to cancel' },
  ],
  'sess-005': [
    { t: 'logo', logo: LOGO, info: ['Claude Code v2.1.177', 'Opus 4.8 · Claude Max', '~/Projects/my-api'] },
    { t: 'blank' },
    { t: 'sep', v: '─'.repeat(44) },
    { t: 'ok', v: '✓ Created migration 0042_user_schema.sql' },
    { t: 'ok', v: '✓ Added backfill script for 50M rows' },
    { t: 'ok', v: '✓ Tested with pg_dump rollback' },
    { t: 'done', v: '● Session ended · 115 messages' },
  ],
  'sess-006': [
    { t: 'logo', logo: LOGO, info: ['Claude Code v2.1.177', 'Opus 4.8 · Claude Max', '~/Projects/blog-redesign'] },
    { t: 'blank' },
    { t: 'sep', v: '─'.repeat(44) },
    { t: 'ok', v: '✓ Read src/pages/index.astro' },
    { t: 'ok', v: '✓ Read src/styles/global.css' },
    { t: 'ok', v: '✓ Designed hero layout with CSS Grid' },
    { t: 'spin', v: 'Writing animated gradient background…' },
    { t: 'sep', v: '─'.repeat(44) },
    { t: 'hint', v: '? for shortcuts · ← for agents' },
  ],
  'sess-term': [
    { t: 'sh-prompt', cwd: '~/Projects/wooton-pad', branch: 'main' },
    { t: 'sh-cmd', v: 'git log --oneline -4' },
    { t: 'sh-out', v: 'b9241113 feat: add refresh stats to project viewer' },
    { t: 'sh-out', v: '7b1a8eb7 chore(ci): upgrade actions to v5' },
    { t: 'sh-out', v: '9163ad2a chore: bump version to 0.2.0' },
    { t: 'sh-out', v: 'b7c4c6b3 feat: add project avatar and multi-account UI' },
    { t: 'sh-prompt', cwd: '~/Projects/wooton-pad', branch: 'main' },
    { t: 'sh-cmd', v: 'npm test' },
    { t: 'blank' },
    { t: 'sh-out', v: '> wootonpad@0.2.0 test' },
    { t: 'sh-out', v: '> node --test' },
    { t: 'blank' },
    { t: 'sh-out-ok', v: '✔ folder-index-state (1.8s)' },
    { t: 'sh-out-ok', v: '✔ session-cache (0.7s)' },
    { t: 'sh-out-ok', v: '✔ session-transitions (0.4s)' },
    { t: 'blank' },
    { t: 'sh-prompt', cwd: '~/Projects/wooton-pad', branch: 'main' },
    { t: 'sh-cursor' },
  ],
  'sess-007': [
    { t: 'logo', logo: LOGO, info: ['Claude Code v2.1.177', 'Opus 4.8 · Claude Max', '~/Projects/blog-redesign'] },
    { t: 'blank' },
    { t: 'sep', v: '─'.repeat(44) },
    { t: 'ok', v: '✓ Built accessible hamburger menu' },
    { t: 'ok', v: '✓ Added focus-trap for keyboard nav' },
    { t: 'ok', v: '✓ CSS slide animation (no JS)' },
    { t: 'done', v: '● Session ended · 33 messages' },
  ],
  'sess-008': [
    { t: 'logo', logo: LOGO, info: ['Claude Code v2.1.177', 'Opus 4.8 · Claude Max', '~/Projects/blog-redesign'] },
    { t: 'blank' },
    { t: 'sep', v: '─'.repeat(44) },
    { t: 'ok', v: '✓ Added double opt-in confirmation step' },
    { t: 'ok', v: '✓ Wired Mailchimp webhook handler' },
    { t: 'done', v: '● Session ended · 21 messages' },
  ],
};
