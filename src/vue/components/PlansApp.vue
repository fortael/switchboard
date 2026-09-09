<template>
  <div>
    <!-- Plans follow the active account, so name the directory that was
         actually searched instead of the default ~/.claude one. -->
    <div v-if="plans.length === 0" class="plans-empty">
      <div>No plans for <strong>{{ plansDir.accountName || 'this account' }}</strong>.</div>
      <button
        v-if="plansDir.dir"
        type="button"
        class="plans-empty-path"
        :data-tooltip="plansDir.exists ? 'Copy path' : 'Directory does not exist yet — copy path'"
        @click="copyPlansDir"
      >{{ copied ? 'Copied' : plansDir.dir }}</button>
    </div>

    <div v-else class="project-group">
      <div class="project-header">
        <span class="project-name">Plans</span>
      </div>
      <div class="project-sessions">
        <ListItem
          v-for="plan in plans"
          :key="plan.filename"
          :title="plan.title || plan.filename"
          :subtitle="plan.filename"
          :meta="fmtDate(plan.modified)"
          :active="activePlan === plan.filename"
          :classes="['plan-item']"
          @click="openPlan(plan)"
        >
          <template #leading>
            <span class="memory-brain-icon" v-html="planSvg"></span>
          </template>
        </ListItem>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue';
import ListItem from './ListItem.vue';

const props = defineProps({
  callbacks: { type: Object, required: true },
});

const plans = ref([]);
const activePlan = ref(null);
const plansDir = ref({ dir: '', exists: false, accountName: '' });
const copied = ref(false);

async function refreshPlansDir() {
  plansDir.value = (await window.api?.getPlansDir?.().catch(() => null)) || plansDir.value;
}

// Only needed while the list is empty, and the account may have changed since
// the last look.
watch(plans, (list) => { if (!list.length) refreshPlansDir(); }, { immediate: true });

async function copyPlansDir() {
  try {
    await navigator.clipboard.writeText(plansDir.value.dir);
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 1200);
  } catch {}
}

function fmtDate(d) {
  return window.formatDate ? window.formatDate(new Date(d)) : d;
}

function openPlan(plan) {
  activePlan.value = plan.filename;
  props.callbacks.openPlan?.(plan);
}

// Bridge API
defineExpose({
  setPlans(list) { plans.value = list; },
  setActive(filename) { activePlan.value = filename; },
  clearActive() { activePlan.value = null; },
});

const planSvg = '<svg width="15" height="15" viewBox="0 0 17 17" fill="currentColor" stroke="currentColor" stroke-width="0"><path d="M14 2v-2h-13v17h13v-2h2v-13h-2zM2 16v-15h2v15h-2zM13 16h-8v-15h8v15zM15 14h-1v-3h1v3zM15 10h-1v-3h1v3zM14 6v-3h1v3h-1zM6 4h5v1h-5v-1zM6 6h4v1h-4v-1z"/></svg>';
</script>
