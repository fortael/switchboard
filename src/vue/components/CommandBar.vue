<template>
  <div class="sbx-commandbar">
    <div class="sbx-commandbar__field">
      <SbIcon name="search" :size="13" tone="muted" />
      <input
        class="sbx-commandbar__input"
        type="text"
        :value="modelValue"
        :placeholder="placeholder"
        @input="$emit('update:modelValue', $event.target.value)"
        @keydown.enter.prevent="$emit('spotlight')"
      >
      <slot name="field-actions" />
      <button
        type="button"
        class="sbx-commandbar__chip"
        title="Open spotlight"
        @click="$emit('spotlight')"
      >⌘K</button>
    </div>
    <button
      type="button"
      class="sbx-commandbar__add"
      :title="addTitle"
      :aria-label="addTitle"
      @click="$emit('add')"
    >
      <SbIcon name="plus" :size="14" />
    </button>
  </div>
</template>

<script setup>
import SbIcon from './SbIcon.vue';

defineProps({
  modelValue: { type: String, default: '' },
  placeholder: { type: String, default: 'Search or jump to…' },
  addTitle: { type: String, default: 'New session' },
});

defineEmits(['update:modelValue', 'add', 'spotlight']);
</script>
