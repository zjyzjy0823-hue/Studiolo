<script setup lang="ts">
import { onBeforeUnmount, ref, useId } from 'vue'
import { X } from 'lucide-vue-next'
import type { ProcessItem, SubagentItem } from '../../types/fleet'

const props = defineProps<{
  processes: ProcessItem[]
  subagents: SubagentItem[]
  fetchedAt?: number
  processesUnavailable?: boolean
  subagentsUnavailable?: boolean
}>()

const dialog = ref<HTMLDialogElement>()
const titleId = useId()
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | undefined

function open() {
  if (!dialog.value || dialog.value.open) return
  stopClock()
  now.value = Date.now()
  dialog.value.showModal()
  clock = setInterval(() => { now.value = Date.now() }, 1000)
}

function stopClock() {
  clearInterval(clock)
  clock = undefined
}

function close() {
  dialog.value?.close()
  stopClock()
}

function closeOnBackdrop(event: MouseEvent) {
  const bounds = dialog.value?.getBoundingClientRect()
  if (bounds && (event.clientX < bounds.left || event.clientX > bounds.right ||
    event.clientY < bounds.top || event.clientY > bounds.bottom)) close()
}

function excerpt(text: string) {
  const chars = Array.from(text)
  return chars.length > 60 ? chars.slice(0, 60).join('') + '…' : text
}

function uptime(process: ProcessItem) {
  if (process.uptimeSeconds === null) return '—'
  const extra = process.status === 'running' && props.fetchedAt !== undefined
    ? Math.max(0, now.value - props.fetchedAt) / 1000
    : 0
  const seconds = Math.floor(process.uptimeSeconds + extra)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor(seconds / 60) % 60
  return `${hours ? `${hours} 小时 ` : ''}${minutes || hours ? `${minutes} 分 ` : ''}${seconds % 60} 秒`
}

function statusLabel(status: string) {
  switch (status) {
    case 'running': return '运行中'
    case 'done':
    case 'exited':
    case 'completed': return '已结束'
    case 'error':
    case 'failed': return '失败'
    case 'cancelled': return '已取消'
    case 'unknown': return '未知'
    default: return status
  }
}

onBeforeUnmount(stopClock)
defineExpose({ open, close })
</script>

<template>
  <dialog
    ref="dialog"
    class="session-activity-drawer"
    :aria-labelledby="titleId"
    @click.self="closeOnBackdrop"
    @close="!dialog?.open && stopClock()"
  >
    <header class="activity-drawer-header">
      <h2 :id="titleId">会话活动</h2>
      <form method="dialog">
        <button type="submit" class="icon-btn" aria-label="关闭会话活动" autofocus><X :size="18" /></button>
      </form>
    </header>
    <section class="activity-section">
      <h3>后台任务</h3>
      <p v-if="processesUnavailable" class="activity-empty">后台任务暂不可用</p>
      <p v-else-if="!processes.length" class="activity-empty">当前没有后台任务</p>
      <ul v-else class="activity-list">
        <li v-for="process in processes" :key="process.id" :class="{ 'is-ended': process.status !== 'running' }">
          <details>
            <summary>
              <code>{{ excerpt(process.command) || '命令未知' }}</code>
              <span class="activity-meta">
                <span>PID {{ process.pid ?? '—' }}</span>
                <span>已运行 {{ uptime(process) }}</span>
                <span>{{ statusLabel(process.status) }}</span>
              </span>
            </summary>
            <pre>{{ process.outputTail || '暂无输出' }}</pre>
          </details>
        </li>
      </ul>
    </section>
    <section v-if="subagents.length || subagentsUnavailable" class="activity-section">
      <h3>子代理</h3>
      <p v-if="subagentsUnavailable" class="activity-empty">子代理暂不可用</p>
      <ul v-else class="activity-list">
        <li v-for="subagent in subagents" :key="subagent.id" class="activity-subagent">
          <span>{{ excerpt(subagent.goals[0] || '') || '目标未知' }}</span>
          <span class="activity-meta"><span>{{ subagent.count }} 个子代理</span><span>{{ statusLabel(subagent.status) }}</span></span>
        </li>
      </ul>
    </section>
  </dialog>
</template>

<style scoped>
.session-activity-drawer {
  position: fixed;
  inset: auto 0 0;
  box-sizing: border-box;
  width: min(100%, 610px);
  max-width: 100%;
  max-height: 82dvh;
  margin: 0 auto;
  padding: 12px 16px calc(16px + env(safe-area-inset-bottom));
  overflow: auto;
  overscroll-behavior: contain;
  border: 1px solid var(--line-strong);
  border-bottom: 0;
  border-radius: 20px 20px 0 0;
  background: var(--solid);
  color: var(--text);
  box-shadow: var(--shadow-pop);
}
.session-activity-drawer::backdrop { background: rgb(0 0 0 / 35%); }
.activity-drawer-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.activity-drawer-header h2 { margin: 0; font-size: calc(17px * var(--fs)); }
.activity-section { margin-top: 12px; }
.activity-section h3 { margin: 0 0 6px; font-size: calc(13px * var(--fs)); }
.activity-list { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.activity-list > li { overflow: hidden; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-2); }
.activity-list > .is-ended { color: var(--text-2); background: transparent; }
.activity-list summary, .activity-subagent { padding: 8px 10px; overflow-wrap: anywhere; }
.activity-list summary { cursor: pointer; }
.activity-meta { display: flex; flex-wrap: wrap; gap: 2px 12px; margin-top: 3px; color: var(--text-2); font-size: calc(12px * var(--fs)); }
.activity-empty { margin: 0; color: var(--text-2); font-size: calc(13px * var(--fs)); }
.activity-list pre {
  max-height: 180px;
  overflow: auto;
  margin: 0;
  padding: 8px 10px;
  border-top: 1px solid var(--line);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
