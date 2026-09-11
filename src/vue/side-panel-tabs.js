// The session side panel's three panes, in one place so the rail that opens
// them and the panel that renders them cannot drift apart.
import { store } from './store.js';

export const TAB_KEY = 'sessionSidePanelTab';

export const TABS = [
  { id: 'changes', label: 'Uncommitted changes', icon: 'file-diff' },
  { id: 'containers', label: 'Containers', icon: 'container' },
  { id: 'shell', label: 'Shell', icon: 'terminal' },
];

const IDS = new Set(TABS.map(t => t.id));

/** Restore the pane the user last had open. Runs once, at app start. */
export function loadSidePanelTab() {
  // Migration: the panel used to be a boolean with three stacked sections.
  // Someone who had it open gets the first pane rather than a closed panel.
  const legacy = localStorage.getItem('sessionSidePanelOpen');
  const saved = localStorage.getItem(TAB_KEY);
  if (saved && IDS.has(saved)) return saved;
  if (!saved && legacy === '1') return TABS[0].id;
  return null;
}

/** @param {string|null} id */
export function setSidePanelTab(id) {
  const next = id && IDS.has(id) ? id : null;
  store.sidePanelTab = next;
  if (next) localStorage.setItem(TAB_KEY, next);
  else localStorage.removeItem(TAB_KEY);
  // The boolean is gone; clear it so a downgrade cannot resurrect the old
  // three-section layout on top of the new one.
  localStorage.removeItem('sessionSidePanelOpen');
}
