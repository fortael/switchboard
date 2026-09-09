<template>
  <svg
    class="sb-icon"
    :class="toneClass"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    v-html="body"
  ></svg>
</template>

<script setup>
import { computed } from 'vue';
import { LUCIDE } from '../lucide-icons.js';

const props = defineProps({
  name: { type: String, required: true },
  size: { type: [Number, String], default: 16 },
  // default | muted | bright | accent | running | danger — maps to a colour
  // class in style.css. Inline SVG uses currentColor, so no filter hacks.
  tone: { type: String, default: 'default' },
  strokeWidth: { type: [Number, String], default: 1.75 },
});

const body = computed(() => LUCIDE[props.name] || '');
const toneClass = computed(() => (props.tone === 'default' ? '' : `sb-icon--${props.tone}`));
</script>
