<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Download, ExternalLink, Trash2, X } from 'lucide-vue-next'
import ActionButton from '../ui/ActionButton.vue'
import SettingsSection from './SettingsSection.vue'
import DownloadRing from '../chat/DownloadRing.vue'
import {
  clearDownloads,
  isRecordOpenable,
  readDownloads,
  removeDownload,
  type DownloadRecord,
} from '../../services/downloadHistory'
import { openExternal } from '../../utils/openExternal'
import { openSavedDownload } from '../../services/saveDownload'

const emit = defineEmits<{ action: [message: string] }>()
const records = ref<DownloadRecord[]>([])
const now = ref(Date.now())

onMounted(() => { records.value = readDownloads() })

const totalText = computed(() => {
  const count = records.value.length
  return count ? `${count} 条记录` : '还没有下载记录'
})

function refresh() {
  now.value = Date.now()
  records.value = readDownloads()
}

function formatSize(bytes: number): string {
  if (!bytes) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function formatTime(at: number): string {
  const date = new Date(at)
  const mm = `${date.getMonth() + 1}`.padStart(2, '0')
  const dd = `${date.getDate()}`.padStart(2, '0')
  const hh = `${date.getHours()}`.padStart(2, '0')
  const mi = `${date.getMinutes()}`.padStart(2, '0')
  return `${mm}-${dd} ${hh}:${mi}`
}

function channelLabel(record: DownloadRecord): string {
  return record.channel === 'external' ? '高速通道' : '中继'
}

function canOpen(record: DownloadRecord): boolean {
  return isRecordOpenable(record, now.value)
}

async function openRecord(record: DownloadRecord) {
  if (!record.url) return
  try {
    await openExternal(record.url)
    emit('action', `已重新打开 ${record.name}`)
  } catch (error) {
    emit('action', error instanceof Error ? error.message : '无法打开链接')
  }
}

const openState = ref<{ id: string; text: string; failed: boolean } | null>(null)

async function handleRowClick(record: DownloadRecord) {
  if (record.status === 'saved') {
    // 立刻给出可见反馈：确认点击真的进来了（打不开时也把原因留在行内）
    openState.value = { id: record.id, text: '正在打开…', failed: false }
    try {
      await openSavedDownload(record)
      openState.value = { id: record.id, text: '已交给系统', failed: false }
      emit('action', `已打开 ${record.name}`)
      setTimeout(() => { if (openState.value?.id === record.id) openState.value = null }, 2500)
    } catch (error) {
      const message = error instanceof Error ? error.message : '打开失败'
      openState.value = { id: record.id, text: `打开失败：${message}`, failed: true }
      emit('action', message)
    }
  } else if (record.channel === 'external' && canOpen(record)) {
    await openRecord(record)
  }
}

function drop(id: string) {
  records.value = removeDownload(id)
  now.value = Date.now()
}

function clearAll() {
  records.value = clearDownloads()
  emit('action', '下载记录已清空')
}
</script>

<template>
  <SettingsSection title="下载记录" description="本机最近的下载。记录只保存在这台设备上，不会同步。">
    <div class="settings-card">
      <div class="settings-card__heading">
        最近下载
        <span class="faint" style="font-weight:400;font-size:calc(12px * var(--fs))">{{ totalText }}</span>
      </div>
      <p v-if="!records.length" class="faint" style="font-size:calc(13px * var(--fs));margin:6px 0 0">
        还没有下载记录。在对话里点附件卡片的「下载」后会出现在这里。
      </p>
      <div v-else class="download-list">
        <div v-for="record in records" :key="record.id" class="download-row is-clickable" @click="handleRowClick(record)">
          <div class="download-row__icon">
            <DownloadRing
              v-if="record.status === 'saved'"
              phase="done"
              :percent="100"
              :size="16"
              title="已保存"
            />
            <Download v-else :size="16" />
          </div>
          <div class="download-row__body">
            <div class="download-row__name">{{ record.name }}</div>
            <div v-if="openState?.id === record.id" class="faint" :style="{ fontSize: 'calc(12px * var(--fs))', color: openState.failed ? 'var(--warn, #a84a18)' : 'var(--text-3)' }">{{ openState.text }}</div>
            <div class="download-row__meta">
              <span>{{ formatSize(record.sizeBytes) }}</span>
              <span>·</span>
              <span>{{ formatTime(record.at) }}</span>
              <span>·</span>
              <span :class="['download-chip', record.channel === 'external' ? 'download-chip--fast' : '']">{{ channelLabel(record) }}</span>
              <span v-if="record.channel === 'external' && !canOpen(record)" class="faint">（链接已过期）</span>
            </div>
          </div>
          <div class="download-row__actions">
            <ActionButton v-if="canOpen(record)" variant="secondary" @click.stop="openRecord(record)">
              <ExternalLink :size="14" />打开
            </ActionButton>
            <button class="btn btn-ghost btn-sm" type="button" title="删除这条记录" @click.stop="drop(record.id)">
              <X :size="14" />
            </button>
          </div>
        </div>
      </div>
    </div>
    <div v-if="records.length" class="settings-button-row">
      <ActionButton variant="secondary" @click="clearAll"><Trash2 :size="15" />清空记录</ActionButton>
    </div>
    <p class="storage-help">
      大文件（超过 32MB）会走高速通道，链接 24 小时后失效；小文件仍按原有方式保存到 Download/Studiolo。
    </p>
  </SettingsSection>
</template>

<style scoped>
.download-list { display: flex; flex-direction: column; gap: 2px; margin-top: 8px; }
.download-row { display: flex; align-items: center; gap: 10px; padding: 9px 4px; border-bottom: 1px solid var(--border-subtle, rgba(255,255,255,.06)); }
.download-row.is-clickable { cursor: pointer; border-radius: 6px; }
.download-row.is-clickable:hover { background: rgba(255, 255, 255, .03); }
.download-row:last-child { border-bottom: none; }
.download-row__icon { flex: 0 0 auto; color: var(--text-faint, #8b93a7); display: flex; }
.download-row__body { flex: 1 1 auto; min-width: 0; }
.download-row__name { font-size: calc(13px * var(--fs)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.download-row__meta { display: flex; align-items: center; gap: 6px; font-size: calc(11.5px * var(--fs)); color: var(--text-faint, #8b93a7); margin-top: 2px; flex-wrap: wrap; }
.download-row__actions { flex: 0 0 auto; display: flex; align-items: center; gap: 4px; }
.download-chip { padding: 1px 6px; border-radius: 999px; background: rgba(255,255,255,.07); font-size: calc(11px * var(--fs)); }
.download-chip--fast { background: rgba(88,166,255,.16); color: #7cc0ff; }
.storage-help { font-size: calc(12px * var(--fs)); color: var(--text-faint, #8b93a7); margin-top: 10px; }
</style>
