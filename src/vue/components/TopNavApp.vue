<template>
  <div class="sbx-topnav">
    <div v-if="$slots.account" class="sbx-topnav__account">
      <slot name="account" />
    </div>

    <div class="sbx-topnav__tabs">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        class="sbx-topnav__tab"
        :class="{ 'is-active': tab.id === activeId }"
        :title="tab.label"
        @click="emit('select', tab.id)"
      >
        <SbIcon :name="tab.icon" :size="14" :tone="tab.id === activeId ? 'accent' : 'muted'" />
        <span class="sbx-topnav__tab-label">{{ tab.label }}</span>
        <span v-if="tab.badge" class="sbx-topnav__tab-badge">{{ tab.badge }}</span>
        <span class="sbx-topnav__tab-underline"></span>
      </button>
    </div>

    <div class="sbx-topnav__utils">
      <button
        class="sbx-topnav__util"
        :title="theme === 'light' ? 'Dark theme' : 'Light theme'"
        @click="emit('toggle-theme')"
      >
        <SbIcon :name="theme === 'light' ? 'moon' : 'sun'" :size="14" tone="muted" />
      </button>
      <button class="sbx-topnav__util" title="Global settings" @click="emit('settings')">
        <SbIcon name="settings" :size="14" tone="muted" />
      </button>
      <button
        v-if="canToggleSidebar"
        class="sbx-topnav__util"
        :title="sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'"
        @click="emit('toggle-sidebar')"
      >
        <SbIcon :name="sidebarCollapsed ? 'panel-left-open' : 'panel-left-close'" :size="14" tone="muted" />
      </button>
    </div>
  </div>
</template>

<script setup>
import SbIcon from './SbIcon.vue';

defineProps({
  // [{ id, icon, label, badge? }] — empty while the CollapsedRail carries navigation
  tabs: { type: Array, default: () => [] },
  activeId: { type: String, default: '' },
  theme: { type: String, default: 'dark' },
  sidebarCollapsed: { type: Boolean, default: false },
  // The board owns the full width; there is no sidebar to summon there.
  canToggleSidebar: { type: Boolean, default: true },
});

const emit = defineEmits(['select', 'settings', 'toggle-sidebar', 'toggle-theme']);
</script>
