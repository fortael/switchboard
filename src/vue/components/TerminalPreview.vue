<template>
  <div class="sbx-termpreview">
    <div class="sbx-termpreview__chrome">
      <span class="sbx-termpreview__label">Preview</span>
      <span class="sbx-termpreview__meta">{{ themeLabel }} · {{ fontLabel }}</span>
    </div>
    <div v-if="unavailable" class="sbx-termpreview__fallback">
      Terminal preview unavailable.
    </div>
    <div v-else ref="hostEl" class="sbx-termpreview__host"></div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';

const props = defineProps({
  themeKey: { type: String, default: '' },
  fontKey: { type: String, default: 'default' },
  fontSize: { type: Number, default: 12 },
});

const hostEl = ref(null);
const unavailable = ref(false);
let term = null;

const theme = computed(() => window.TERMINAL_THEMES?.[props.themeKey] || null);
const font = computed(() => window.TERMINAL_FONTS?.[props.fontKey] || window.TERMINAL_FONTS?.default || null);
const themeLabel = computed(() => theme.value?.label || '—');
const fontLabel = computed(() => font.value?.label || '—');

// Exercises the full 16-colour palette plus the bold/dim attributes the CLI
// actually uses, so a theme's weak spots show up here rather than in a session.
const E = '\x1b[';
const SAMPLE = [
  `${E}1;34m~/Projects/switchboard${E}0m ${E}35m main${E}0m ${E}90m(+2 −1)${E}0m`,
  `${E}33m❯${E}0m npm test`,
  `${E}90m  › node --test --test-timeout=60000${E}0m`,
  `  ${E}32m✔${E}0m tests 65   ${E}32mpass 65${E}0m   ${E}31mfail 0${E}0m   ${E}90m1.3s${E}0m`,
  '',
  `${E}36m∴${E}0m Updated ${E}1mterminal-themes.js${E}0m — added the design-system palette`,
  `${E}32m+  wootonpadDark: { label: 'WootonPad Dark', mode: 'dark' }${E}0m`,
  `${E}31m−  switchboard:    { label: 'WootonPad' }${E}0m`,
  '',
  `  ${E}30m███${E}31m███${E}32m███${E}33m███${E}34m███${E}35m███${E}36m███${E}37m███${E}0m  normal`,
  `  ${E}90m███${E}91m███${E}92m███${E}93m███${E}94m███${E}95m███${E}96m███${E}97m███${E}0m  bright`,
  '',
  `${E}33m❯${E}0m `,
].join('\r\n');

function render() {
  if (!term) return;
  term.reset();
  term.write(SAMPLE);
}

onMounted(() => {
  if (!window.Terminal || !hostEl.value) { unavailable.value = true; return; }
  term = new window.Terminal({
    cols: 76,
    rows: 13,
    fontSize: props.fontSize,
    fontFamily: font.value?.family,
    theme: theme.value || undefined,
    cursorBlink: true,
    disableStdin: true,
    scrollback: 0,
    convertEol: true,
  });
  term.open(hostEl.value);
  render();
});

onBeforeUnmount(() => {
  term?.dispose();
  term = null;
});

watch(theme, (next) => {
  if (term && next) term.options.theme = next;
});

watch(font, (next) => {
  if (term && next?.family) term.options.fontFamily = next.family;
});

watch(() => props.fontSize, (next) => {
  if (term && next) term.options.fontSize = next;
});
</script>
