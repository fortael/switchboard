<template>
  <div class="acct-viewer">
    <div class="acct-viewer__header">
      <SbIcon name="users" :size="14" tone="muted" />
      <span class="acct-viewer__title">{{ account?.name || 'Account' }}</span>
      <span v-if="detail?.isActive" class="acct-chip acct-chip--ok">Active</span>
      <span v-if="account?.wslDistro" class="acct-chip">WSL · {{ account.wslDistro }}</span>
      <span class="acct-viewer__spacer"></span>
      <button
        v-if="detail && !detail.isActive"
        class="acct-btn"
        @click="useAccount"
      >Use this account</button>
      <button
        class="acct-icon-btn"
        :class="{ 'acct-icon-btn--spin': loading }"
        data-tooltip="Reload"
        aria-label="Reload account"
        @click="reload"
      >
        <SbIcon name="refresh-cw" :size="13" tone="muted" />
      </button>
    </div>

    <div class="acct-viewer__body">
      <div v-if="!detail && !loading" class="acct-empty">Select an account in the sidebar.</div>
      <div v-else-if="!detail" class="acct-empty">Loading account…</div>

      <template v-else>
        <!-- ── Paths ─────────────────────────────────────────────── -->
        <section class="acct-section">
          <h3 class="acct-section__title">
            <SbIcon name="folder-open" :size="14" tone="muted" />
            Config directory
          </h3>
          <p class="acct-section__hint">
            Point another Claude instance at this account by setting
            <code class="acct-code">CLAUDE_CONFIG_DIR</code> to this path.
          </p>
          <div class="acct-path acct-path--primary">
            <span class="acct-path__value" :title="account.configDir">{{ account.configDir }}</span>
            <span v-if="!detail.configDirExists" class="acct-chip acct-chip--warn">missing</span>
            <button
              class="acct-copy"
              :class="{ 'acct-copy--done': copied === 'configDir' }"
              @click="copy('configDir', account.configDir)"
            >
              <SbIcon :name="copied === 'configDir' ? 'check' : 'copy'" :size="13" />
              {{ copied === 'configDir' ? 'Copied' : 'Copy' }}
            </button>
          </div>

          <div v-if="detail.launchCommand" class="acct-launch">
            <span class="acct-launch__label">Run the CLI as this account</span>
            <div class="acct-path acct-path--command">
              <code class="acct-path__value acct-path__value--mono" :title="detail.launchCommand">{{ detail.launchCommand }}</code>
              <button
                class="acct-copy"
                :class="{ 'acct-copy--done': copied === 'launch' }"
                @click="copy('launch', detail.launchCommand)"
              >
                <SbIcon :name="copied === 'launch' ? 'check' : 'copy'" :size="13" />
                {{ copied === 'launch' ? 'Copied' : 'Copy' }}
              </button>
            </div>
            <p v-if="account.wslDistro" class="acct-section__hint">
              Inside the distribution this home is already the default, so the command
              does not set <code class="acct-code">CLAUDE_CONFIG_DIR</code> — the Windows
              view of the path would not resolve there.
            </p>
          </div>

          <!-- The per-file paths live in Configuration below, next to the file
               they belong to; repeating them here was pure duplication. -->
        </section>

        <!-- ── Authorization ─────────────────────────────────────── -->
        <section class="acct-section">
          <h3 class="acct-section__title">
            <SbIcon name="key-round" :size="14" tone="muted" />
            Authorization
          </h3>
          <div class="acct-auth">
            <div class="acct-auth__row">
              <span class="acct-chip" :class="tokenChipClass">
                {{ detail.token.present ? 'Token on file' : 'No token' }}
              </span>
              <span v-if="detail.token.present && detail.token.source" class="acct-auth__meta">
                from {{ detail.token.source }}
              </span>
              <span v-if="detail.token.subscriptionType" class="acct-auth__meta">
                · {{ detail.token.subscriptionType }}
              </span>
              <span v-if="detail.token.expiresAt" class="acct-auth__meta">
                · {{ detail.token.expired ? 'expired' : 'expires' }} {{ formatWhen(detail.token.expiresAt) }}
              </span>
              <span class="acct-viewer__spacer"></span>
              <button class="acct-btn" :disabled="checking" @click="check">
                {{ checking ? 'Checking…' : 'Check' }}
              </button>
            </div>
            <div v-if="authResult" class="acct-auth__result" :class="'acct-auth__result--' + authTone">
              <SbIcon :name="authIcon" :size="14" />
              <span class="acct-auth__state">{{ AUTH_LABELS[authResult.state] || authResult.state }}</span>
              <span class="acct-auth__msg">{{ authResult.message }}</span>
            </div>
            <p v-else class="acct-section__hint">
              A token can sit on disk long after the API stops accepting it — check to be sure.
            </p>
          </div>
        </section>

        <!-- ── Usage ─────────────────────────────────────────────── -->
        <section v-if="usageCards.length" class="acct-section">
          <h3 class="acct-section__title">
            <SbIcon name="chart-no-axes-column" :size="14" tone="muted" />
            Rate limits
            <span v-if="usage._cached" class="acct-chip">cached</span>
          </h3>
          <div class="acct-usage">
            <div v-for="item in usageCards" :key="item.key" class="acct-usage__card">
              <div class="acct-usage__head">
                <span class="acct-usage__label">{{ item.label }}</span>
                <span class="acct-usage__pct">{{ item.pct }}%</span>
              </div>
              <div class="acct-usage__track">
                <div
                  class="acct-usage__fill"
                  :class="{ 'acct-usage__fill--high': item.pct >= 80 }"
                  :style="{ width: Math.max(Math.min(item.pct, 100), 1) + '%' }"
                ></div>
              </div>
              <div v-if="item.reset" class="acct-usage__reset">Resets {{ item.reset }}</div>
            </div>
          </div>
        </section>

        <!-- ── Activity ──────────────────────────────────────────── -->
        <section class="acct-section">
          <h3 class="acct-section__title">
            <SbIcon name="chart-no-axes-column" :size="14" tone="muted" />
            Activity
          </h3>
          <div v-if="statCards.length" class="acct-stats">
            <div v-for="card in statCards" :key="card.label" class="acct-stats__card">
              <span class="acct-stats__value">{{ card.value }}</span>
              <span class="acct-stats__label">{{ card.label }}</span>
            </div>
          </div>
          <div v-if="sparkCols.length" class="acct-spark">
            <div class="acct-spark__row">
              <div
                v-for="col in sparkCols"
                :key="col.date"
                class="acct-spark__col"
                :title="col.tooltip"
              >
                <div class="acct-spark__bar" :style="{ height: col.pct + '%' }"></div>
              </div>
            </div>
            <div class="acct-spark__caption">Messages per day, last 30 days</div>
          </div>
          <p v-if="!statCards.length" class="acct-section__hint">No recorded activity for this account yet.</p>
        </section>

        <!-- ── Config files ──────────────────────────────────────── -->
        <section class="acct-section">
          <h3 class="acct-section__title">
            <SbIcon name="file-json" :size="14" tone="muted" />
            Configuration
          </h3>

          <p v-if="!detail.files.length" class="acct-section__hint">
            No settings files in this config directory yet — Claude writes them on first run.
          </p>

          <template v-else>
            <div class="acct-tabs">
              <button
                v-for="f in detail.files"
                :key="f.name"
                class="acct-tabs__tab"
                :class="{ 'is-active': f.name === activeFile }"
                @click="openFile(f.name)"
              >
                {{ f.name }}
                <span class="acct-tabs__size">{{ formatBytes(f.size) }}</span>
              </button>
            </div>

            <div v-if="fileError" class="acct-file-error">{{ fileError }}</div>

            <div v-else-if="fileContent !== null" class="acct-file">
              <div class="acct-file__bar">
                <span class="acct-file__path" :title="filePath">{{ filePath }}</span>
                <span v-if="fileTruncated" class="acct-chip acct-chip--warn">truncated</span>
                <button
                  class="acct-copy"
                  :class="{ 'acct-copy--done': copied === 'json' }"
                  @click="copy('json', prettyJson)"
                >
                  <SbIcon :name="copied === 'json' ? 'check' : 'copy'" :size="13" />
                  {{ copied === 'json' ? 'Copied' : 'Copy JSON' }}
                </button>
              </div>
              <pre class="acct-json" v-html="highlightedJson"></pre>
              <button v-if="jsonClipped" class="acct-btn acct-btn--wide" @click="showAllJson = true">
                Show all {{ jsonLineCount.toLocaleString() }} lines
              </button>
            </div>
          </template>

          <!-- Files Claude keeps beside the home directory rather than inside
               the config dir. No tab: the guarded IPC deliberately refuses to
               read outside configDir, so only the path is offered. -->
          <div v-if="externalRows.length" class="acct-path-list">
            <div v-for="row in externalRows" :key="row.path" class="acct-path">
              <span class="acct-path__name">{{ row.name }}</span>
              <span class="acct-path__value" :title="row.path">{{ row.path }}</span>
              <span class="acct-path__meta" title="Outside the config directory — Switchboard offers the path but does not read it.">outside config dir</span>
              <span class="acct-path__meta">{{ formatBytes(row.size) }}</span>
              <button
                class="acct-copy"
                :class="{ 'acct-copy--done': copied === row.path }"
                @click="copy(row.path, row.path)"
              >
                <SbIcon :name="copied === row.path ? 'check' : 'copy'" :size="13" />
                {{ copied === row.path ? 'Copied' : 'Copy' }}
              </button>
            </div>
          </div>
        </section>
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';
import SbIcon from './SbIcon.vue';

