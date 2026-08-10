<template>
  <div>
    <div class="project-group">
      <div class="project-header">
        <span class="project-name">Accounts</span>
      </div>
      <div class="project-sessions">
        <div
          v-for="acc in accounts"
          :key="acc.id"
          class="session-item account-item"
          :class="{ active: acc.id === activeAccountId }"
          @click="onSwitch(acc)"
        >
          <div class="session-row">
            <div class="account-name-row">
              <template v-if="editingId === acc.id">
                <input
                  class="account-row-name-input"
                  v-model="editName"
                  :ref="el => { if (el) activeEditInput = el }"
                  @blur="saveEdit(acc)"
                  @keydown.enter.prevent="saveEdit(acc)"
                  @keydown.escape="cancelEdit"
                  @click.stop
                />
              </template>
              <template v-else>
                <div class="session-summary" @dblclick.stop="startEdit(acc)">{{ acc.name }}</div>
              </template>
              <div class="account-card-actions">
                <button
                  v-if="editingId !== acc.id"
                  class="account-edit-btn"
                  data-tooltip="Rename"
                  @click.stop="startEdit(acc)"
                  v-html="editSvg"
                ></button>
                <button
                  class="account-open-btn"
                  data-tooltip="Open Claude session in home directory"
                  @click.stop="onOpenClaude(acc)"
                >Open Claude</button>
