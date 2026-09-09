<template>
  <svg
    class="sbx-ring"
    :class="toneClass"
    :width="size"
    :height="size"
    :viewBox="`0 0 ${BOX} ${BOX}`"
    role="img"
    :aria-label="label"
    :data-tooltip="label || undefined"
  >
    <circle
      class="sbx-ring__track"
      :cx="BOX / 2"
      :cy="BOX / 2"
      :r="radius"
      fill="none"
      :stroke-width="thickness"
    />
    <circle
      class="sbx-ring__fill"
      :cx="BOX / 2"
      :cy="BOX / 2"
      :r="radius"
      fill="none"
      :stroke-width="thickness"
      stroke-linecap="round"
      :stroke-dasharray="circumference"
      :stroke-dashoffset="offset"
      :transform="`rotate(-90 ${BOX / 2} ${BOX / 2})`"
    />
  </svg>
</template>

<script setup>
import { computed } from 'vue';

// Drawn in a fixed 24-unit box and scaled by `size`, so stroke widths stay
// proportional at any rendered size.
const BOX = 24;

const props = defineProps({
  // 0–100. Anything outside is clamped rather than drawn past full.
  value: { type: Number, default: 0 },
  size: { type: [Number, String], default: 14 },
  thickness: { type: Number, default: 4 },
  label: { type: String, default: '' },
});

const pct = computed(() => Math.min(100, Math.max(0, Number(props.value) || 0)));
const radius = computed(() => (BOX - props.thickness) / 2);
const circumference = computed(() => 2 * Math.PI * radius.value);
const offset = computed(() => circumference.value * (1 - pct.value / 100));

// Thresholds, not a gradient: the ring is a warning device, and three states
// read faster at 14px than a continuous hue ramp.
const toneClass = computed(() => {
  if (pct.value >= 90) return 'sbx-ring--danger';
  if (pct.value >= 70) return 'sbx-ring--warn';
  return 'sbx-ring--ok';
});
</script>
