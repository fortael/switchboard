// Age → opacity for a session card.
//
// A session nobody has touched in a day fades to 30% and stops there; the point
// is to see at a glance which work is still warm, not to make old cards
// unreadable. Shared so the board and a project's Sessions tab fade on exactly
// the same ladder.
const FRESHNESS_STEPS = [
  [10 * 60 * 1000, 0.9],
  [30 * 60 * 1000, 0.8],
  [60 * 60 * 1000, 0.7],
  [3 * 60 * 60 * 1000, 0.6],
  [6 * 60 * 60 * 1000, 0.5],
  [12 * 60 * 60 * 1000, 0.4],
  [24 * 60 * 60 * 1000, 0.3],
];

export function freshnessOpacity(time) {
  const age = Date.now() - new Date(time).getTime();
  if (!Number.isFinite(age)) return 1;
  let opacity = 1;
  for (const [threshold, value] of FRESHNESS_STEPS) {
    if (age > threshold) opacity = value;
  }
  return opacity;
}