<!-- Every account can go, the default one included: an install that
                     only runs Claude inside WSL has no use for a Windows home it
                     never opens. The last one stays — the app has to be looking
                     at something. -->
                <button
                  v-if="accounts.length > 1"
                  class="account-row-del"
                  data-tooltip="Remove account"
                  @click.stop="onDelete(acc)"
                  v-html="trashSvg"
                ></button>
              </div>
            </div>
            <div class="session-subtitle">{{ acc.configDir || '~/.claude (default)' }}</div>
            <div v-if="hasUsage(acc.id)" class="account-usage-block">
              <div v-for="row in usageRows(acc.id)" :key="row.key" class="account-usage-row">
                <span class="account-usage-label">{{ row.label }}</span>
                <div class="account-usage-bar">
                  <div
                    class="account-usage-bar-fill"
                    :class="{ danger: row.pct >= 90, warn: row.pct >= 70 && row.pct < 90 }"
                    :style="{ width: Math.min(row.pct, 100) + '%' }"
                  ></div>
                </div>
                <span class="account-usage-info">{{ row.pct }}%{{ row.resetIn ? `  · resets in ${row.resetIn}~` : '' }}</span>
              </div>
              <div v-if="usage[acc.id]?._cached" class="account-usage-cached-note">cached data</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="project-group">
      <div class="project-header" :class="{ collapsed: !addOpen }" @click="addOpen = !addOpen">
        <span class="arrow">&#9660;</span>
        <span class="project-name">Add account</span>
      </div>
      <div class="project-sessions accounts-add-section">
        <p class="accounts-add-desc">Each account uses its own Claude credentials and session history. Add a second account to switch between personal and work Claude Pro plans, or any two separate logins.</p>
        <div class="accounts-add-form">
          <input
            v-model="newName"
            placeholder="Account name (e.g. Work / Personal)"
            @keydown.enter="addAccount"
          />
          <div class="text-center">
            <button class="btn-green" :disabled="adding" @click="addAccount">
              {{ adding ? 'Adding…' : 'Add account' }}
            </button>
          </div>
        </div>

        <!-- Only after the local home has been removed. "Add account" above
             makes a fresh empty config under ~/.wootonpad instead of attaching
             ~/.claude, so without this the removal would be a one-way door. -->
        <div v-if="!hasDefaultAccount" class="accounts-add-form accounts-restore-row">
          <span class="accounts-wsl-path">~/.claude (local Claude home)</span>
          <button class="btn-green" :disabled="restoring" @click="restoreDefault">
            {{ restoring ? 'Restoring…' : 'Restore' }}
          </button>
        </div>

        <div v-if="wslDistros.length" class="accounts-add-form accounts-wsl-section">
          <p class="accounts-add-desc">
            Claude also runs inside WSL. Attach an account to browse the sessions it
            stores there, alongside the ones on Windows. A distribution can hold
            several accounts — one per Claude config directory — and each is attached
            on its own.
          </p>
          <div v-for="home in wslHomes" :key="homeKey(home)" class="accounts-wsl-row">
            <span class="accounts-wsl-name">{{ home.distro }}</span>
            <span class="accounts-wsl-path">{{ home.claudePosix }}</span>
            <button
              class="btn-green"
              :disabled="addingWsl === homeKey(home) || hasWslAccount(home)"
              @click="addWslAccount(home)"
            >
              {{ hasWslAccount(home) ? 'Added' : (addingWsl === homeKey(home) ? 'Adding…' : 'Attach') }}
            </button>
          </div>

          <!-- Discovery only lists $HOME/.claude* directories that already hold a
               projects/ folder. A config kept elsewhere, or one Claude has not
               written to yet, has to be named. -->
          <div class="accounts-wsl-manual">
            <select v-model="manualDistro" class="accounts-wsl-distro">
              <option v-for="distro in wslDistros" :key="distro" :value="distro">{{ distro }}</option>
            </select>
            <input
              v-model="manualPath"
              class="accounts-wsl-manual-path"
              placeholder="/home/you/.claude-work"
              @keydown.enter="addManualWslAccount"
            />
            <button
              class="btn-green"
              :disabled="addingWsl === MANUAL || !manualPath.trim()"
              @click="addManualWslAccount"
            >
              {{ addingWsl === MANUAL ? 'Adding…' : 'Attach' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, nextTick } from 'vue';

const props = defineProps({
  callbacks: { type: Object, required: true },
});

const accounts = ref([]);
const activeAccountId = ref('default');
const usage = ref({});
const editingId = ref(null);
const editName = ref('');
let activeEditInput = null;
const newName = ref('');
const adding = ref(false);
const restoring = ref(false);
const addOpen = ref(false);
// Claude config directories reachable inside WSL, one row each — a distribution
// with two accounts contributes two. Empty off Windows.
const wslHomes = ref([]);
// Installed distributions. The section keys off this rather than off wslHomes,
// so a config directory discovery cannot see can still be typed in.
const wslDistros = ref([]);
// Which attach is in flight: a config directory path, or MANUAL for the form.
const addingWsl = ref(null);
const MANUAL = Symbol('manual');
const manualDistro = ref('');
const manualPath = ref('');
// Probing starts a distribution, so it happens once per window rather than on
// every accounts refresh — including when the answer is "none".
let wslHomesLoaded = false;

function hasUsage(id) {
  const u = usage.value[id];
  if (!u || u._error || u._rateLimited) return false;
  return u.session != null || u.weekAll != null;
}

function usageRows(id) {
  const u = usage.value[id] || {};
  const rows = [];
  if (u.session != null) rows.push({ key: 'session', label: '5h', pct: u.session, resetIn: u.sessionResetIn });
  if (u.weekAll != null) rows.push({ key: 'weekAll', label: '7d', pct: u.weekAll, resetIn: u.weekAllResetIn });
  return rows;
}

async function startEdit(acc) {
  editingId.value = acc.id;
  editName.value = acc.name;
  activeEditInput = null;
  await nextTick();
  activeEditInput?.focus();
  activeEditInput?.select();
}

async function saveEdit(acc) {
  if (editingId.value !== acc.id) return;
  editingId.value = null;
  const newN = editName.value.trim() || acc.name;
  if (newN !== acc.name) {
    acc.name = newN;
    await props.callbacks.renameAccount?.(acc.id, newN);
  }
}

function cancelEdit() {
  editingId.value = null;
}

async function onSwitch(acc) {
  if (acc.id !== activeAccountId.value) {
    await props.callbacks.switchAccount?.(acc.id);
  }
}

function onOpenClaude(acc) {
  props.callbacks.openAccountHomeSession?.(acc);
}

const hasDefaultAccount = computed(() => accounts.value.some(a => a.id === 'default'));

async function onDelete(acc) {
  // Worth saying out loud for the local home: what is removed is the app's link
  // to a config directory, never the directory itself.
  const note = acc.id === 'default'
    ? '\n\nThe ~/.claude directory itself is left alone and can be attached again.'
    : '';
  if (!confirm(`Remove account "${acc.name}"?${note}`)) return;
  props.callbacks.deleteAccount?.(acc.id);
}

async function restoreDefault() {
  restoring.value = true;
  try {
    await props.callbacks.restoreDefaultAccount?.();
  } finally {
    restoring.value = false;
  }
}

async function addAccount() {
  const name = newName.value.trim();
  if (!name) return;
  adding.value = true;
  const newAcc = await props.callbacks.createAccount?.(name);
  adding.value = false;
  if (newAcc) newName.value = '';
}

// What tells one discovered row from another. Not the config directory alone:
// two distributions with the same user both offer /home/<user>/.claude, which
// would collide as a v-for key and light up "Adding…" on both rows at once.
function homeKey(home) {
  return `${home.distro}:${home.claudePosix}`;
}

// An account belongs to a config directory, not to a distribution — the same
// distribution can hold several, and only the one already attached is "Added".
function hasWslAccount(home) {
  return accounts.value.some(
    a => a.wslDistro === home.distro && a.wslClaudePosix === home.claudePosix,
  );
}

async function attachWsl(distro, claudePosix, busyKey) {
  addingWsl.value = busyKey;
  try {
    const created = await props.callbacks.createWslAccount?.(distro, null, claudePosix);
    if (created?.error) alert(created.error);
    return created;
  } finally {
    addingWsl.value = null;
  }
}

function addWslAccount(home) {
  return attachWsl(home.distro, home.claudePosix, homeKey(home));
}

async function addManualWslAccount() {
  const claudePosix = manualPath.value.trim();
  const distro = manualDistro.value || wslDistros.value[0];
  if (!claudePosix || !distro) return;
  const created = await attachWsl(distro, claudePosix, MANUAL);
  if (created && !created.error) manualPath.value = '';
}

async function loadWslHomes() {
  if (wslHomesLoaded) return;
  wslHomesLoaded = true;
  try {
    const [homes, distros] = await Promise.all([
      props.callbacks.discoverWslClaudeHomes?.(),
      props.callbacks.listWslDistros?.(),
    ]);
    wslHomes.value = homes || [];
    wslDistros.value = distros || [];
    manualDistro.value = wslDistros.value[0] || '';
  } catch {
    wslHomes.value = [];
    wslDistros.value = [];
  }
}

defineExpose({
  setAccounts(list, activeId) {
    accounts.value = list;
    if (activeId !== undefined) activeAccountId.value = activeId;
    loadWslHomes();
  },
  setActiveAccount(id) { activeAccountId.value = id; },
  setUsage(usageObj) { usage.value = { ...usageObj }; },
});

const editSvg = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
const trashSvg = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>';
</script>