// ── State ─────────────────────────────────────────────────────────
const accountId = ref(null);
const detail = ref(null);
const stats = ref(null);
const loading = ref(false);
const checking = ref(false);
const authResult = ref(null);
const copied = ref(null);
let copyTimer = null;

const activeFile = ref(null);
const fileContent = ref(null);
const filePath = ref('');
const fileTruncated = ref(false);
const fileError = ref('');
const showAllJson = ref(false);

const JSON_PREVIEW_LINES = 500;

const AUTH_LABELS = {
  authorized: 'Authorized',
  expired: 'Signed out',
  missing: 'No token',
  'rate-limited': 'Rate limited',
  network: 'Network error',
  error: 'API error',
  unknown: 'Unknown',
};

const account = computed(() => detail.value?.account || null);
const usage = computed(() => detail.value?.usage || {});

// ── Paths ─────────────────────────────────────────────────────────
// Files in the config dir, then the ones that live outside it (the default
// account's ~/.claude.json) — copyable either way, readable only inside.
const externalRows = computed(() => detail.value?.externalFiles || []);

// ── Auth ──────────────────────────────────────────────────────────
// A stored expiry in the past is not proof of being signed out — the CLI
// refreshes with the refresh token — so a lapsed token is amber, not green,
// and Check is what settles it.
const tokenChipClass = computed(() => {
  const t = detail.value?.token;
  if (!t?.present) return 'acct-chip--warn';
  return t.expired ? 'acct-chip--warn' : 'acct-chip--ok';
});

