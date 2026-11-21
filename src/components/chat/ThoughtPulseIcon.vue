<script setup lang="ts">
defineProps<{ active?: boolean }>()

const waveform = 'M3 13h2.5l2.25-4 3.75 8.5 3.5-10 2.5 5.5H21'
</script>

<template>
  <svg class="i thought-pulse" :class="{ 'is-active': active }" viewBox="0 0 24 24" aria-hidden="true">
    <path class="pulse-trace" :d="waveform" />
    <circle cx="6" cy="5" r="1.2" />
    <circle cx="18" cy="19" r="1.2" />
    <path v-if="active" class="pulse-highlight" :d="waveform" pathLength="100" />
  </svg>
</template>

<style scoped>
.thought-pulse {
  flex: none;
  color: var(--accent);
  fill: none;
  stroke: currentColor;
  stroke-width: 1.65;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.thought-pulse circle { fill: currentColor; stroke: none; }
.pulse-highlight { opacity: 0; }

@media (prefers-reduced-motion: no-preference) and (forced-colors: none) {
  :root:not([data-motion="reduced"]) .thought-pulse.is-active .pulse-trace { opacity: 0.5; }
  :root:not([data-motion="reduced"]) .thought-pulse .pulse-highlight {
    stroke-width: 2.2;
    stroke-dasharray: 24 100;
    animation: thought-pulse-sweep 1.55s linear infinite;
  }
}

@keyframes thought-pulse-sweep {
  0% { opacity: 0; stroke-dashoffset: 24; }
  14%, 66% { opacity: 1; }
  82%, 100% { opacity: 0; stroke-dashoffset: -100; }
}
</style>
