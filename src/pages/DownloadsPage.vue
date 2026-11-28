<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { invoke, isTauri } from '@tauri-apps/api/core'
import {
  clearDownloads,
  isRecordOpenable,
  readDownloads,
  removeDownload,
  type DownloadRecord,
} from '../services/downloadHistory'
import {
  downloadProgressStore,
  type DownloadProgressState,
} from '../services/downloadProgress'
import { openSavedDownload } from '../services/saveDownload'
import { openExternal } from '../utils/openExternal'
import {
  filterRecords,
  formatBytesHuman,
  formatRecordTime,
  summarize,
  typeOf,
  type DownloadFilterType,
  type DownloadSortBy,
  type DownloadTimeRange,
  type DownloadType,
} from '../services/downloadsView'

interface ViewRecord extends DownloadRecord {
  inProgress?: boolean
  viewStatus: 'done' | 'downloading' | 'failed'
  percent?: number | null
  speed?: string
}

const props = defineProps<{ mobile?: boolean }>()
const emit = defineEmits<{
  action: [message: string]
  navigate: [page: string, section?: any]
  back: []
}>()

const records = ref<DownloadRecord[]>([])
const activeProgress = ref<Record<string, DownloadProgressState>>({})
const now = ref(Date.now())

// 筛选与搜索状态
const searchQuery = ref('')
const selectedType = ref<DownloadFilterType>('all')
const timeRange = ref<DownloadTimeRange>('all')
const sortBy = ref<DownloadSortBy>('time_desc')
const selectedIds = ref<Set<string>>(new Set())
const searchInputRef = ref<HTMLInputElement | null>(null)

let nowTimer: ReturnType<typeof setInterval> | undefined
let unsubscribeProgress: (() => void) | undefined

function loadRecords() {
  now.value = Date.now()
  records.value = readDownloads()
}

// 汇总统计：基于原始全部记录
const summary = computed(() => summarize(records.value))

// 视图记录：将历史记录与进行中状态合并
const viewRecords = computed<ViewRecord[]>(() => {
  return records.value.map(record => {
    const prog = activeProgress.value[record.id] || activeProgress.value['default']
    const isDownloading = prog && (prog.phase === 'downloading' || prog.phase === 'saving')
    const isFailed = prog && prog.phase === 'failed'

    let viewStatus: 'done' | 'downloading' | 'failed' = 'done'
    if (isDownloading) {
      viewStatus = 'downloading'
    } else if (isFailed || (record as any).status === 'failed') {
      viewStatus = 'failed'
    }

    return {
      ...record,
      inProgress: isDownloading,
      viewStatus,
      percent: prog?.percent ?? null,
      speed: undefined,
    }
  })
})

// 经过纯函数筛选排序后的列表
const filteredRecords = computed(() => {
  return filterRecords(viewRecords.value, {
    query: searchQuery.value,
    type: selectedType.value,
    range: timeRange.value,
    sort: sortBy.value,
    now: now.value,
  })
})

// 多选状态计算
const isAllSelected = computed(() => {
  if (filteredRecords.value.length === 0) return false
  return filteredRecords.value.every(r => selectedIds.value.has(r.id))
})

const isPartialSelected = computed(() => {
  if (isAllSelected.value) return false
  return filteredRecords.value.some(r => selectedIds.value.has(r.id))
})

const selectedItems = computed(() => {
  return records.value.filter(r => selectedIds.value.has(r.id))
})

const selectedTotalBytesText = computed(() => {
  const total = selectedItems.value.reduce((sum, item) => sum + (item.sizeBytes || 0), 0)
  return formatBytesHuman(total)
})

function toggleSelectAll() {
  if (isAllSelected.value) {
    selectedIds.value.clear()
  } else {
    for (const r of filteredRecords.value) {
      selectedIds.value.add(r.id)
    }
  }
}

function toggleSelectRow(id: string) {
  if (selectedIds.value.has(id)) {
    selectedIds.value.delete(id)
  } else {
    selectedIds.value.add(id)
  }
}

function clearSelection() {
  selectedIds.value.clear()
}

// 刷新
function handleRefresh() {
  loadRecords()
  emit('action', '已刷新')
}

