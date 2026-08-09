// Tray icon: session status at a glance, plus the usage limits of every account.
//
// The module is split in two on purpose. Everything above the "Electron wiring"
// line is pure: state in, a description of what the tray should look like out. That
// half carries all the formatting and precedence rules and is unit tested without
// Electron. Below the line is only plumbing.
//
// The icon says one thing — whether a session wants the user — and says it by the
// weight of the glyph rather than by colour, because a macOS template image is
// masked to the menu bar colour and cannot carry hue. Limits live in the tooltip and
// the menu, so the two signals never compete for the same pixels.

const path = require('path');

const ICON_DIR = path.join(__dirname, 'public', 'tray');

// --- Presentation (pure) ---------------------------------------------------

// Longest label the menu will show for one session; past this the middle is cut so
// both the project and the end of the title survive.
const SESSION_LABEL_MAX = 48;

function truncateMiddle(text, max = SESSION_LABEL_MAX) {
  if (text.length <= max) return text;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`;
}

function sessionLabel(session) {
  // Both separators, on every platform. A projectPath is POSIX when it came from a
  // Unix host or a WSL-backed account, and native when Windows owns the project, so
  // splitting on '/' alone hands the whole `C:\...\proj` string back as the label.
  const project = session.projectPath
    ? session.projectPath.split(/[\\/]/).filter(Boolean).pop()
    : null;
  const title = session.title || session.sessionSlug || null;
  if (project && title) return truncateMiddle(`${project} — ${title}`);
  return truncateMiddle(project || title || session.sessionId || 'session');
}

// One account's limits as a single line. The five-hour window is what people hit
// first, so it leads; the weekly figure follows, and the reset is only worth the
// space when the window it resets is actually loaded.
function usageLine(account, usage) {
  const name = account.name || account.id;
  // No entry at all means nothing has been fetched yet, which is the normal state for
  // the first few seconds after launch — saying "unavailable" there would report a
  // failure that has not happened.
  if (!usage) return `${name} — no limit data yet`;
  if (usage._error) return `${name} — limits unavailable`;
  if (usage._rateLimited) return `${name} — rate limited by the API`;

  const parts = [];
  if (typeof usage.session === 'number') parts.push(`5h ${usage.session}%`);
  if (typeof usage.weekAll === 'number') parts.push(`week ${usage.weekAll}%`);
  if (typeof usage.weekOpus === 'number') parts.push(`opus ${usage.weekOpus}%`);
  if (!parts.length) return `${name} — no limit data yet`;

  if (usage.sessionResetIn && typeof usage.session === 'number' && usage.session > 0) {
    parts.push(`resets in ${usage.sessionResetIn}`);
  }
  return `${name} — ${parts.join(' · ')}${usage._cached ? ' (cached)' : ''}`;
}

// The worst number across every account, which is what belongs in a tooltip that
// has to summarise all of them in one line.
function peakUsage(accounts, usageByAccount) {
  let session = null;
  let week = null;
  for (const account of accounts) {
    const usage = usageByAccount[account.id];
    if (!usage) continue;
    if (typeof usage.session === 'number') session = Math.max(session ?? 0, usage.session);
    if (typeof usage.weekAll === 'number') week = Math.max(week ?? 0, usage.weekAll);
  }
  return { session, week };
}

function statusLine(attentionCount, busyCount) {
  if (attentionCount > 0) {
    const sessions = attentionCount === 1 ? 'session' : 'sessions';
    return `${attentionCount} ${sessions} waiting for you`;
  }
  if (busyCount > 0) return `${busyCount} running`;
  return 'nothing waiting';
}

// state: { attention: [session], busy: [session], accounts: [], usage: {} }
// Returns a description of the tray: which icon, what tooltip, and the menu as
// plain items. Turning items into an Electron menu is the wiring's job.
function presentTray(state = {}) {
  const attention = state.attention || [];
  const busy = state.busy || [];
  const accounts = state.accounts || [];
  const usage = state.usage || {};

  const icon = attention.length ? 'attention' : (busy.length ? 'busy' : 'idle');

  const tooltip = ['WootonPad', statusLine(attention.length, busy.length)];
  const peak = peakUsage(accounts, usage);
  if (peak.session !== null || peak.week !== null) {
    const parts = [];
    if (peak.session !== null) parts.push(`5h ${peak.session}%`);
    if (peak.week !== null) parts.push(`week ${peak.week}%`);
    const scope = accounts.length > 1 ? ` (highest of ${accounts.length} accounts)` : '';
    tooltip.push(`Limits: ${parts.join(' · ')}${scope}`);
  }

  const items = [];
  if (attention.length) {
    items.push({ kind: 'header', label: 'Waiting for you' });
    for (const session of attention) {
      items.push({ kind: 'session', label: sessionLabel(session), sessionId: session.sessionId });
    }
    items.push({ kind: 'separator' });
  } else {
    items.push({ kind: 'header', label: statusLine(0, busy.length) });
    items.push({ kind: 'separator' });
  }

  if (accounts.length) {
    items.push({ kind: 'header', label: 'Limits' });
    for (const account of accounts) {
      items.push({ kind: 'text', label: usageLine(account, usage[account.id]) });
    }
    items.push({ kind: 'separator' });
  }

  items.push({ kind: 'show', label: 'Show WootonPad' });
  items.push({ kind: 'quit', label: 'Quit WootonPad' });

  return { icon, tooltip: tooltip.join('\n'), items };
}

// --- Electron wiring -------------------------------------------------------

let tray = null;
let callbacks = {};
let lastIcon = null;
// Serialised last view. Busy state flips twice per prompt, and most of those flips
// produce the same tray as before; rebuilding a native menu for them is waste.
let lastViewKey = null;

function iconPath(name, isDarwin) {
  return path.join(ICON_DIR, `${name}${isDarwin ? 'Template' : ''}.png`);
}

function toMenuTemplate(items) {
  return items.map((item) => {
    switch (item.kind) {
      case 'separator':
        return { type: 'separator' };
      case 'session':
        return { label: item.label, click: () => callbacks.onFocusSession?.(item.sessionId) };
      case 'show':
        return { label: item.label, click: () => callbacks.onShow?.() };
      case 'quit':
        return { label: item.label, click: () => callbacks.onQuit?.() };
      // Headers and limit lines are labels the user cannot act on. Disabled rather
      // than absent, so the grouping is visible.
      default:
        return { label: item.label, enabled: false };
    }
  });
}

// Returns true when a tray actually exists afterwards. A Linux desktop with no
// status-notifier host is the case that matters: Tray construction can throw or
// produce an icon nobody displays, and the caller must not hide the window into
// something that is not there.
function createTray(handlers = {}) {
  const { Tray, Menu, nativeImage } = require('electron');
  callbacks = handlers;
  if (tray) return true;

  try {
    const isDarwin = process.platform === 'darwin';
    const image = nativeImage.createFromPath(iconPath('idle', isDarwin));
    if (image.isEmpty()) return false;
    if (isDarwin) image.setTemplateImage(true);

    tray = new Tray(image);
    lastIcon = 'idle';
    // A fresh icon has nothing installed on it yet, so the next update must not be
    // skipped as a repeat of whatever the previous tray was showing.
    lastViewKey = null;
    tray.setToolTip('WootonPad');
    tray.setContextMenu(Menu.buildFromTemplate(toMenuTemplate(presentTray().items)));

    // On macOS a left click opens the menu, which is the platform convention. On
    // Windows and Linux the menu is the right button, so the left one is free to do
    // the obvious thing.
    if (!isDarwin) tray.on('click', () => callbacks.onShow?.());
    tray.on('double-click', () => callbacks.onShow?.());
    return true;
  } catch {
    tray = null;
    return false;
  }
}

function updateTray(state) {
  if (!tray || tray.isDestroyed?.()) return null;
  const { Menu, nativeImage } = require('electron');
  const view = presentTray(state);

  const viewKey = JSON.stringify(view);
  if (viewKey === lastViewKey) return view;
  lastViewKey = viewKey;

  if (view.icon !== lastIcon) {
    const isDarwin = process.platform === 'darwin';
    const image = nativeImage.createFromPath(iconPath(view.icon, isDarwin));
    if (!image.isEmpty()) {
      if (isDarwin) image.setTemplateImage(true);
      tray.setImage(image);
      lastIcon = view.icon;
    }
  }

  tray.setToolTip(view.tooltip);
  // Rebuilt wholesale: an Electron menu is immutable once built, and the item list
  // changes shape whenever a session starts or stops waiting.
  tray.setContextMenu(Menu.buildFromTemplate(toMenuTemplate(view.items)));
  return view;
}

function destroyTray() {
  if (!tray) return;
  try { tray.destroy(); } catch {}
  tray = null;
  lastIcon = null;
  lastViewKey = null;
}

function isTrayActive() {
  return !!tray && !tray.isDestroyed?.();
}

module.exports = {
  // pure, for tests and for the wiring above
  presentTray, usageLine, peakUsage, sessionLabel, truncateMiddle, statusLine,
  // wiring
  createTray, updateTray, destroyTray, isTrayActive, iconPath, ICON_DIR,
};
