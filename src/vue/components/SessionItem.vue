<template>
  <div
    class="session-item"
    :class="itemClasses"
    :id="'si-' + session.sessionId"
    :data-session-id="session.sessionId"
    @click="$emit('open', session)"
  >
    <div class="session-row">
      <span class="session-status-dot" :class="{ running: isRunning }"></span>

      <div class="session-info">
        <div class="session-summary">
          <!-- eslint-disable-next-line vue/no-v-html -->
          <span v-if="session.type === 'terminal'" class="terminal-badge" v-html="terminalBadgeSvg"></span>
          {{ displayName }}
        </div>
        <div v-if="session.aiTitle" class="session-subtitle">{{ cleanName(session.aiTitle) }}</div>
        <div class="session-meta">
          <UsageRing
            v-if="contextPct !== null"
            class="session-context-ring"
            :value="contextPct"
            :size="11"
            :label="contextLabel"
          />
          <!-- app.js's 30s timeago tick writes into this span by class. It must
               stay a separate element: textContent on .session-meta would wipe
               the ring beside it. -->
          <span class="session-meta-text">{{ timeStr }}{{ msgSuffix }}</span>
        </div>
      </div>

      <!-- One menu instead of the five hover buttons this row used to carry —
           the same menu the board's cards open, so an action is in one place
           whichever view you are looking at. Renaming is in there too: the
           board has no row to double-click. -->
      <div class="session-actions">
        <SessionMenu :session="session" :is-running="isRunning" />
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import UsageRing from './UsageRing.vue';
import SessionMenu from './SessionMenu.vue';
import { contextPercent, formatContextLabel } from '../context-window.js';

const props = defineProps({
  session: { type: Object, required: true },
  isActive: Boolean,
  isRunning: Boolean,
  isBusy: Boolean,
  isAttention: Boolean,
  isResponseReady: Boolean,
});

// Everything else a row can do lives in SessionMenu, which calls the app.js
// bridge directly rather than emitting up through the list.
defineEmits(['open']);

const contextPct = computed(() => contextPercent(props.session.contextTokens, props.session));
const contextLabel = computed(() => formatContextLabel(props.session.contextTokens, props.session));

const displayName = computed(() => {
  const name = props.session.name || props.session.summary;
  return window.cleanDisplayName ? window.cleanDisplayName(name) : name;
});

const cleanName = (n) => window.cleanDisplayName ? window.cleanDisplayName(n) : n;

const timeStr = computed(() => {
  const t = window.lastActivityTime?.get(props.session.sessionId) || new Date(props.session.modified);
  return window.formatDate ? window.formatDate(t) : '';
});

const msgSuffix = computed(() =>
  props.session.messageCount ? ` · ${props.session.messageCount} msgs` : ''
);

const itemClasses = computed(() => ({
  active: props.isActive,
  'has-running-pty': props.isRunning,
  'cli-busy': props.isBusy,
  'needs-attention': props.isAttention,
  'response-ready': props.isResponseReady,
  'is-pinned': !!props.session.starred,
  'archived-item': !!props.session.archived,
  'is-terminal': props.session.type === 'terminal',
}));

// The only inline glyph this row still owns; the menu's icons come from SbIcon.
const terminalBadgeSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>';
</script>
