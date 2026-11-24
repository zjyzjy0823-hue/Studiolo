<script setup lang="ts">
import { Bot, ChevronRight, RefreshCw } from 'lucide-vue-next'

defineProps<{
  processCount: number
  subagentCount: number
}>()

const emit = defineEmits<{ open: [] }>()
</script>

<template>
  <button
    v-if="processCount || subagentCount"
    type="button"
    class="session-activity-bar"
    aria-haspopup="dialog"
    @click="emit('open')"
  >
    <span v-if="processCount"><RefreshCw :size="14" aria-hidden="true" />{{ processCount }} 个后台任务</span>
    <span v-if="subagentCount"><Bot :size="15" aria-hidden="true" />{{ subagentCount }} 个子代理</span>
    <ChevronRight class="activity-chevron" :size="15" aria-hidden="true" />
  </button>
</template>

<style scoped>
.session-activity-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 14px;
  width: 100%;
  min-height: 34px;
  margin-bottom: 6px;
  padding: 5px 10px;
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  background: var(--surface-2);
  color: var(--text-2);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.session-activity-bar:hover { color: var(--text); border-color: var(--accent-line); }
.session-activity-bar > span { display: inline-flex; align-items: center; gap: 5px; }
.activity-chevron { margin-inline-start: auto; }
</style>
