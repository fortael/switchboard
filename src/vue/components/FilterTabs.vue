<template>
  <div class="sbx-filtertabs">
    <button
      v-for="tab in tabs"
      :key="tab.id"
      type="button"
      class="sbx-filtertabs__tab"
      :class="{ 'sbx-filtertabs__tab--active': tab.id === active }"
      :aria-pressed="tab.id === active"
      @click="$emit('select', tab.id)"
    >
      {{ tab.label }}
      <span class="sbx-filtertabs__underline"></span>
    </button>
    <div class="sbx-filtertabs__spacer"></div>
    <div class="sbx-filtertabs__views">
      <slot name="actions" />
      <button
        v-for="view in VIEWS"
        :key="view.id"
        type="button"
        class="sbx-filtertabs__view"
        :class="{ 'sbx-filtertabs__view--active': viewMode === view.id }"
        :title="view.title"
        :aria-label="view.title"
        :aria-pressed="viewMode === view.id"
        @click="$emit('update:viewMode', view.id)"
      >
        <SbIcon :name="view.icon" :size="13" :tone="viewMode === view.id ? 'accent' : 'muted'" />
      </button>
    </div>
  </div>
</template>

<script setup>
import SbIcon from './SbIcon.vue';

defineProps({
  // [{ id, label }]
  tabs: { type: Array, default: () => [] },
  active: { type: String, default: '' },
  viewMode: { type: String, default: 'list' }, // list | grid
});

defineEmits(['select', 'update:viewMode']);

const VIEWS = [
  { id: 'list', icon: 'list', title: 'List view' },
  { id: 'grid', icon: 'layout-grid', title: 'Grid view' },
];
</script>
