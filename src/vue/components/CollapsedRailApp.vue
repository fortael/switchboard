<template>
  <div class="sbx-rail">
    <button class="sbx-rail__btn" title="Expand sidebar" @click="emit('expand')">
      <SbIcon name="panel-left-open" :size="17" tone="muted" />
    </button>
    <div class="sbx-rail__divider"></div>

    <div class="sbx-rail__nav">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        class="sbx-rail__btn"
        :class="{ 'is-active': tab.id === activeId }"
        :title="tab.label"
        @click="emit('select', tab.id)"
      >
        <SbIcon :name="tab.icon" :size="17" :tone="tab.id === activeId ? 'accent' : 'muted'" />
      </button>
    </div>

    <template v-if="projects.length">
      <div class="sbx-rail__divider"></div>
      <div class="sbx-rail__projects">
        <button
          v-for="p in projects"
          :key="p.projectPath"
          class="sbx-rail__project"
          :class="{ 'is-active': p.projectPath === activeProject }"
          :title="p.reason ? `${p.name} — ${p.reason}` : p.name"
          @click="emit('select-project', p.projectPath)"
        >
          <ProjectAvatar class="sbx-rail__avatar" :project-path="p.projectPath" />
          <span class="sbx-rail__dot" :style="{ background: statusColor(p.status) }"></span>
          <span v-if="p.count > 1" class="sbx-rail__count">{{ p.count }}</span>
        </button>
      </div>
    </template>

    <div class="sbx-rail__spacer" :class="{ 'is-flex': !projects.length }"></div>
    <button class="sbx-rail__btn" title="Global settings" @click="emit('settings')">
      <SbIcon name="settings" :size="17" tone="muted" />
    </button>
  </div>
</template>

<script setup>
import SbIcon from './SbIcon.vue';
import ProjectAvatar from './ProjectAvatar.vue';

defineProps({
  tabs: { type: Array, default: () => [] },
  activeId: { type: String, default: '' },
  // [{ projectPath, name, status, reason, count }]
  projects: { type: Array, default: () => [] },
  activeProject: { type: String, default: null },
});

const emit = defineEmits(['select', 'select-project', 'settings', 'expand']);

const STATUS_COLOR = {
  running: 'var(--status-running)',
  waiting: 'var(--amber-500)',
  done: 'var(--blue-500)',
  idle: 'var(--gray-500)',
};

function statusColor(status) {
  return STATUS_COLOR[status] || STATUS_COLOR.idle;
}
</script>
