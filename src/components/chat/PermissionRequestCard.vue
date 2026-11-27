<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { ApprovalDecision, PermissionRequestCard } from '../../types/fleet'
import OpusIcon from '../ui/OpusIcon.vue'

const props = defineProps<{ card: PermissionRequestCard }>()
const emit = defineEmits<{ respond: [callId: string, decision: ApprovalDecision] }>()

const expanded = ref(false)
watch(() => props.card.callId, () => {
  expanded.value = false
})

const command = computed(() => props.card.command || '')
const firstLine = computed(() => command.value.split('\n')[0].trim())
const hasMore = computed(() => command.value.includes('\n') || command.value.length > firstLine.value.length)

const riskText: Record<string, string> = {
  high: '高风险操作',
  medium: '需要确认',
  low: '常规请求',
}

const decisionLabel: Record<ApprovalDecision | 'submitted', string> = {
  submitted: '已提交审批决定',
  allow_once: '已允许本次执行',
  allow_session: '已在本会话放行这条命令',
  allow_trust: '已允许并加入信任白名单',
  deny: '已拒绝执行',
}
</script>

<template>
  <div class="perm-card" :class="[`risk-${card.risk}`, { resolved: card.decision !== 'pending' }]">
    <div class="perm-top">
      <OpusIcon name="shield" />
      <span class="perm-title">{{ card.title }}</span>
      <span class="perm-risk">{{ riskText[card.risk] ?? '需要确认' }}</span>
    </div>
    <code v-if="card.decision === 'pending' && card.command" class="perm-cmd">{{ card.command }}</code>
    <div v-if="card.decision === 'pending'" class="perm-actions">
      <button type="button" class="btn btn-primary btn-sm" @click="emit('respond', card.callId, 'allow_once')">允许一次</button>
      <button v-if="card.command && card.risk !== 'high'" type="button" class="btn btn-ghost btn-sm"
        title="仅放行本会话内完全相同的命令" @click="emit('respond', card.callId, 'allow_session')">本会话允许此命令</button>
      <button
        v-if="card.command && card.risk !== 'high'"
        type="button"
        class="btn btn-ghost btn-sm"
        title="将同类命令前缀写入节点可信白名单，后续低中风险自动放行"
        @click="emit('respond', card.callId, 'allow_trust')"
      >始终信任此类命令</button>
      <button type="button" class="btn btn-danger btn-sm" @click="emit('respond', card.callId, 'deny')">拒绝</button>
    </div>
    <template v-else>
      <div class="perm-done">
        <OpusIcon :name="card.decision === 'deny' ? 'x' : 'check'" />
        <span>{{ decisionLabel[card.decision] }}</span>
      </div>
      <template v-if="card.command">
        <button type="button" class="perm-cmd-collapsed" :aria-expanded="expanded" @click="expanded = !expanded">
          <code class="perm-cmd-first">{{ firstLine }}</code>
          <span v-if="hasMore" class="perm-cmd-toggle">{{ expanded ? '收起' : '展开' }}</span>
        </button>
        <code v-if="expanded" class="perm-cmd">{{ card.command }}</code>
      </template>
    </template>
  </div>
</template>

<style scoped>
.perm-card {
  display: grid;
  gap: 8px;
  margin-top: 8px;
  padding: 11px 12px;
  border-radius: var(--r-md);
  background: var(--surface-2);
  box-shadow: inset 0 0 0 1px var(--line-strong);
}
.perm-card.risk-high:not(.resolved) {
  background: var(--warn-soft);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--warn) 45%, transparent);
}
.perm-top {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: calc(12.5px * var(--fs));
  font-weight: 620;
  color: var(--text);
}
.perm-top .i { width: 14px; height: 14px; color: var(--warn); flex: none; }
.perm-card.resolved .perm-top .i { color: var(--text-2); }
.perm-title { flex: 1; min-width: 0; }
.perm-risk {
  font-size: calc(11px * var(--fs));
  font-weight: 600;
  padding: 2px 7px;
  border-radius: var(--r-pill);
  background: var(--surface-3);
  color: var(--text-2);
}
.perm-cmd {
  display: block;
  padding: 7px 9px;
  border-radius: var(--r-xs);
  background: var(--solid);
  color: var(--text);
  font-size: calc(12px * var(--fs));
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  word-break: break-all;
}
.perm-card.resolved .perm-cmd { white-space: pre-wrap; }
.perm-cmd-collapsed {
  display: flex;
  gap: 6px;
  align-items: center;
  width: 100%;
  min-width: 0;
  padding: 7px 9px;
  border: 0;
  border-radius: var(--r-xs);
  background: var(--solid);
  color: var(--text);
  font-size: calc(12px * var(--fs));
  text-align: start;
}
.perm-cmd-first {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.perm-cmd-toggle { flex: none; color: var(--text-2); }
.perm-actions { display: flex; flex-wrap: wrap; gap: 6px; }
@media (max-width: 700px) {
  .perm-card {
    padding: 12px 13px;
    border-radius: 16px;
  }
  .perm-actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .perm-actions .btn {
    min-height: 40px;
    justify-content: center;
    font-size: calc(13.5px * var(--fs));
    border-radius: 12px;
  }
  .perm-cmd-collapsed { min-height: 40px; }
}
.perm-done {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: calc(12px * var(--fs));
  color: var(--text-2);
}
.perm-done .i { width: 13px; height: 13px; }
</style>
