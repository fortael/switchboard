<template>
  <div v-if="rows.length" class="sbx-attention">
    <div class="sbx-attention__header">
      <span class="sbx-attention__dot"></span>
      <span class="sbx-attention__label">Active now</span>
      <div class="sbx-attention__spacer"></div>
      <span class="sbx-attention__count">{{ rows.length }}</span>
    </div>
    <div class="sbx-attention__rail">
      <button
        v-for="row in rows"
        :key="row.key"
        type="button"
        class="sbx-attention__avatar"
        :class="[
          `sbx-attention__avatar--${row.status}`,
          { 'sbx-attention__avatar--open': row.name === activeName },
        ]"
        :title="row.title"
        @click="$emit('select', row.name)"
      >
        <span class="sbx-attention__monogram">{{ row.initials }}</span>
        <span class="sbx-attention__meta">
          <span class="sbx-attention__name">{{ row.name }}</span>
          <span class="sbx-attention__reason">{{ row.reason }}</span>
        </span>
        <span v-if="row.count > 0" class="sbx-attention__badge">{{ row.count }}</span>
      </button>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const STATUSES = ['running', 'waiting', 'done', 'idle'];

const props = defineProps({
  // [{ name, projectPath, reason, status, count }]
  items: { type: Array, default: () => [] },
  activeName: { type: String, default: '' },
});

defineEmits(['select']);

const rows = computed(() => (props.items || []).map((item) => {
  const name = item.name || '';
  const reason = item.reason || '';
  return {
    key: item.projectPath || name,
    name,
    reason,
    status: STATUSES.includes(item.status) ? item.status : 'idle',
    count: Number(item.count) || 0,
    initials: name.replace(/[^a-z]/gi, '').slice(0, 2).toLowerCase(),
    title: reason ? `${name} — ${reason}` : name,
  };
}));
</script>