// 打开保存的下载目录或指定文件
async function revealInFolder(targetPath?: string) {
  if (!isTauri()) {
    emit('action', '仅客户端支持在文件夹中定位')
    return
  }
  try {
    await invoke('reveal_in_folder', { path: targetPath ?? '' })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || '')
    if (message.includes('path_missing')) {
      emit('action', '文件已被移动或删除')
    } else if (message.includes('path_not_allowed')) {
      emit('action', '无法打开此路径')
    } else {
      emit('action', message || '定位失败')
    }
  }
}

function handleOpenDownloadsFolder() {
  void revealInFolder('')
}

// 打开单个文件
async function handleOpenFile(record: DownloadRecord) {
  if (record.status === 'saved' || record.displayPath) {
    try {
      await openSavedDownload(record)
      emit('action', `已打开 ${record.name}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : '打开失败'
      emit('action', message)
    }
  } else if (record.channel === 'external' && isRecordOpenable(record, now.value) && record.url) {
    try {
      await openExternal(record.url)
      emit('action', `已重新打开 ${record.name}`)
    } catch (error) {
      emit('action', error instanceof Error ? error.message : '无法打开链接')
    }
  } else {
    emit('action', '无法打开文件或链接已过期')
  }
}

// 重新下载
async function handleRetryDownload(record: DownloadRecord) {
  if (!record.url || !isRecordOpenable(record, now.value)) {
    emit('action', '链接已过期，请回到原会话重新下载')
    return
  }
  try {
    await openExternal(record.url)
    emit('action', `已开始重新下载 ${record.name}`)
  } catch (error) {
    emit('action', error instanceof Error ? error.message : '重新下载失败')
  }
}

// 取消下载中的任务
function handleCancelDownload(record: DownloadRecord) {
  downloadProgressStore.clear(record.id)
  downloadProgressStore.clear('default')
  activeProgress.value = { ...activeProgress.value, [record.id]: undefined as any }
  emit('action', `已取消 ${record.name} 的下载`)
}

// 删除记录
function handleDeleteRecord(id: string) {
  removeDownload(id)
  selectedIds.value.delete(id)
  loadRecords()
  emit('action', '已删除记录')
}

// 批量操作
async function batchOpen() {
  let success = 0
  let failed = 0
  for (const item of selectedItems.value) {
    try {
      await openSavedDownload(item)
      success++
    } catch {
      failed++
    }
  }
  if (failed === 0) {
    emit('action', `已打开 ${success} 项文件`)
  } else {
    emit('action', `已打开 ${success} 项文件，${failed} 项失败`)
  }
}

async function batchReveal() {
  const first = selectedItems.value[0]
  if (first) {
    await revealInFolder(first.displayPath || first.name)
  }
}

async function batchRetry() {
  let retried = 0
  for (const item of selectedItems.value) {
    if (item.url && isRecordOpenable(item, now.value)) {
      try {
        await openExternal(item.url)
        retried++
      } catch {
        // ignore individual failures
      }
    }
  }
  if (retried > 0) {
    emit('action', `已重新触发 ${retried} 项文件的下载`)
  } else {
    emit('action', '所选文件中无可用或未过期的下载链接')
  }
}

function batchDelete() {
  const count = selectedIds.value.size
  for (const id of selectedIds.value) {
    removeDownload(id)
  }
  selectedIds.value.clear()
  loadRecords()
  emit('action', `已删除 ${count} 项记录`)
}

// 跳转到会话
function jumpToSession(sessionKey?: string) {
  if (!sessionKey) return
  emit('navigate', 'Chat')
}

// 快捷键支持：⌘F 聚焦搜索框
function onKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault()
    searchInputRef.value?.focus()
    searchInputRef.value?.select()
  }
}

// 存储事件监听
function onStorage(e: StorageEvent) {
  if (!e.key || e.key === 'studiolo.downloads.v1') {
    loadRecords()
  }
}

// 文件类型徽章样式类
function badgeClass(name: string): string {
  const t = typeOf(name)
  switch (t) {
    case 'doc':
      return name.toLowerCase().endsWith('.pdf') ? 'type-pdf' : 'type-sheet'
    case 'installer':
      return 'type-pkg'
    case 'archive':
      return 'type-zip'
    case 'image':
      return name.toLowerCase().endsWith('.svg') ? 'type-vector' : 'type-img'
    default:
      return 'type-code'
  }
}

onMounted(() => {
  loadRecords()
  window.addEventListener('storage', onStorage)
  window.addEventListener('keydown', onKeydown)

  unsubscribeProgress = downloadProgressStore.subscribe(state => {
    if (state) {
      activeProgress.value = { ...activeProgress.value, default: state }
    } else {
      activeProgress.value = {}
    }
  })

  nowTimer = setInterval(() => {
    now.value = Date.now()
  }, 30000)
})

onUnmounted(() => {
  window.removeEventListener('storage', onStorage)
  window.removeEventListener('keydown', onKeydown)
  if (unsubscribeProgress) unsubscribeProgress()
  if (nowTimer) clearInterval(nowTimer)
})
</script>

<template>
  <div class="downloads-page">
    <div class="downloads-container">
      <!-- 1. 工具条（单行，包含搜索/类型 chips/时间/排序，最右侧是刷新按钮 + 在文件夹中打开按钮） -->
      <div class="toolbar">
        <div class="tb-group-left">
          <!-- 搜索框 -->
          <div class="search-box">
            <svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
            <input
              ref="searchInputRef"
              v-model="searchQuery"
              type="text"
              placeholder="按文件名或来源会话搜索…"
              aria-label="按文件名或来源会话搜索"
            />
          </div>

          <!-- 类型筛选 chips -->
          <div class="filter-pills" role="radiogroup" aria-label="文件类型筛选">
            <button
              class="filter-pill"
              :class="{ 'is-active': selectedType === 'all' }"
              type="button"
              @click="selectedType = 'all'"
            >
              全部 <span class="pill-count">{{ summary.count }}</span>
            </button>
            <button
              class="filter-pill"
              :class="{ 'is-active': selectedType === 'image' }"
              type="button"
              @click="selectedType = 'image'"
            >
              图片 <span class="pill-count">{{ summary.byType.image }}</span>
            </button>
            <button
              class="filter-pill"
              :class="{ 'is-active': selectedType === 'doc' }"
              type="button"
              @click="selectedType = 'doc'"
            >
              文档 <span class="pill-count">{{ summary.byType.doc }}</span>
            </button>
            <button
              class="filter-pill"
              :class="{ 'is-active': selectedType === 'archive' }"
              type="button"
              @click="selectedType = 'archive'"
            >
              压缩包 <span class="pill-count">{{ summary.byType.archive }}</span>
            </button>
            <button
              class="filter-pill"
              :class="{ 'is-active': selectedType === 'installer' }"
              type="button"
              @click="selectedType = 'installer'"
            >
              安装包 <span class="pill-count">{{ summary.byType.installer }}</span>
            </button>
            <button
              class="filter-pill"
              :class="{ 'is-active': selectedType === 'other' }"
              type="button"
              @click="selectedType = 'other'"
            >
              其它 <span class="pill-count">{{ summary.byType.other }}</span>
            </button>
          </div>
        </div>

        <div class="tb-group-right">
          <!-- 时间筛选 -->
          <div class="select-ctl-wrapper" title="时间范围筛选">
            <select v-model="timeRange" class="select-ctl" aria-label="时间范围筛选">
              <option value="all">全部时间</option>
              <option value="today">今天</option>
              <option value="7d">近 7 天</option>
              <option value="30d">近 30 天</option>
            </select>
            <svg class="select-arrow" viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
          </div>

          <!-- 排序筛选 -->
          <div class="select-ctl-wrapper" title="排序列">
            <select v-model="sortBy" class="select-ctl" aria-label="排序列">
              <option value="time_desc">时间倒序</option>
              <option value="time_asc">时间正序</option>
              <option value="size_desc">大小</option>
              <option value="name_asc">名称</option>
            </select>
            <svg class="select-arrow" viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
          </div>

          <!-- 最右：刷新图标按钮 + 「在文件夹中打开」按钮 -->
          <button class="btn btn-subtle btn-icon-only" type="button" title="刷新状态" @click="handleRefresh">
            <svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 0 1-14.4 4.8M4 12a8 8 0 0 1 14.4-4.8"/><path d="M19 3v4.5h-4.5M5 21v-4.5h4.5"/></svg>
          </button>
          <button class="btn btn-ghost" type="button" title="打开本地下载保存目录" @click="handleOpenDownloadsFolder">
            <svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>
            <span>在文件夹中打开</span>
          </button>
        </div>
      </div>

      <!-- 2. 批量操作条（仅当选中 ≥1 时出现，占一行，不跳变） -->
      <div v-if="selectedIds.size > 0" class="batch-bar">
        <div class="batch-left">
          <span
            class="custom-checkbox is-checked"
            title="取消全选"
            role="checkbox"
            aria-checked="true"
            @click="clearSelection"
          >
            <svg class="i" viewBox="0 0 24 24" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </span>
          <span>已选 <strong class="batch-count-tag">{{ selectedIds.size }}</strong> 项 · 共 {{ selectedTotalBytesText }}</span>
        </div>
        <div class="batch-actions">
          <button class="btn btn-ghost btn-sm" type="button" @click="batchOpen">
            <svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            <span>批量打开</span>
          </button>
          <button class="btn btn-ghost btn-sm" type="button" @click="batchReveal">
            <svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>
            <span>在文件夹中显示</span>
          </button>
          <button class="btn btn-ghost btn-sm" type="button" @click="batchRetry">
            <svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>
            <span>重新下载</span>
          </button>
          <button class="btn btn-danger-ghost btn-sm" type="button" @click="batchDelete">
            <svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2M10 11v6M14 11v6"/></svg>
            <span>删除所选</span>
          </button>
          <button class="btn btn-subtle btn-sm" type="button" @click="clearSelection">取消选择</button>
        </div>
      </div>

      <!-- 3. 数据表格主体 -->
      <div v-if="filteredRecords.length > 0" class="scheme-table-card mat-solid">
        <table class="tbl">
          <thead>
            <tr>
              <th style="width:40px;text-align:center">
                <span
                  class="custom-checkbox"
                  :class="{ 'is-checked': isAllSelected || isPartialSelected }"
                  :title="isAllSelected ? '取消全选' : '全选'"
                  role="checkbox"
                  :aria-checked="isAllSelected ? 'true' : (isPartialSelected ? 'mixed' : 'false')"
                  @click="toggleSelectAll"
                >
                  <svg v-if="isAllSelected" class="i" viewBox="0 0 24 24" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
                  <svg v-else-if="isPartialSelected" class="i" viewBox="0 0 24 24" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"/></svg>
                </span>
              </th>
              <th class="th-sort" style="width:360px" @click="sortBy = 'name_asc'">
                文件名
                <svg class="sort-ic" viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
              </th>
              <th style="width:200px">来源会话</th>
              <th class="th-sort" style="width:100px" @click="sortBy = 'size_desc'">
                大小
                <svg class="sort-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 15 5 5 5-5M7 9l5-5 5 5"/></svg>
              </th>
              <th class="th-sort" style="width:110px" @click="sortBy = sortBy === 'time_desc' ? 'time_asc' : 'time_desc'">
                时间 {{ sortBy === 'time_asc' ? '↑' : '↓' }}
                <svg class="sort-ic" viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
              </th>
              <th style="width:160px">状态</th>
              <th style="width:130px;text-align:right">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="item in filteredRecords"
              :key="item.id"
              :class="{
                'is-selected': selectedIds.has(item.id),
                'is-failed-row': item.viewStatus === 'failed',
              }"
            >
              <!-- 复选框 -->
              <td style="text-align:center">
                <span
                  class="custom-checkbox"
                  :class="{ 'is-checked': selectedIds.has(item.id) }"
                  role="checkbox"
                  :aria-checked="selectedIds.has(item.id)"
                  @click="toggleSelectRow(item.id)"
                >
                  <svg v-if="selectedIds.has(item.id)" class="i" viewBox="0 0 24 24" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
                </span>
              </td>

              <!-- 文件名与次级路径 -->
              <td>
                <div class="file-cell">
                  <div class="file-badge-icon" :class="badgeClass(item.name)">
                    <!-- Doc: sheet or pdf -->
                    <template v-if="typeOf(item.name) === 'doc'">
                      <svg v-if="item.name.toLowerCase().endsWith('.pdf')" class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/></svg>
                      <svg v-else class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M8 13h8M8 17h8M12 13v8"/></svg>
                    </template>
                    <!-- Installer: pkg/dmg/exe -->
                    <template v-else-if="typeOf(item.name) === 'installer'">
                      <svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/><line x1="12" y1="2" x2="12" y2="9"/><line x1="12" y1="15" x2="12" y2="22"/></svg>
                    </template>
                    <!-- Archive: zip/tar -->
                    <template v-else-if="typeOf(item.name) === 'archive'">
                      <svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 8v13H3V8M1 3h22v5H1z"/><line x1="10" y1="12" x2="14" y2="12"/></svg>
                    </template>
                    <!-- Image -->
                    <template v-else-if="typeOf(item.name) === 'image'">
                      <svg v-if="item.name.toLowerCase().endsWith('.svg')" class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><circle cx="18" cy="6" r="3"/><path d="M8.5 7.5l7 9M6 9v9h9"/></svg>
                      <svg v-else class="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                    </template>
                    <!-- Other -->
                    <template v-else>
                      <svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M8 13l2 2-2 2M12 17h4"/></svg>
                    </template>
                  </div>
                  <div class="file-title-wrap">
                    <div class="file-name" :title="item.name">{{ item.name }}</div>
                    <div class="file-path-hint" :title="item.displayPath || `~/Downloads/Studiolo/${item.name}`">
                      {{ item.displayPath || `~/Downloads/Studiolo/${item.name}` }}
                    </div>
                  </div>
                </div>
              </td>

              <!-- 来源会话 -->
              <td>
                <button
                  v-if="item.sessionKey"
                  class="source-tag"
                  type="button"
                  :title="`前往会话：${item.sessionKey}`"
                  @click="jumpToSession(item.sessionKey)"
                >
                  <svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 12a8.5 8.5 0 0 1-12.3 7.6L3.5 20.5l1-4.4A8.5 8.5 0 1 1 20.5 12z"/></svg>
                  <span>{{ item.sessionKey }}</span>
                </button>
                <span v-else style="color:var(--text-3)">—</span>
              </td>

              <!-- 大小 -->
              <td><strong>{{ formatBytesHuman(item.sizeBytes) }}</strong></td>

              <!-- 时间 -->
              <td style="color:var(--text-3)">{{ formatRecordTime(item.at, now) }}</td>

              <!-- 状态 -->
              <td>
                <!-- 进行中状态 -->
                <div v-if="item.viewStatus === 'downloading'" class="progress-meter">
                  <div class="progress-meta">
                    <span style="color:var(--accent);font-weight:600">
                      下载中 {{ item.percent != null ? `${item.percent}%` : '' }}
                    </span>
                    <span v-if="item.speed">{{ item.speed }}</span>
                  </div>
                  <div class="progress-track">
                    <div class="progress-fill" :style="{ width: `${item.percent ?? 30}%` }"></div>
                  </div>
                </div>

                <!-- 失败状态 -->
                <span v-else-if="item.viewStatus === 'failed'" class="status-pill is-failed">
                  <span class="dot"></span>下载失败
                </span>

                <!-- 已完成状态 -->
                <span v-else class="status-pill is-done">
                  <span class="dot"></span>已完成
                </span>
              </td>

              <!-- 行操作按钮组 -->
              <td>
                <div class="row-actions" style="justify-content:flex-end">
                  <!-- 下载中时：取消 -->
                  <template v-if="item.viewStatus === 'downloading'">
                    <button class="action-icon-btn btn-action-danger" title="取消下载" type="button" @click="handleCancelDownload(item)">
                      <svg class="i" viewBox="0 0 24 24" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                  </template>

                  <!-- 失败时：重试 + 删除 -->
                  <template v-else-if="item.viewStatus === 'failed'">
                    <button
                      class="btn btn-sm btn-ghost"
                      style="color:var(--accent);font-weight:600"
                      type="button"
                      title="重试下载"
                      @click="handleRetryDownload(item)"
                    >
                      <svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>
                      <span>重试</span>
                    </button>
                    <button
                      class="action-icon-btn btn-action-danger"
                      type="button"
                      title="删除记录"
                      @click="handleDeleteRecord(item.id)"
                    >
                      <svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2M10 11v6M14 11v6"/></svg>
                    </button>
                  </template>

                  <!-- 正常完成时：打开 + 在文件夹中显示 + 重新下载 + 删除 -->
                  <template v-else>
                    <button
                      class="action-icon-btn btn-action-primary"
                      type="button"
                      title="打开文件"
                      @click="handleOpenFile(item)"
                    >
                      <svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                    </button>
                    <button
                      class="action-icon-btn"
                      type="button"
                      title="在文件夹中显示"
                      @click="revealInFolder(item.displayPath || item.name)"
                    >
                      <svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>
                    </button>
                    <button
                      class="action-icon-btn"
                      type="button"
                      :disabled="!item.url || !isRecordOpenable(item, now)"
                      :class="{ 'is-disabled': !item.url || !isRecordOpenable(item, now) }"
                      :title="(!item.url || !isRecordOpenable(item, now)) ? '链接已过期，请回到原会话重新下载' : '重新下载'"
                      @click="handleRetryDownload(item)"
                    >
                      <svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>
                    </button>
                    <button
                      class="action-icon-btn btn-action-danger"
                      type="button"
                      title="删除记录"
                      @click="handleDeleteRecord(item.id)"
                    >
                      <svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2M10 11v6M14 11v6"/></svg>
                    </button>
                  </template>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 4. 空状态（居中图标 + 「还没有下载记录」+ 「在对话里点附件的『下载』后，文件会出现在这里」） -->
      <div v-else class="empty-state-card mat-solid">
        <div class="empty-icon-circle">
          <svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7.5 11.5 12 16l4.5-4.5M4 19h16"/></svg>
        </div>
        <div class="empty-title">
          {{ records.length === 0 ? '还没有下载记录' : '未找到匹配的记录' }}
        </div>
        <p class="empty-desc">
          {{ records.length === 0 ? '在对话里点附件的「下载」后，文件会出现在这里' : '尝试调整搜索关键词或类型与时间筛选' }}
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.downloads-page {
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  overflow-y: auto;
  padding: 20px 24px;
}

.downloads-container {
  max-width: 1200px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* ---------- 工具条 (Toolbar) ---------- */
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  border-radius: var(--r-md);
  background: var(--solid);
  box-shadow: var(--shadow-1);
}

.tb-group-left {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
  min-width: 0;
}

.search-box {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  width: 220px;
  padding: 0 10px;
  border-radius: var(--r-sm);
  background: var(--surface-2);
  border: 1px solid var(--line);
  transition: border-color var(--dur-1, 120ms), box-shadow var(--dur-1, 120ms);
}

.search-box:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
  background: var(--solid);
}

.search-box .i {
  color: var(--text-3);
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}

.search-box input {
  border: 0;
  outline: 0;
  background: transparent;
  font-size: calc(12.5px * var(--fs));
  color: var(--text);
  width: 100%;
}

.search-box input::placeholder {
  color: var(--text-3);
}

/* 类型筛选 chips (Segmented pills) */
.filter-pills {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border-radius: var(--r-pill, 999px);
  background: var(--surface-3);
  flex-wrap: nowrap;
}

.filter-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: var(--r-pill, 999px);
  font-size: calc(12px * var(--fs));
  font-weight: 500;
  color: var(--text-2);
  background: transparent;
  border: 0;
  cursor: pointer;
  transition: all var(--dur-1, 120ms);
  white-space: nowrap;
}

.filter-pill:hover {
  color: var(--text);
}

.filter-pill.is-active {
  background: var(--solid);
  color: var(--accent);
  font-weight: 600;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}

.pill-count {
  font-size: 10.5px;
  color: var(--text-3);
  font-weight: 400;
}

.filter-pill.is-active .pill-count {
  color: var(--accent);
  font-weight: 600;
}

.tb-group-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.select-ctl-wrapper {
  position: relative;
  display: inline-flex;
  align-items: center;
}

.select-ctl {
  appearance: none;
  -webkit-appearance: none;
  display: inline-flex;
  align-items: center;
  height: 30px;
  padding: 0 24px 0 10px;
  border-radius: var(--r-sm);
  background: var(--surface-2);
  border: 1px solid var(--line);
  color: var(--text-2);
  font-size: calc(12px * var(--fs));
  cursor: pointer;
  outline: none;
}

.select-ctl:focus {
  border-color: var(--accent);
}

.select-arrow {
  position: absolute;
  right: 8px;
  pointer-events: none;
  width: 12px;
  height: 12px;
  color: var(--text-3);
}

/* 按钮基础 */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 30px;
  padding: 0 12px;
  border-radius: var(--r-sm);
  font-size: calc(12.5px * var(--fs));
  font-weight: 500;
  border: 0;
  cursor: pointer;
  white-space: nowrap;
  transition: all var(--dur-1, 120ms);
}

.btn .i {
  width: 14px;
  height: 14px;
}

.btn-ghost {
  background: transparent;
  color: var(--text-2);
  border: 1px solid var(--line);
}

.btn-ghost:hover {
  background: var(--surface-2);
  color: var(--text);
  border-color: var(--line-strong);
}

.btn-subtle {
  background: var(--surface-2);
  color: var(--text-2);
  border: 1px solid var(--line);
}

.btn-subtle:hover {
  background: var(--surface-3);
  color: var(--text);
}

.btn-icon-only {
  width: 30px;
  height: 30px;
  padding: 0;
}

.btn-sm {
  height: 26px;
  padding: 0 9px;
  font-size: calc(11.5px * var(--fs));
}

.btn-danger-ghost {
  background: transparent;
  color: var(--danger);
  border: 1px solid var(--danger-soft);
}

.btn-danger-ghost:hover {
  background: var(--danger-soft);
}

/* ---------- 批量操作条 (Batch Bar) ---------- */
.batch-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px;
  border-radius: var(--r-md);
  background: var(--accent-soft);
  border: 1px solid var(--accent-line);
  animation: slideDown 150ms var(--ease-out, ease-out);
}

@keyframes slideDown {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}

.batch-left {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: calc(12.5px * var(--fs));
  color: var(--text);
}

.batch-count-tag {
  display: inline-flex;
  align-items: center;
  font-weight: 600;
  color: var(--accent);
}

.batch-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 复选框定制 */
.custom-checkbox {
  width: 16px;
  height: 16px;
  border-radius: 4px;
  border: 1.5px solid var(--line-strong);
  display: grid;
  place-items: center;
  background: var(--solid);
  cursor: pointer;
  flex-shrink: 0;
  transition: all var(--dur-1, 120ms);
}

.custom-checkbox:hover {
  border-color: var(--accent);
}

.custom-checkbox.is-checked {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.custom-checkbox.is-checked .i {
  width: 12px;
  height: 12px;
  stroke: #fff;
  stroke-width: 2.5;
}

/* ---------- 文件类型图标与徽章 ---------- */
.file-badge-icon {
  width: 34px;
  height: 34px;
  border-radius: var(--r-sm);
  display: grid;
  place-items: center;
  flex-shrink: 0;
}

.file-badge-icon .i {
  width: 18px;
  height: 18px;
}

.file-badge-icon.type-sheet { background: rgba(16, 124, 65, .10); color: #107c41; }
.file-badge-icon.type-pkg { background: rgba(112, 72, 232, .10); color: #7048e8; }
.file-badge-icon.type-zip { background: rgba(217, 119, 6, .10); color: #d97706; }
.file-badge-icon.type-img { background: rgba(2, 132, 199, .10); color: #0284c7; }
.file-badge-icon.type-pdf { background: rgba(220, 38, 38, .10); color: #dc2626; }
.file-badge-icon.type-vector { background: rgba(5, 150, 105, .10); color: #059669; }
.file-badge-icon.type-code { background: rgba(100, 116, 139, .10); color: #64748b; }

/* ---------- 状态徽章 (Status Badges) ---------- */
.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  border-radius: var(--r-pill, 999px);
  font-size: calc(11.5px * var(--fs));
  font-weight: 500;
  white-space: nowrap;
}

.status-pill.is-done {
  background: var(--ok-soft);
  color: var(--ok-ink);
}

.status-pill.is-done .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ok);
}

.status-pill.is-failed {
  background: var(--danger-soft);
  color: var(--danger-ink);
}

.status-pill.is-failed .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--danger);
}

/* 下载进度条 */
.progress-meter {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 130px;
}

.progress-track {
  width: 100%;
  height: 5px;
  border-radius: 5px;
  background: var(--surface-3);
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  border-radius: 5px;
  background: var(--accent);
  transition: width var(--dur-2, 200ms);
}

.progress-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  color: var(--text-3);
}

/* 会话来源胶囊标签 */
.source-tag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: calc(12px * var(--fs));
  color: var(--text-2);
  background: transparent;
  border: 0;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
  transition: background var(--dur-1, 120ms), color var(--dur-1, 120ms);
}

.source-tag:hover {
  background: var(--surface-3);
  color: var(--accent);
}

.source-tag .i {
  width: 12px;
  height: 12px;
  color: var(--text-3);
}

/* 操作图标组 (Row actions) */
.row-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.action-icon-btn {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: var(--r-sm);
  color: var(--text-3);
  background: transparent;
  border: 0;
  cursor: pointer;
  transition: all var(--dur-1, 120ms);
}

.action-icon-btn .i {
  width: 15px;
  height: 15px;
}

.action-icon-btn:hover {
  background: var(--surface-3);
  color: var(--text);
}

.action-icon-btn.btn-action-primary:hover {
  background: var(--accent-soft);
  color: var(--accent);
}

.action-icon-btn.btn-action-danger:hover {
  background: var(--danger-soft);
  color: var(--danger);
}

.action-icon-btn.is-disabled {
  opacity: 0.35;
  cursor: not-allowed;
  pointer-events: none;
}

/* ---------- 方案 A：数据表格 (a-table) ---------- */
.scheme-table-card {
  border-radius: var(--r-lg);
  overflow: hidden;
  border: 1px solid var(--line);
  box-shadow: var(--shadow-1);
}

.tbl {
  width: 100%;
  border-collapse: collapse;
  font-size: calc(13px * var(--fs));
  text-align: left;
}

.tbl th {
  height: 36px;
  box-sizing: border-box;
  padding: 0 14px;
  background: var(--surface-2);
  border-bottom: 1px solid var(--line);
  color: var(--text-3);
  font-size: calc(12px * var(--fs));
  font-weight: 550;
  white-space: nowrap;
}

.tbl th.th-sort {
  cursor: pointer;
  user-select: none;
}

.tbl th.th-sort:hover {
  color: var(--text);
}

.tbl th.th-sort .sort-ic {
  width: 12px;
  height: 12px;
  display: inline-block;
  margin-left: 4px;
  vertical-align: -1px;
}

.tbl td {
  height: 44px;
  box-sizing: border-box;
  padding: 0 14px;
  border-bottom: 1px solid var(--line);
  vertical-align: middle;
}

.tbl tbody tr {
  transition: background-color var(--dur-1, 120ms);
}

.tbl tbody tr:hover {
  background: var(--surface-2);
}

.tbl tbody tr.is-selected {
  background: var(--accent-soft);
}

.tbl tbody tr.is-selected td:first-child {
  box-shadow: inset 2px 0 0 var(--accent);
}

.tbl tbody tr.is-failed-row {
  background: var(--danger-soft);
}

.file-cell {
  display: flex;
  align-items: center;
  gap: 12px;
}

.file-title-wrap {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.file-name {
  font-weight: 550;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 320px;
}

.file-path-hint {
  font-size: 11px;
  color: var(--text-3);
  font-family: var(--font-mono, monospace);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 300px;
}

/* ---------- 空状态 (Empty State) ---------- */
.empty-state-card {
  padding: 48px 24px;
  border-radius: var(--r-lg);
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 12px;
  border: 1px dashed var(--line-strong);
  background: var(--solid);
  box-shadow: var(--shadow-1);
}

.empty-icon-circle {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: var(--surface-3);
  display: grid;
  place-items: center;
  color: var(--text-3);
}

.empty-icon-circle .i {
  width: 28px;
  height: 28px;
}

.empty-title {
  font-size: calc(15px * var(--fs));
  font-weight: 650;
  color: var(--text);
}

.empty-desc {
  font-size: calc(12.5px * var(--fs));
  color: var(--text-3);
  max-width: 380px;
  margin: 0;
}
</style>