const authTone = computed(() => {
  const s = authResult.value?.state;
  if (s === 'authorized') return 'ok';
  if (s === 'expired' || s === 'missing') return 'bad';
  return 'warn';
});

const authIcon = computed(() => (authTone.value === 'ok' ? 'circle-check' : 'triangle-alert'));

// ── Usage ─────────────────────────────────────────────────────────
const USAGE_ITEMS = [
  { key: 'session', label: 'Current session', resetKey: 'sessionReset' },
  { key: 'weekAll', label: 'Week (all models)', resetKey: 'weekAllReset' },
  { key: 'weekSonnet', label: 'Week (Sonnet)', resetKey: 'weekSonnetReset' },
  { key: 'weekOpus', label: 'Week (Opus)', resetKey: 'weekOpusReset' },
];

const usageCards = computed(() => {
  const u = usage.value;
  if (!u || u._error || u._rateLimited) return [];
  return USAGE_ITEMS
    .filter(item => u[item.key] !== undefined && u[item.key] !== null)
    .map(item => ({ key: item.key, label: item.label, pct: u[item.key], reset: u[item.resetKey] || null }));
});

// ── Stats ─────────────────────────────────────────────────────────
// Same shape get-stats returns, so the two readings of "how much has this
// account been used" cannot drift apart.
function dailyMessageMap(s) {
  const raw = s?.dailyActivity || {};
  const map = {};
  if (Array.isArray(raw)) {
    for (const e of raw) map[e.date] = e.messageCount || 0;
  } else {
    for (const [date, data] of Object.entries(raw)) {
      map[date] = typeof data === 'number' ? data : (data?.messageCount || data?.messages || data?.count || 0);
    }
  }
  return map;
}

