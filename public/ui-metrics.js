// --- UI typography metrics ---
//
// One knob per axis, applied as CSS custom properties on <html>:
//
//   --ui-scale     multiplier the --text-* scale in style.css is expressed in
//   --ui-leading   the value --leading-normal resolves to
//
// Terminal metrics are not CSS — xterm takes concrete numbers — so they go
// through window._applyTerminalMetrics in terminal-manager.js instead.
//
// Loaded as a classic script before app.js so the metrics are in place before
// the first terminal is constructed.

const UI_METRIC_DEFAULTS = {
  uiFontSize: 13,          // px; the reference size --ui-scale is measured against
  uiLineHeight: 1.55,      // matches the design system's --leading-normal
  terminalFontSize: 12,
  terminalLineHeight: 1.25,
};

window.UI_METRIC_DEFAULTS = UI_METRIC_DEFAULTS;

const UI_FONT_SIZE_REFERENCE = 13;

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

window._applyUiMetrics = (settings = {}) => {
  const uiFontSize = clampNumber(settings.uiFontSize, 10, 20, UI_METRIC_DEFAULTS.uiFontSize);
  const uiLineHeight = clampNumber(settings.uiLineHeight, 1.1, 2.2, UI_METRIC_DEFAULTS.uiLineHeight);
  const root = document.documentElement;
  root.style.setProperty('--ui-scale', String(uiFontSize / UI_FONT_SIZE_REFERENCE));
  root.style.setProperty('--ui-leading', String(uiLineHeight));

  window._applyTerminalMetrics?.({
    fontSize: clampNumber(settings.terminalFontSize, 8, 24, UI_METRIC_DEFAULTS.terminalFontSize),
    lineHeight: clampNumber(settings.terminalLineHeight, 1, 2.2, UI_METRIC_DEFAULTS.terminalLineHeight),
  });
};

// No self-boot on purpose. public/app.js calls _applyUiMetrics from the single
// settings read it already does, which runs before any terminal exists — a
// second, later read here would refit live terminals and scramble whatever the
// CLI had already drawn.
