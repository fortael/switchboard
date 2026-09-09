<template>
  <div v-if="store.headerSession" class="sbx-sesshead">
    <div class="sbx-sesshead__identity">
      <ProjectAvatar class="sbx-sesshead__avatar" :project-path="session.projectPath" />

      <span class="sbx-sesshead__title" :title="sessionName">{{ sessionName }}</span>

      <span class="sbx-sesshead__sep">·</span>

      <span class="sbx-sesshead__project" :title="session.projectPath">{{ projectShortPath }}</span>

      <span v-if="sessionId" class="sbx-sesshead__id" :title="sessionId">{{ shortId }}</span>

      <span v-if="aiTitle" class="sbx-sesshead__ai" :title="aiTitle">{{ aiTitle }}</span>
    </div>

    <div class="sbx-sesshead__controls">
      <span v-if="messageCount || timeStr" class="sbx-sesshead__meta">
        <span v-if="messageCount">{{ messageCount }} msgs</span>
        <span v-if="messageCount && timeStr" class="sbx-sesshead__meta-sep">·</span>
        <span v-if="timeStr">{{ timeStr }}</span>
      </span>

      <span class="sbx-sesshead__badge" :class="statusClass">
        <span class="sbx-sesshead__dot"></span>
        <span class="sbx-sesshead__badge-label">{{ statusLabel }}</span>
      </span>

      <span
        v-if="store.headerAccount"
        class="sbx-sesshead__chip"
        :title="store.headerAccount"
      >{{ store.headerAccount }}</span>

      <span
        v-if="store.headerShellProfile"
        class="sbx-sesshead__chip sbx-sesshead__chip--mono"
        :title="store.headerShellProfile"
      >{{ store.headerShellProfile }}</span>

      <span
        v-if="store.headerPtyTitle"
        class="sbx-sesshead__chip sbx-sesshead__chip--mono sbx-sesshead__chip--pty"
        :title="store.headerPtyTitle"
      >{{ store.headerPtyTitle }}</span>

      <!-- Opens the panel on the right: this session's uncommitted changes,
           its compose services and a scratch shell in its own directory. -->
      <button
        type="button"
        class="sbx-sesshead__iconbtn"
        :class="{ 'is-active': store.sidePanelOpen }"
        :data-tooltip="store.sidePanelOpen ? 'Hide project panel' : 'Project panel — changes, containers, shell'"
        :aria-pressed="store.sidePanelOpen"
        @click="toggleSidePanel"
      >
        <SbIcon :name="store.sidePanelOpen ? 'panel-right-close' : 'panel-right-open'" :size="14" />
      </button>

      <button
        type="button"
        class="sbx-sesshead__iconbtn sbx-sesshead__iconbtn--danger"
        data-tooltip="Stop session"
        @click="stop"
      >
        <SbIcon name="square" :size="14" />
      </button>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { store } from '../store.js';
import ProjectAvatar from './ProjectAvatar.vue';
import SbIcon from './SbIcon.vue';

const session = computed(() => store.headerSession);
const sessionId = computed(() => session.value?.sessionId);

const projectShortPath = computed(() => {
  const p = session.value?.projectPath || '';
  return p.split('/').filter(Boolean).slice(-2).join('/');
});

const sessionName = computed(() => {
  const s = session.value;
  if (!s) return '';
  const name = s.name || s.summary || 'Session';
  return window.cleanDisplayName ? window.cleanDisplayName(name) : name;
});

const aiTitle = computed(() => {
  const s = session.value;
  if (!s?.aiTitle) return null;
  const cleaned = window.cleanDisplayName ? window.cleanDisplayName(s.aiTitle) : s.aiTitle;
  return cleaned !== sessionName.value ? cleaned : null;
});

const isRunning = computed(() => store.activePtyIds?.has(sessionId.value));
const isBusy = computed(() => store.sessionBusyState?.get(sessionId.value) || false);
const isAttention = computed(() => store.attentionSessions?.has(sessionId.value));

const statusClass = computed(() => ({
  'is-running': isRunning.value,
  'is-busy': isBusy.value,
  'is-attention': isAttention.value,
}));

const statusLabel = computed(() => {
  if (isAttention.value) return 'Needs attention';
  if (isBusy.value) return 'Working…';
  if (isRunning.value) return 'Running';
  return 'Stopped';
});

const messageCount = computed(() => session.value?.messageCount || null);

const timeStr = computed(() => {
  const s = session.value;
  if (!s) return '';
  const t = window.lastActivityTime?.get(s.sessionId) || new Date(s.modified);
  return window.formatDate ? window.formatDate(t) : '';
});

const shortId = computed(() => {
  const id = sessionId.value || '';
  return id.slice(0, 8);
});

function stop() {
  if (sessionId.value && window.confirmAndStopSession) {
    window.confirmAndStopSession(sessionId.value);
  }
}

// App.vue watches store.sidePanelOpen and refits the terminals — the panel
// takes width away from them, and xterm has to be told.
function toggleSidePanel() {
  store.sidePanelOpen = !store.sidePanelOpen;
  localStorage.setItem('sessionSidePanelOpen', store.sidePanelOpen ? '1' : '0');
}
</script>
