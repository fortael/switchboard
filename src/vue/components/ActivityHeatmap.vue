<template>
  <div class="heatmap-container">
    <div class="heatmap-month-labels">
      <span
        v-for="ml in monthLabels"
        :key="ml.key"
        class="heatmap-month-label"
        :style="{ left: ml.left }"
      >{{ ml.label }}</span>
    </div>
    <div class="heatmap-grid-wrapper">
      <div class="heatmap-day-labels">
        <div v-for="(name, i) in DAY_NAMES" :key="i" class="heatmap-day-label">{{ name }}</div>
      </div>
      <div class="heatmap-grid">
        <div
          v-for="cell in cells"
          :key="cell.dateStr"
          :class="['heatmap-cell', 'heatmap-level-' + cell.level]"
          :title="cell.title"
        ></div>
      </div>
    </div>
    <div class="heatmap-legend">
      <span class="heatmap-legend-label">Less</span>
      <div v-for="i in [0, 1, 2, 3, 4]" :key="i" :class="['heatmap-legend-cell', 'heatmap-level-' + i]"></div>
      <span class="heatmap-legend-label">More</span>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  // date string (YYYY-MM-DD) → message count for that day.
  dailyMap: { type: Object, default: () => ({}) },
});

// Blank rows are deliberate: labelling every weekday would crowd 13px cells.
const DAY_NAMES = ['', 'Mon', '', 'Wed', '', 'Fri', ''];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const COL_WIDTH = 16; // 13px cell + 3px gap

// A year of whole weeks ending on today's column, so the grid always starts on
// a Sunday and the day-of-week rows line up.
function windowStart() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - (52 * 7 + today.getDay()));
  return { today, start };
}

const monthLabels = computed(() => {
  const { today, start } = windowStart();
  const labels = [];
  let lastMonth = -1;
  let week = 0;
  const cursor = new Date(start);
  while (cursor <= today) {
    if (cursor.getDay() === 0) {
      const m = cursor.getMonth();
      if (m !== lastMonth) {
        labels.push({ key: week + '-' + m, label: MONTHS[m], left: (week * COL_WIDTH) + 'px' });
        lastMonth = m;
      }
      week++;
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return labels;
});

const cells = computed(() => {
  const map = props.dailyMap || {};
  // Quartiles over the days that had activity, so a quiet account still gets
  // four visible shades instead of everything landing on level 1.
  const nonZero = Object.values(map).filter(c => c > 0).sort((a, b) => a - b);
  const q1 = nonZero[Math.floor(nonZero.length * 0.25)] || 1;
  const q2 = nonZero[Math.floor(nonZero.length * 0.5)] || 2;
  const q3 = nonZero[Math.floor(nonZero.length * 0.75)] || 3;

  const { today, start } = windowStart();
  const out = [];
  const cursor = new Date(start);
  while (cursor <= today) {
    const dateStr = toDateStr(cursor);
    const count = map[dateStr] || 0;
    let level = 0;
    if (count > 0) {
      if (count <= q1) level = 1;
      else if (count <= q2) level = 2;
      else if (count <= q3) level = 3;
      else level = 4;
    }
    const shown = cursor.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    out.push({
      dateStr,
      level,
      title: count > 0 ? `${shown}: ${count} messages` : `${shown}: No activity`,
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
});

// Local date, not toISOString — the latter shifts by the UTC offset and would
// put a whole day's activity in the wrong cell west of Greenwich.
function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
</script>