function currentStreak(map) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  let streak = 0;
  for (let i = 0; i < 365; i++) {
    const key = toDateStr(d);
    if (map[key] > 0) streak++;
    else if (i > 0 || streak > 0) break;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

const statCards = computed(() => {
  const s = stats.value;
  if (!s) return [];
  const map = dailyMessageMap(s);
  let messages = 0;
  for (const n of Object.values(map)) messages += n;
  if (s.totalMessages && s.totalMessages > messages) messages = s.totalMessages;
  const sessions = s.totalSessions || Object.keys(map).length;
  if (!sessions && !messages) return [];
  return [
    { value: sessions.toLocaleString(), label: 'Sessions' },
    { value: messages.toLocaleString(), label: 'Messages' },
    { value: currentStreak(map) + 'd', label: 'Current streak' },
    { value: Object.keys(map).length.toLocaleString(), label: 'Active days' },
  ];
});

function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const sparkCols = computed(() => {
  const s = stats.value;
  if (!s) return [];
  const map = dailyMessageMap(s);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    days.push(toDateStr(d));
  }
  const values = days.map(d => map[d] || 0);
  if (!values.some(v => v > 0)) return [];
  const max = Math.max(...values, 1);
  return days.map((date, i) => ({
    date,
    pct: values[i] > 0 ? Math.max((values[i] / max) * 100, 6) : 2,
    tooltip: `${date}: ${values[i]} messages`,
  }));
});

// ── JSON rendering ────────────────────────────────────────────────
const prettyJson = computed(() => {
  if (fileContent.value == null) return '';
  try {
    return JSON.stringify(JSON.parse(fileContent.value), null, 2);
  } catch {
    // Not valid JSON (or truncated mid-file) — show it verbatim rather than
    // pretending the file is fine.
    return fileContent.value;
  }
});

const jsonLineCount = computed(() => (prettyJson.value ? prettyJson.value.split('\n').length : 0));
const jsonClipped = computed(() => !showAllJson.value && jsonLineCount.value > JSON_PREVIEW_LINES);

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Token classes only — every value is escaped before a span is wrapped round it.
const JSON_TOKEN = /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"\s*:?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

const highlightedJson = computed(() => {
  let text = prettyJson.value;
  if (!text) return '';
  if (jsonClipped.value) {
    text = text.split('\n').slice(0, JSON_PREVIEW_LINES).join('\n') + '\n…';
  }
  return escapeHtml(text).replace(JSON_TOKEN, (m) => {
    let cls = 'num';
    if (m.startsWith('"')) cls = m.endsWith(':') ? 'key' : 'str';
    else if (m === 'true' || m === 'false') cls = 'bool';
    else if (m === 'null') cls = 'null';
    return `<span class="acct-json__${cls}">${m}</span>`;
  });
});

// ── Formatting ────────────────────────────────────────────────────
function formatBytes(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

function formatWhen(ms) {
  const d = new Date(ms);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// ── Actions ───────────────────────────────────────────────────────
async function copy(key, text) {
  try {
    await navigator.clipboard.writeText(text || '');
    copied.value = key;
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copied.value = null; }, 1600);
  } catch {}
}

function useAccount() {
  if (account.value) window.__sb?.switchAccount?.(account.value.id);
}

async function openFile(name) {
  activeFile.value = name;
  fileContent.value = null;
  fileError.value = '';
  fileTruncated.value = false;
  showAllJson.value = false;
  const res = await window.api.readAccountConfigFile(accountId.value, name);
  if (activeFile.value !== name) return;
  if (!res?.ok) {
    fileError.value = res?.error ? `Could not read ${name}: ${res.error}` : `Could not read ${name}.`;
    return;
  }
  filePath.value = res.path;
  fileTruncated.value = !!res.truncated;
  fileContent.value = res.content;
}

async function load(id) {
  if (!id) return;
  const changed = id !== accountId.value;
  accountId.value = id;
  if (changed) {
    detail.value = null;
    stats.value = null;
    authResult.value = null;
    activeFile.value = null;
    fileContent.value = null;
    fileError.value = '';
  }
  loading.value = true;
  try {
    const [d, s] = await Promise.all([
      window.api.getAccountDetail(id).catch(() => null),
      window.api.getAccountStats(id).catch(() => null),
    ]);
    if (accountId.value !== id) return;
    detail.value = d?.ok ? d : null;
    stats.value = s || null;
    const files = detail.value?.files || [];
    if (files.length && !files.some(f => f.name === activeFile.value)) {
      await openFile(files[0].name);
    }
  } finally {
    if (accountId.value === id) loading.value = false;
  }
}

function reload() {
  const id = accountId.value;
  accountId.value = null;
  load(id);
}

async function check() {
  if (!accountId.value || checking.value) return;
  checking.value = true;
  authResult.value = null;
  try {
    const res = await window.api.checkAccountAuth(accountId.value);
    authResult.value = res || { state: 'error', message: 'No response.' };
    if (res?.usage && Object.keys(res.usage).length && detail.value) {
      detail.value = { ...detail.value, usage: res.usage };
    }
  } catch (err) {
    authResult.value = { state: 'network', message: err?.message || 'Check failed.' };
  }
  checking.value = false;
}

defineExpose({ load, reload });
</script>
