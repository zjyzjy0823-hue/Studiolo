<script setup lang="ts">
import { computed } from 'vue'
import type { DownloadPhase } from '../../services/downloadProgress'

const props = withDefaults(defineProps<{
  percent?: number | null
  phase?: DownloadPhase
  size?: number | string
  title?: string
}>(), {
  percent: null,
  phase: 'downloading',
  size: 22,
  title: undefined,
})

const sizePx = computed(() => (typeof props.size === 'number' ? `${props.size}px` : props.size))

// Circumference for r=9 in viewBox 0 0 24 24: 2 * PI * 9 ≈ 56.55
const circumference = 56.55

const strokeDashoffset = computed(() => {
  if (props.percent == null) return 0
  const clamped = Math.max(0, Math.min(100, props.percent))
  return circumference * (1 - clamped / 100)
})
</script>

<template>
  <span
    class="download-ring"
    :style="{ width: sizePx, height: sizePx }"
    :title="title"
    role="status"
    :aria-label="title || (phase === 'done' ? '下载完成' : (phase === 'failed' ? '下载失败' : '下载中'))"
  >
    <!-- 成功打勾 -->
    <svg
      v-if="phase === 'done'"
      :width="sizePx"
      :height="sizePx"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="download-ring__done"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>

    <!-- 失败打叉 -->
    <svg
      v-else-if="phase === 'failed'"
      :width="sizePx"
      :height="sizePx"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="download-ring__failed"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>

    <!-- 进度中 / 保存中 -->
    <svg
      v-else
      :width="sizePx"
      :height="sizePx"
      viewBox="0 0 24 24"
      fill="none"
      class="download-ring__svg"
    >
      <!-- 底环 -->
      <circle
        cx="12"
        cy="12"
        r="9"
        class="download-ring__base"
        stroke-width="2.2"
      />
      <!-- 进度环：确定态 -->
      <circle
        v-if="percent !== null"
        cx="12"
        cy="12"
        r="9"
        class="download-ring__progress"
        stroke-width="2.2"
        stroke-linecap="round"
        :stroke-dasharray="circumference"
        :stroke-dashoffset="strokeDashoffset"
        transform="rotate(-90 12 12)"
      />
      <!-- 进度环：不确定态（旋转） -->
      <circle
        v-else
        cx="12"
        cy="12"
        r="9"
        class="download-ring__indeterminate"
        stroke-width="2.2"
        stroke-linecap="round"
      />
    </svg>
  </span>
</template>

<style scoped>
.download-ring {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  vertical-align: middle;
  line-height: 1;
}

.download-ring svg {
  display: block;
}

.download-ring__base {
  stroke: var(--border, rgba(255, 255, 255, 0.15));
}

.download-ring__progress {
  stroke: var(--accent, #58a6ff);
  transition: stroke-dashoffset 0.1s ease;
}

.download-ring__indeterminate {
  stroke: var(--accent, #58a6ff);
  stroke-dasharray: 8 6;
  animation: download-ring-spin 1s linear infinite;
  transform-origin: 12px 12px;
}

.download-ring__done {
  color: var(--ok, #3fb950);
}

.download-ring__failed {
  color: var(--warn, #f85149);
}

@keyframes download-ring-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
</style>
