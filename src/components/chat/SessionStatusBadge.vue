<script setup lang="ts">
import OpusIcon from '../ui/OpusIcon.vue'

defineProps<{ status: { key: string; label: string }; compact?: boolean }>()

const icons = {
  approval: 'shield', input: 'chat', waiting: 'wifiOff', queued: 'tasks', todo: 'tasks',
  snoozed: 'moon', settled: 'layers', archived: 'folder',
} as const
</script>

<template>
  <span v-if="status.key !== 'done'" class="session-state" :class="[`is-${status.key}`, { 'is-compact': compact }]">
    <svg v-if="status.key === 'running'" class="state-icon state-wave" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2" y="5" width="2.5" height="6" rx="1.25" />
      <rect x="6.75" y="2" width="2.5" height="12" rx="1.25" />
      <rect x="11.5" y="4" width="2.5" height="8" rx="1.25" />
    </svg>
    <svg v-else-if="status.key === 'complete'" class="state-icon state-check" viewBox="0 0 16 16" aria-hidden="true">
      <path d="m3 8 3 3 7-7" pathLength="1" />
    </svg>
    <OpusIcon v-else :name="icons[status.key as keyof typeof icons] ?? 'check'" class="state-icon" />
    {{ status.label }}
  </span>
</template>

<style scoped>
.session-state {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 26px;
  padding: 3px 9px;
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--text-2);
  font-size: calc(12px * var(--fs));
  font-weight: 560;
  line-height: 1.3;
  white-space: nowrap;
}
.session-state.is-compact { gap: 4px; min-height: 21px; padding: 2px 6px; font-size: calc(11px * var(--fs)); }
.session-state.is-complete { color: var(--ok); background: var(--ok-soft); }
.session-state.is-running, .session-state.is-input { color: var(--accent); background: var(--accent-soft); }
.session-state.is-approval { color: var(--warn); background: var(--warn-soft); }
.state-icon { width: 14px; height: 14px; flex: none; }
.is-compact .state-icon { width: 12px; height: 12px; }
.state-wave { fill: currentColor; }
.state-check { fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
@media (prefers-reduced-motion: no-preference) {
  .state-wave rect { transform-box: fill-box; transform-origin: center; animation: session-wave 1.05s ease-in-out infinite; }
  .state-wave rect:nth-child(2) { animation-delay: -.23s; }
  .state-wave rect:nth-child(3) { animation-delay: -.46s; }
  :is(.is-input, .is-approval) .state-icon { animation: session-attention 2.1s ease-in-out infinite; }
  .state-check path { animation: session-check .48s ease-out both; }
}
@keyframes session-wave {
  0%, 100% { transform: scaleY(.58); opacity: .65; }
  50% { transform: scaleY(1); opacity: 1; }
}
@keyframes session-attention {
  0%, 75%, 100% { transform: scale(1); }
  25% { transform: scale(1.14); }
}
@keyframes session-check {
  from { stroke-dasharray: 1; stroke-dashoffset: 1; }
  to { stroke-dasharray: 1; stroke-dashoffset: 0; }
}
:global([data-motion="reduced"]) :is(.state-wave rect, .state-icon, .state-check path) { animation: none; }
</style>
