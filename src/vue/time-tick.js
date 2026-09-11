import { ref } from 'vue';

// A single 30s heartbeat for every relative timestamp on screen.
//
// window.lastActivityTime is a plain Map that app.js mutates outside Vue, so a
// component reading it re-renders only when something else makes it. Reading
// `tick.value` in a computed subscribes it to this clock instead. One interval
// for the whole renderer: the board alone can draw fifty cards, and fifty
// intervals would each wake the process on its own schedule.
export const tick = ref(0);

setInterval(() => { tick.value++; }, 30000);
