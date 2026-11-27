<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { RefreshCw, RotateCw, Wifi, WifiOff, X } from 'lucide-vue-next'
import { desktopPlatform } from '../../desktop/platform'
import type { WorkbenchTheme } from '../../composables/useWorkbenchTheme'
import DesktopTitleBar from '../desktop/DesktopTitleBar.vue'
import { useCoreSync } from '../../composables/useCoreSync'
import { runAndroidSync } from '../../api/sync'
import { createSyncLoopController, DEFAULT_SYNC_FALLBACK_INTERVAL_MS } from '../../services/connectionHealth'
import { useWebsitesStore } from '../../stores/websites'
import { useSpaceStore } from '../../stores/space'
import {
  readStoredWidth,
  saveStoredWidth,
  sharedChatOccupiedWidth,
  startColumnDrag,
} from '../../composables/useResizableShell'
import { useAutomationStore } from '../../stores/automation'
import { useAuthStore } from '../../stores/auth'
import { useFleetStore } from '../../stores/fleet'
import AgentChatThread from '../chat/AgentChatThread.vue'
import FleetCoreSignIn from '../chat/FleetCoreSignIn.vue'
import { getProviderMeta } from '../chat/providerMeta'
import { version } from '../../../package.json'
import { useUpdater, formatBytes } from '../../composables/useUpdater'
import OpusSegment from '../ui/OpusSegment.vue'
import OpusIcon from '../ui/OpusIcon.vue'
import OpusSyncBadge from '../ui/OpusSyncBadge.vue'
import OpusQuickAdd from './OpusQuickAdd.vue'
import { footer, libraryItems, mobileTabs, navigation } from './opusNavigation'

interface ToastItem {
  id: number
  text: string
  out: boolean
}

const props = defineProps<{ page: string; downloadsActive: boolean; mobile: boolean; hideMobileTabbar?: boolean; toast: string; toastKey?: number; theme: WorkbenchTheme; mode: string; reducedMotion?: boolean }>()
const emit = defineEmits<{ navigate: [page: string, section?: 'downloads']; 'mobile-tab': [page: string]; create: [kind: string]; action: [message: string]; openSpace: [spaceId?: string]; syncSettings: []; back: []; toggleMode: []; toggleTheme: []; setTheme: [theme: WorkbenchTheme]; toggleReducedMotion: [] }>()
const auth = useAuthStore()
const automation = useAutomationStore()
const fleet = useFleetStore()
const space = useSpaceStore()
const attentionTasks = computed(() => automation.items.filter(item => {
  if (!item.enabled) return false
  const last = automation.runtimeExecutions.find(run => run.workflowId === item.id)
  return !last || last.status === 'failed'
}).length)
const { connection, syncStatus, syncError, busy, refresh, sync } = useCoreSync(message => emit('action', message))
const platform = desktopPlatform()
const android = platform === 'android'
const mac = platform === 'macos' || /Mac/i.test(navigator.platform)
const ctrl = mac ? '⌘' : 'Ctrl'

const SIDEBAR_EXPANDED_W = 232
const DOCK_DEFAULT_W = 380
const DOCK_MIN_W = 280
const DOCK_MAX_W = 560

function readStoredCollapsed(): boolean | null {
  try {
    const raw = localStorage.getItem('studiolo:sidebar-collapsed')
    if (raw === '1') return true
    if (raw === '0') return false
  } catch {
    // 忽略存储受限环境错误
  }
  return null
}

const windowEl = ref<HTMLElement | null>(null)
const windowWidth = ref(typeof window !== 'undefined' ? window.innerWidth : 1280)
const dockWidth = ref(readStoredWidth('studiolo:dock-width', DOCK_DEFAULT_W, DOCK_MIN_W, DOCK_MAX_W))
const manualCollapsed = ref<boolean | null>(readStoredCollapsed())
const autoCollapsed = ref(false)
const isResizing = ref(false)
const dockOpen = ref(false)

function recomputeAutoCollapse() {
  const minMainNeeded = props.page === 'Chat' ? 460 : 560
  const hysteresis = autoCollapsed.value ? 26 : 0
  const extraW = (props.page === 'Chat' ? sharedChatOccupiedWidth.value : 0) + (dockOpen.value ? dockWidth.value : 0)
  const remaining = windowWidth.value - SIDEBAR_EXPANDED_W - extraW
  const tightWindow = windowWidth.value < (autoCollapsed.value ? 926 : 900)
  const tightContent = remaining < (minMainNeeded + hysteresis)
  const shouldCollapse = tightWindow || tightContent
  autoCollapsed.value = shouldCollapse
  // 当空间恢复充足时，清除此前为适应窄屏自动生成的临时展开/收起状态，确保空间充足时恢复正常宽度
  if (!shouldCollapse && manualCollapsed.value === false) {
    manualCollapsed.value = null
  }
}

watch(
  [windowWidth, dockWidth, dockOpen, sharedChatOccupiedWidth, () => props.page],
  recomputeAutoCollapse,
  { immediate: true },
)

const collapsed = computed(() =>
  manualCollapsed.value !== null ? manualCollapsed.value : autoCollapsed.value,
)

function toggleSidebar() {
  const next = !collapsed.value
  // 手动点按切换后：若与当前自动判断结果一致则交回自动控制，否则持久记住点按状态
  manualCollapsed.value = next === autoCollapsed.value ? null : next
  try {
    if (manualCollapsed.value === null) localStorage.removeItem('studiolo:sidebar-collapsed')
    else localStorage.setItem('studiolo:sidebar-collapsed', manualCollapsed.value ? '1' : '0')
  } catch {
    // 忽略存储受限环境错误
  }
}

function handleDockDrag(event: PointerEvent) {
  if (event.button !== 0 || !event.isPrimary) return
  const previousWidth = dockWidth.value
  isResizing.value = true
  startColumnDrag({
    event,
    initialWidth: dockWidth.value,
    min: DOCK_MIN_W,
    max: DOCK_MAX_W,
    direction: -1,
    onPreview(width) {
      dockWidth.value = width
    },
    onCommit(width) {
      dockWidth.value = width
      saveStoredWidth('studiolo:dock-width', width)
    },
    onCancel() {
      dockWidth.value = previousWidth
    },
    onEnd() {
      isResizing.value = false
    },
  })
}

function resetDockWidth() {
  dockWidth.value = DOCK_DEFAULT_W
  saveStoredWidth('studiolo:dock-width', DOCK_DEFAULT_W)
}

watch(dockOpen, open => {
  if (open && auth.token) {
    void fleet.loadNodes()
    fleet.connectSocket()
  }
})
const updater = useUpdater()
const updatePopoverOpen = ref(false)

const showStatusbarUpdate = computed(() =>
  ['available', 'downloading', 'ready'].includes(updater.state.value),
)

const updateBtnTitle = computed(() => {
  switch (updater.state.value) {
    case 'checking':
      return '正在检查更新…'
    case 'available':
      return `发现新版本 v${updater.version.value || ''}`
    case 'downloading':
      return `下载中 ${updater.percent.value}%`
    case 'ready':
      return '重启以完成更新'
    case 'error':
      return `更新失败: ${updater.error.value || '未知错误'}`
    case 'up-to-date':
      return '已是最新版本'
    case 'idle':
    default:
      return '检查更新'
  }
})

const notesPreviewText = computed(() => {
  if (!updater.notes.value) return '包含性能优化与错误修复。'
  const lines = updater.notes.value
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
  return lines.length ? lines.join('\n') : '包含性能优化与错误修复。'
})

const installBtnRef = ref<HTMLButtonElement | null>(null)

watch(updatePopoverOpen, async open => {
  if (open) {
    await nextTick()
    installBtnRef.value?.focus()
  }
})

function handleUpdateClick() {
  const s = updater.state.value
  if (s === 'idle' || s === 'up-to-date' || s === 'error') {
    void updater.check({ force: true })
  } else if (s === 'available') {
    updatePopoverOpen.value = !updatePopoverOpen.value
  } else if (s === 'ready') {
    void updater.restart()
  }
}

function handleInstallFromPopover() {
  updatePopoverOpen.value = false
  void updater.install()
}

const panelOpen = ref(false)
const palette = ref<HTMLDialogElement>()
const query = ref('')
const commandIndex = ref(0)
const add = ref('')
function openQuickSpace(spaceId?: string) {
  add.value = ''
  emit('openSpace', spaceId)
}
const toasts = ref<ToastItem[]>([])
let toastSeq = 0
const navGroups = [...navigation, { section: '', items: footer }]
const activeGroup = computed(() => navGroups.find(group => group.items.some(item => item.page === props.page)))
const activeItem = computed(() => activeGroup.value?.items.find(item => item.page === props.page))
const inLibrary = computed(() => libraryItems.some(item => item.page === props.page))
const savedLibrary = ref('Ledger')
const mobileActive = ref('Home')
watch(() => props.page, page => {
  if (inLibrary.value) {
    savedLibrary.value = page
    mobileActive.value = 'Ledger'
  } else if (mobileTabs.some(tab => tab.page === page)) {
    mobileActive.value = page
  }
}, { immediate: true })

function pushToast(text: string) {
  if (!text) return
  const id = ++toastSeq
  for (const item of toasts.value) item.out = true
  toasts.value.push({ id, text, out: false })
  if (toasts.value.length > 3) toasts.value.shift()
  window.setTimeout(() => {
    const target = toasts.value.find(item => item.id === id)
    if (target) target.out = true
    window.setTimeout(() => {
      toasts.value = toasts.value.filter(item => item.id !== id)
    }, 360)
  }, 2600)
}
watch([() => props.toast, () => props.toastKey], ([text]) => {
  if (text) pushToast(text)
})

const syncKind = computed<'offline' | 'conflict' | 'pending' | 'synced'>(() => {
  if (auth.mode === 'core' && !android) return 'synced'
  if (!syncStatus.value?.connected) return 'offline'
  if (syncStatus.value.conflicts) return 'conflict'
  if (syncStatus.value.running || syncStatus.value.pending || syncStatus.value.inFlight || !syncStatus.value.lastSuccessAt) return 'pending'
  return 'synced'
})
const queued = computed(() => (syncStatus.value?.pending ?? 0) + (syncStatus.value?.inFlight ?? 0))
const syncLabel = computed(() => {
  if (auth.mode === 'core' && !android) return '直连 Core'
  const state = syncStatus.value
  if (!state) return syncError.value || '正在读取同步状态'
  if (!state.connected) return '离线 · 本机可用'
  if (state.blocked || state.lastError) return '同步需要处理'
  if (state.conflicts) return `${state.conflicts} 个冲突`
  if (state.running) return '正在同步'
  if (queued.value) return `${queued.value} 项待同步`
  return state.lastSuccessAt ? '已同步' : '等待首次同步'
})
const coreOnline = computed(() => auth.mode === 'core' || Boolean(syncStatus.value?.connected))
const fleetLocalOnline = computed(() => !coreOnline.value && fleet.wsState === 'online')
const coreLabel = computed(() => {
  if (coreOnline.value) {
    return connection.value?.connected ? `Core · ${connection.value.coreUrl}` : 'Core'
  }
  if (fleetLocalOnline.value) return '本地 Fleet 在线（未启用远程 Core 同步）'
  return 'Core 不可达'
})
const commandGroups = [
  { label: '跳转', items: [
    ...navGroups.flatMap(group => [...group.items]).map(item => ({ ...item, hint: '', run: () => go(item.page) })),
    { page: 'Agents', label: 'Agent 配置', icon: 'settings', hint: '身份与权限', run: () => go('Agents') },
    { page: 'Dashboard', label: '自定义仪表盘', icon: 'grid', hint: '调整布局', run: () => go('Dashboard') },
  ] },
  { label: '操作', items: [
    { page: 'ledger', label: '记一笔', icon: 'ledger', hint: '在「账本」新增', run: () => emit('create', 'ledger') },
    { page: 'website', label: '收藏网站', icon: 'globe', hint: '快速添加链接', run: () => emit('create', 'website') },
    { page: 'record', label: '新建数据记录', icon: 'data', hint: '数据集合', run: () => emit('create', 'record') },
    { page: 'device', label: '添加设备', icon: 'device', hint: '客户端绑定', run: () => emit('create', 'device') },
    { page: 'agent', label: '添加智能体', icon: 'sparkle', hint: 'Agent 运行时', run: () => emit('create', 'agent') },
    { page: 'automation', label: '新建自动化任务', icon: 'tasks', hint: '定时与触发', run: () => emit('create', 'automation') },
    { page: 'dock', label: '切换 Agent 侧板', icon: 'sidebar', hint: `${ctrl} J`, run: () => { dockOpen.value = !dockOpen.value } },
    { page: 'sync', label: '立即同步', icon: 'sync', hint: '推送待同步队列', run: () => sync() },
    { page: 'syncSettings', label: '处理冲突与同步设置', icon: 'alert', hint: 'Core 连接', run: () => openSyncSettings() },
  ] },
  { label: '外观', items: [
    { page: 'mode', label: '切换深色 / 浅色', icon: 'moon', hint: '外观模式', run: () => emit('toggleMode') },
    { page: 'theme', label: '切换主题（Liquid Glass / 纸墨 / 纯白）', icon: 'layers', hint: '工作台主题', run: () => emit('toggleTheme') },
  ] },
] as const
const commands = computed(() => {
  const term = query.value.trim().toLowerCase()
  return commandGroups.flatMap(group => group.items.filter(item =>
    [item.label, item.page, group.label, item.hint].some(label => label.toLowerCase().includes(term)),
  ).map((item, index) => ({ ...item, group: index === 0 ? group.label : '' })))
})
function runCommand(index: number) {
  const command = commands.value[index]
  if (!command) return
  palette.value?.close()
  void command.run()
}
async function moveCommand(step: number) {
  if (!commands.value.length) return
  commandIndex.value = (commandIndex.value + step + commands.value.length) % commands.value.length
  await nextTick()
  palette.value?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
}
function go(page: string, mobileTab = false, section?: 'downloads') {
  palette.value?.close()
  panelOpen.value = false
  updatePopoverOpen.value = false
  add.value = ''
  if (mobileTab) emit('mobile-tab', page)
  else emit('navigate', page, section)
}
function openPalette() {
  query.value = ''
  commandIndex.value = 0
  palette.value?.showModal()
}
function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    add.value = ''
    panelOpen.value = false
    updatePopoverOpen.value = false
  }
  if (props.mobile || !(event.ctrlKey || event.metaKey)) return
  if (event.key.toLowerCase() === 'k') {
    event.preventDefault()
    openPalette()
  }
  if (event.key.toLowerCase() === 'j') {
    event.preventDefault()
    dockOpen.value = !dockOpen.value
  }
  const target = event.target instanceof Element ? event.target : null
  const editable = !!target?.closest('input, textarea, select, [contenteditable="true"]')
  if (event.key.toLowerCase() === 'b' && !editable) {
    event.preventDefault()
    toggleSidebar()
  }
}
function dismissSync(event: PointerEvent) {
  if (panelOpen.value && event.target instanceof Element && !event.target.closest('.sync-panel, .sync-pill, .sb-item, .mpill')) {
    panelOpen.value = false
  }
  if (updatePopoverOpen.value && event.target instanceof Element && !event.target.closest('.update-popover, .update-btn')) {
    updatePopoverOpen.value = false
  }
}
function openSyncSettings() {
  panelOpen.value = false
  emit('syncSettings')
}
async function refreshState() {
  await refresh()
  emit('action', '已刷新同步与页面状态')
}
function logoutAccount() {
  emit('action', '已退出登录')
  auth.logout()
}
function handleMobileBack() {
  if (!add.value && !panelOpen.value) return false
  add.value = ''
  panelOpen.value = false
  return true
}
defineExpose({ openDock: () => { dockOpen.value = true }, handleMobileBack })
let resizeObserver: ResizeObserver | null = null
let androidSyncActive = false
async function syncAndroidForeground() {
  const state = syncStatus.value
  if (androidSyncActive || !state?.connected || state.running || state.blocked || document.hidden || !navigator.onLine) return
  if (state.nextRetryAt && Date.parse(state.nextRetryAt) > Date.now()) return
  if (state.lastError && !state.nextRetryAt) return
  androidSyncActive = true
  try {
    const result = await runAndroidSync()
    if (result.pulled || result.pushed) useWebsitesStore().invalidate()
  } catch {
    // Rust persists the reason and retry deadline for the next status poll.
  } finally {
    androidSyncActive = false
  }
}
async function syncSpaceForeground() {
  if (document.hidden || !navigator.onLine) return
  await space.syncPending()
  if (props.page === 'Space' && space.selectedSpace?.tier === 'standard') {
    await space.refreshCurrentSpace()
  }
}
const spaceSyncLoop = createSyncLoopController({
  runSync: syncSpaceForeground,
  fallbackIntervalMs: DEFAULT_SYNC_FALLBACK_INTERVAL_MS,
})
const androidSyncLoop = android
  ? createSyncLoopController({
      runSync: syncAndroidForeground,
      fallbackIntervalMs: DEFAULT_SYNC_FALLBACK_INTERVAL_MS,
    })
  : null
watch(() => space.route, route => { if (route) spaceSyncLoop.trigger() })
onMounted(() => {
  if (platform !== 'web') {
    void fleet.loadNodes()
    fleet.connectSocket()
  }
  document.addEventListener('keydown', keydown)
  document.addEventListener('pointerdown', dismissSync)
  spaceSyncLoop.start()
  androidSyncLoop?.start()
  if (typeof ResizeObserver !== 'undefined' && windowEl.value) {
    resizeObserver = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width
      if (width && width > 0) windowWidth.value = width
    })
    resizeObserver.observe(windowEl.value)
  }
})
onUnmounted(() => {
  document.removeEventListener('keydown', keydown)
  document.removeEventListener('pointerdown', dismissSync)
  spaceSyncLoop.stop()
  androidSyncLoop?.stop()
  resizeObserver?.disconnect()
  resizeObserver = null
})
</script>

<template>
  <div class="opus-shell" :data-platform="mac ? 'mac' : 'win'">
    <template v-if="mobile">
      <div class="screen">
        <div class="glass-wallpaper" aria-hidden="true"></div>
        <div class="mview">
          <slot :sync-status="syncStatus" :sync-label="syncLabel" :sync-kind="syncKind" :open-sync="openSyncSettings" :in-library="inLibrary" />
        </div>
        <nav v-if="!hideMobileTabbar" class="tabbar" aria-label="主导航">
          <template v-for="tab in mobileTabs" :key="tab.page">
            <div v-if="tab.page === '+'" class="tab-add"><button type="button" aria-label="快速新增" :aria-expanded="!!add" @click="add = add ? '' : 'tx'"><OpusIcon name="plus" /></button></div>
            <button v-else class="tab" type="button" :aria-current="mobileActive === tab.page ? 'page' : undefined" @click="go(tab.page === 'Ledger' ? savedLibrary : tab.page, true)">
              <span class="ico"><OpusIcon :name="tab.icon" /></span>{{ tab.label }}
              <span v-if="tab.page === 'Home' && syncStatus?.conflicts" class="badge">{{ syncStatus.conflicts }}</span><span v-if="tab.page === 'Chat' && fleet.pendingApprovalsList.length" class="badge">{{ fleet.pendingApprovalsList.length }}</span><span v-if="tab.page === 'Automation' && attentionTasks" class="badge">{{ attentionTasks }}</span>
            </button>
          </template>
        </nav>
        <OpusQuickAdd :kind="add" :offline="syncKind === 'offline'" @change="add = $event" @create="add = ''; emit('create', $event)" @action="emit('action', $event)" @open-share="openQuickSpace" />
        <div class="toast-host mtoast"><div v-for="item in toasts" :key="item.id" class="toast" :class="{ out: item.out }" role="status">{{ item.text }}</div></div>
      </div>
    </template>
    <div v-else class="stage">
      <div
        ref="windowEl"
        class="window"
        :class="{ 'nav-collapsed': collapsed, 'dock-open': dockOpen, 'is-resizing': isResizing }"
        :style="{ '--dock-w': `${dockWidth}px` }"
      >
        <div class="glass-wallpaper" aria-hidden="true"></div>
        <DesktopTitleBar
          v-if="platform !== 'macos'"
          authenticated
          :workstation="auth.workstation"
          :theme="theme"
          :mode="mode"
          :reduced-motion="reducedMotion"
          :sidebar-collapsed="collapsed"
          :dock-open="dockOpen"
          :sync-connected="!!syncStatus?.connected"
          @navigate="go"
          @create="emit('create', $event)"
          @open-palette="openPalette"
          @toggle-sidebar="toggleSidebar"
          @toggle-dock="dockOpen = !dockOpen"
          @sync="sync"
          @open-sync-settings="openSyncSettings"
          @set-theme="emit('setTheme', $event)"
          @toggle-mode="emit('toggleMode')"
          @toggle-reduced-motion="emit('toggleReducedMotion')"
          @back="emit('back')"
          @refresh="refreshState"
          @logout="logoutAccount"
          @action="emit('action', $event)"
        />
        <div v-else class="titlebar" data-tauri-drag-region>
          <div class="tb-left opus-mac" data-tauri-drag-region>
            <button class="icon-btn" type="button" aria-label="折叠侧栏" title="折叠侧栏" :aria-pressed="collapsed" @click="toggleSidebar"><OpusIcon name="panel" /></button>
          </div>
          <div class="tb-mid" data-tauri-drag-region>
            <div class="crumbs" data-tauri-drag-region><template v-if="activeGroup?.section"><span>{{ activeGroup.section }}</span><OpusIcon name="chevR" /></template><b>{{ activeItem?.label ?? (page === 'Agents' ? 'Agent 配置' : '仪表盘') }}</b></div>
            <button class="cmdk" type="button" aria-label="搜索或执行命令" @click="openPalette"><OpusIcon name="search" /><span>搜索或执行命令</span><span class="kbd">{{ ctrl }}</span><span class="kbd">K</span></button>
          </div>
          <div class="tb-right">
            <button class="sync-pill" type="button" aria-label="同步状态" :aria-expanded="panelOpen" @click="panelOpen = !panelOpen"><OpusSyncBadge :kind="syncKind" :label="syncLabel" /></button>
            <button class="icon-btn" type="button" aria-label="Agent 侧板" :title="'Agent 侧板（' + ctrl + ' J）'" :aria-pressed="dockOpen" @click="dockOpen = !dockOpen"><OpusIcon name="sidebar" /></button>
          </div>
        </div>
        <div class="win-body">
          <nav class="sidebar" aria-label="主导航">
            <div class="sidebar-scroll">
              <template v-for="group in navigation" :key="group.section">
                <div v-if="group.section" class="nav-sec">{{ group.section }}</div>
                <button v-for="item in group.items" :key="item.page" class="nav-item" type="button" :title="item.label" :aria-current="page === item.page ? 'page' : undefined" @click="go(item.page)">
                  <OpusIcon :name="item.icon" /><span class="label">{{ item.label }}</span>
                  <span v-if="item.page === 'Chat' && fleet.pendingApprovalsList.length" class="nav-badge-dot" :title="`有 ${fleet.pendingApprovalsList.length} 项待审批命令`" />
                  <OpusIcon v-if="item.page === 'Space'" name="lock" class="lockmark" /><span v-if="item.page === 'Automation' && attentionTasks" class="count" style="color:var(--danger)">●</span>
                </button>
              </template>
              <div class="nav-foot">
                <button v-for="item in footer" :key="item.page" class="nav-item" type="button" :title="item.label" :aria-current="page === item.page && !downloadsActive ? 'page' : undefined" @click="go(item.page)"><OpusIcon :name="item.icon" /><span class="label">{{ item.label }}</span><span v-if="item.page === 'Settings' && syncStatus?.conflicts" class="count alert">{{ syncStatus.conflicts }}</span></button>
                <button class="nav-item" type="button" title="下载记录" :aria-current="downloadsActive ? 'page' : undefined" @click="go('Settings', false, 'downloads')">
                  <OpusIcon name="download" /><span class="label">下载记录</span>
                </button>
                <button
                  class="nav-item nav-item--collapse"
                  type="button"
                  :aria-label="collapsed ? '展开侧栏' : '收起侧栏'"
                  :title="`${collapsed ? '展开侧栏' : '收起为单图标侧栏'}（${ctrl} B）`"
                  :aria-pressed="collapsed"
                  @click="toggleSidebar"
                >
                  <OpusIcon name="panel" /><span class="label">{{ collapsed ? '展开侧栏' : '收起侧栏' }}</span>
                </button>
              </div>
            </div>
            <button
              type="button"
              class="sidebar-edge-toggle"
              data-tauri-drag-region="false"
              :aria-label="collapsed ? '展开左侧导航栏' : '收起为单图标侧栏'"
              :title="`${collapsed ? '点击展开左侧导航栏' : '点击收起为单图标侧栏'}（${ctrl} B）`"
              :aria-pressed="collapsed"
              @click="toggleSidebar"
            />
          </nav>
          <main id="main" class="main" tabindex="-1" data-desktop-scroll>
            <slot :sync-status="syncStatus" :sync-label="syncLabel" :sync-kind="syncKind" :open-sync="openSyncSettings" :in-library="false" />
          </main>
          <aside class="dock" aria-label="Agent 侧板" :inert="!dockOpen">
            <div
              v-if="dockOpen"
              class="col-resizer col-resizer--left"
              data-tauri-drag-region="false"
              title="左右拖拽调整侧板宽度（双击还原）"
              @pointerdown="handleDockDrag"
              @dblclick="resetDockWidth"
            />
            <div v-if="dockOpen" class="dock-inner">
              <div class="dock-h">
                <select
                  v-if="fleet.nodes.length"
                  class="input"
                  style="height:28px;font-size:calc(12px * var(--fs));max-width:128px;padding:0 8px"
                  :value="fleet.selectedNode?.id || ''"
                  aria-label="选择控制节点"
                  @change="fleet.selectNode(($event.target as HTMLSelectElement).value)"
                >
                  <option v-for="n in fleet.nodes" :key="n.id" :value="n.id">{{ n.name }}</option>
                </select>
                <OpusSegment role="group" aria-label="选择 Agent">
                  <button
                    v-for="prov in fleet.availableProviders.slice(0, 2)"
                    :key="prov"
                    type="button"
                    :aria-pressed="fleet.selectedProvider === prov"
                    @click="fleet.selectProvider(prov)"
                  >{{ getProviderMeta(prov).label }}</button>
                </OpusSegment>
                <span class="spacer"></span>
                <button class="icon-btn" type="button" aria-label="在 Agent 页打开" title="在 Agent 页打开" @click="go('Chat')"><OpusIcon name="external" /></button>
                <button class="icon-btn" type="button" aria-label="关闭 Agent 侧板" @click="dockOpen = false"><OpusIcon name="x" /></button>
              </div>
              <FleetCoreSignIn v-if="fleet.coreSignInUrl" />
              <AgentChatThread v-else compact @action="emit('action', $event)" @open-handoff="go('Chat')" />
            </div>
          </aside>
        </div>
        <footer class="statusbar">
          <button
            class="sb-item"
            type="button"
            aria-haspopup="true"
            aria-controls="sync-panel"
            :aria-expanded="panelOpen"
            :title="coreLabel"
            :aria-label="'连接状态：' + (coreOnline ? 'Core 在线' : fleetLocalOnline ? '本地 Fleet 在线' : 'Core 离线')"
            @click="panelOpen = !panelOpen"
          >
            <Wifi v-if="coreOnline" :size="13" :stroke-width="2" style="color:var(--ok)" />
            <Wifi v-else-if="fleetLocalOnline" :size="13" :stroke-width="2" style="color:var(--ok)" />
            <WifiOff v-else :size="13" :stroke-width="2" style="color:var(--danger)" />
            <span>{{ fleetLocalOnline ? '本地 · Fleet' : 'Core' }}</span>
          </button>
          <span class="spacer"></span>
          <span class="sb-item faint">v{{ version }}</span>
          <button
            v-if="showStatusbarUpdate"
            class="update-btn"
            type="button"
            :class="{
              'is-checking': updater.state.value === 'checking',
              'is-downloading': updater.state.value === 'downloading',
              'is-ready': updater.state.value === 'ready',
              'is-error': updater.state.value === 'error',
              'has-update': updater.state.value === 'available',
              'motion-reduced': props.reducedMotion,
            }"
            :style="updater.state.value === 'downloading' ? { '--dl-percent': `${updater.percent.value}%` } : undefined"
            :title="updateBtnTitle"
            :aria-label="updateBtnTitle"
            @click="handleUpdateClick"
          >
            <div class="update-btn-inner">
              <RotateCw v-if="updater.state.value === 'ready'" :size="13" :stroke-width="2" />
              <RefreshCw
                v-else
                :size="13"
                :stroke-width="2"
                :class="{ 'spin-icon': updater.state.value === 'checking' }"
              />
            </div>
            <span v-if="updater.state.value === 'available'" class="update-dot" aria-hidden="true" />
            <span
              v-if="updater.state.value === 'downloading'"
              class="update-progress-bubble mono"
              aria-hidden="true"
            >{{ updater.percent.value }}%</span>
          </button>
        </footer>
        <div
          v-if="updatePopoverOpen && updater.state.value === 'available'"
          class="update-popover mat-solid"
          role="dialog"
          aria-label="版本更新"
        >
          <div class="update-popover-header">
            <span class="update-popover-title">发现新版本</span>
            <button
              type="button"
              class="update-popover-close"
              aria-label="关闭更新提示"
              title="关闭"
              @click="updatePopoverOpen = false"
            >
              <X :size="13" :stroke-width="2" />
            </button>
          </div>
          <div class="update-popover-meta">
            <span class="update-ver-chip mono">v{{ updater.version.value }}</span>
            <span v-if="updater.contentLength.value" class="update-size faint mono">{{ formatBytes(updater.contentLength.value) }}</span>
          </div>
          <p v-if="notesPreviewText" class="update-popover-notes">{{ notesPreviewText }}</p>
          <div class="update-popover-actions">
            <button
              ref="installBtnRef"
              type="button"
              class="btn btn-primary btn-sm update-act-btn"
              @click="handleInstallFromPopover"
            >
              下载并安装
            </button>
            <div class="update-popover-footer">
              <button
                type="button"
                class="btn btn-ghost btn-sm update-later-btn"
                @click="updatePopoverOpen = false"
              >
                稍后
              </button>
            </div>
          </div>
          <div class="update-popover-arrow" aria-hidden="true" />
        </div>
        <div id="sync-panel" class="sync-panel" :hidden="!panelOpen">
          <h3>同步</h3>
          <div class="faint" style="font-size:calc(12.5px * var(--fs))">{{ syncStatus?.lastSuccessAt ? '最近同步 ' + new Date(syncStatus.lastSuccessAt).toLocaleString() : syncLabel }}</div>
          <div v-if="auth.mode === 'local'" class="queue">
            <div v-if="queued" class="row"><span class="tile-icon" style="width:26px;height:26px"><OpusIcon name="sync" /></span><span class="grow"><div class="title" style="font-size:calc(12.5px * var(--fs))">{{ queued }} 项待同步</div><div class="sub">更改已保存在本机，联网后同步到 Core</div></span><OpusSyncBadge kind="pending" label="排队中" /></div>
            <div v-if="syncStatus?.conflicts" class="row"><span class="tile-icon" style="width:26px;height:26px"><OpusIcon name="alert" /></span><span class="grow"><div class="title" style="font-size:calc(12.5px * var(--fs))">{{ syncStatus.conflicts }} 个冲突待处理</div><div class="sub">需要确认保留本机或 Core 版本</div></span><button type="button" class="btn btn-sm btn-danger" @click="openSyncSettings">处理冲突</button></div>
            <div v-if="!queued && !syncStatus?.conflicts" class="cleared" style="padding:20px"><OpusIcon :name="syncKind === 'offline' ? 'wifiOff' : 'checks'" />{{ syncKind === 'offline' ? '离线：所有更改都已保存在本机' : '所有更改均已同步' }}</div>
          </div>
          <div v-if="auth.mode === 'local'" style="display:flex;gap:8px;align-items:center"><span class="faint" style="font-size:calc(11.5px * var(--fs));flex:1">共享空间只同步密文，这里不显示内容名称。</span><button type="button" class="btn btn-ghost btn-sm" @click="openSyncSettings">同步设置</button><button type="button" class="btn btn-primary btn-sm" :disabled="!syncStatus?.connected || busy || syncStatus.running" @click="sync()"><OpusIcon name="sync" />立即同步</button></div>
        </div>
        <div class="toast-host desk"><div v-for="item in toasts" :key="item.id" class="toast" :class="{ out: item.out }" role="status">{{ item.text }}</div></div>
      </div>
      <dialog ref="palette" class="dlg palette" aria-label="命令面板" closedby="any">
        <div class="pal-input"><OpusIcon name="search" /><input v-model="query" placeholder="跳转到页面、执行操作、搜索记录…" autocomplete="off" autofocus role="combobox" aria-expanded="true" aria-controls="pal-list" :aria-activedescendant="commands.length ? 'pal-choice-' + commandIndex : undefined" @input="commandIndex = 0" @keydown.down.prevent="moveCommand(1)" @keydown.up.prevent="moveCommand(-1)" @keydown.enter.prevent="runCommand(commandIndex)"><span class="kbd">Esc</span></div>
        <div id="pal-list" class="pal-list" role="listbox">
          <template v-for="(item, index) in commands" :key="item.page">
            <div v-if="item.group" class="pal-group">{{ item.group }}</div>
            <button :id="'pal-choice-' + index" class="pal-item" type="button" role="option" :aria-selected="index === commandIndex" @click="runCommand(index)"><OpusIcon :name="item.icon" />{{ item.label }}<span v-if="item.hint" class="hint">{{ item.hint }}</span></button>
          </template>
          <div v-if="!commands.length" class="cleared" style="padding:30px">没有匹配的命令</div>
        </div>
      </dialog>
    </div>
  </div>
</template>

<style scoped>
.update-btn {
  width: 24px;
  height: 24px;
  min-width: 24px;
  min-height: 24px;
  max-width: 24px;
  max-height: 24px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: #0f1115;
  color: #ffffff;
  cursor: pointer;
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  outline: none;
  margin-left: 8px;
  margin-right: 0;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.12);
  transition: transform 160ms ease, box-shadow 160ms ease, background 180ms ease, color 180ms ease;
  box-sizing: border-box;
}

:global([data-mode="dark"]) .update-btn {
  background: rgba(255, 255, 255, 0.9);
  color: #0f1115;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.12);
}

.update-btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 10px rgba(0, 0, 0, 0.25), inset 0 0 0 1px rgba(255, 255, 255, 0.12);
}

:global([data-mode="dark"]) .update-btn:hover {
  box-shadow: 0 4px 10px rgba(0, 0, 0, 0.35), inset 0 0 0 1px rgba(255, 255, 255, 0.12);
}

.update-btn:hover .update-btn-inner svg:not(.spin-icon) {
  transform: rotate(18deg);
}

.update-btn:active {
  transform: scale(0.92);
  transition: transform 90ms ease;
}

.update-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--surface), 0 0 0 4px var(--accent), inset 0 0 0 1px rgba(255, 255, 255, 0.12);
}

.update-btn-inner {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}

.update-btn-inner svg {
  display: block;
  transition: transform 160ms ease, color 180ms ease;
}

/* checking */
.update-btn.is-checking {
  background: #20242e;
}
:global([data-mode="dark"]) .update-btn.is-checking {
  background: #ffffff;
}

/* available */
.update-btn.has-update::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 50%;
  pointer-events: none;
  animation: updateHalo 2s cubic-bezier(0.24, 0, 0.38, 1) infinite;
}
.update-btn.has-update:hover::before {
  animation-duration: 1s;
}
@keyframes updateHalo {
  0% {
    box-shadow: 0 0 0 0 var(--accent);
    opacity: 0.8;
  }
  70% {
    box-shadow: 0 0 0 6px var(--accent);
    opacity: 0;
  }
  100% {
    box-shadow: 0 0 0 6px var(--accent);
    opacity: 0;
  }
}
.update-dot {
  position: absolute;
  top: -1px;
  right: -1px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  border: 1.5px solid #0f1115;
  pointer-events: none;
  z-index: 2;
  box-sizing: border-box;
}
:global([data-mode="dark"]) .update-dot {
  border-color: rgba(255, 255, 255, 0.9);
}

/* downloading */
.update-btn.is-downloading {
  background: conic-gradient(var(--accent) var(--dl-percent, 0%), rgba(255, 255, 255, 0.15) 0);
  padding: 2px;
}
:global([data-mode="dark"]) .update-btn.is-downloading {
  background: conic-gradient(var(--accent) var(--dl-percent, 0%), rgba(0, 0, 0, 0.2) 0);
}
.update-btn.is-downloading .update-btn-inner {
  background: #0f1115;
  color: #ffffff;
  border-radius: 50%;
}
.update-progress-bubble {
  position: absolute;
  bottom: calc(100% + 7px);
  left: 50%;
  transform: translateX(-50%) translateY(2px);
  padding: 2px 6px;
  border-radius: 999px;
  background: #0f1115;
  color: #ffffff;
  font-size: calc(10.5px * var(--fs));
  line-height: 1.2;
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
  transition: opacity 140ms ease, transform 140ms ease;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35);
  border: 1px solid rgba(255, 255, 255, 0.12);
  z-index: 50;
}
.update-progress-bubble::after {
  content: '';
  position: absolute;
  top: 100%;
  left: 50%;
  transform: translateX(-50%);
  border: 3.5px solid transparent;
  border-top-color: #0f1115;
}
.update-btn:hover .update-progress-bubble {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}

/* ready */
@keyframes nudge {
  0%, 100% {
    transform: translateY(0);
  }
  25% {
    transform: translateY(-3px);
  }
  50% {
    transform: translateY(1px);
  }
  75% {
    transform: translateY(-1.5px);
  }
}
.update-btn.is-ready {
  animation: nudge 600ms cubic-bezier(0.2, 0.8, 0.2, 1) 1;
}

/* error */
.update-btn.is-error {
  box-shadow: 0 0 0 1px var(--danger), inset 0 0 0 1px rgba(255, 255, 255, 0.12);
  color: var(--danger);
}
:global([data-mode="dark"]) .update-btn.is-error {
  box-shadow: 0 0 0 1px var(--danger), inset 0 0 0 1px rgba(255, 255, 255, 0.12);
  color: var(--danger);
}

/* spin */
.spin-icon {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* popover */
.update-popover {
  position: fixed;
  z-index: 60;
  right: 8px;
  bottom: 36px;
  width: 260px;
  padding: 12px 14px;
  border-radius: var(--r-lg);
  border: 1px solid var(--line);
  background: var(--solid);
  box-shadow: var(--shadow-pop);
  display: flex;
  flex-direction: column;
  gap: 8px;
  transform-origin: bottom right;
  animation: popoverIn 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
  box-sizing: border-box;
}
@keyframes popoverIn {
  from {
    opacity: 0;
    transform: scale(0.96) translateY(4px);
  }
  to {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}
[data-theme="glass"] .update-popover {
  background: var(--surface);
  backdrop-filter: var(--material-filter);
  -webkit-backdrop-filter: var(--material-filter);
}
.update-popover-arrow {
  position: absolute;
  bottom: -5px;
  right: 8px;
  width: 8px;
  height: 8px;
  transform: rotate(45deg);
  background: var(--solid);
  border-right: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
  pointer-events: none;
}
[data-theme="glass"] .update-popover-arrow {
  background: var(--surface);
}
.update-popover-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.update-popover-title {
  font-size: calc(13px * var(--fs));
  font-weight: 600;
  color: var(--text);
}
.update-popover-close {
  width: 24px;
  height: 24px;
  min-width: 24px;
  min-height: 24px;
  padding: 0;
  border: none;
  border-radius: var(--r-sm, 6px);
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background 150ms ease, color 150ms ease;
}
.update-popover-close:hover {
  background: var(--surface-2);
  color: var(--text);
}
.update-popover-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.update-ver-chip {
  display: inline-flex;
  align-items: center;
  padding: 2px 7px;
  border-radius: 999px;
  font-size: calc(11.5px * var(--fs));
  font-weight: 600;
  color: var(--accent);
  background: var(--accent-soft, rgba(59, 130, 246, 0.12));
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}
.update-size {
  color: var(--text-3);
  font-size: calc(11px * var(--fs));
}
.update-popover-notes {
  font-size: calc(11.5px * var(--fs));
  color: var(--text-2);
  line-height: 1.45;
  margin: 0;
  white-space: pre-line;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  text-overflow: ellipsis;
  word-break: break-word;
}
.update-popover-actions {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 2px;
}
.update-act-btn {
  width: 100%;
  justify-content: center;
  font-size: calc(12.5px * var(--fs));
}
.update-popover-footer {
  display: flex;
  justify-content: flex-end;
}
.update-later-btn {
  font-size: calc(11.5px * var(--fs));
  color: var(--text-3);
  padding: 2px 8px;
  height: 24px;
}
.update-later-btn:hover {
  color: var(--text);
}

/* Reduced motion */
@media (prefers-reduced-motion: reduce) {
  .update-btn,
  .update-btn-inner svg,
  .update-btn.is-ready,
  .update-btn.has-update::before,
  .spin-icon,
  .update-popover {
    animation: none !important;
    transition: none !important;
  }
  .update-btn:hover {
    transform: none !important;
  }
  .update-btn:hover .update-btn-inner svg {
    transform: none !important;
  }
  .update-btn.has-update::before {
    display: none !important;
  }
}
:global([data-motion="reduced"]) .update-btn,
:global([data-motion="reduced"]) .update-btn-inner svg,
:global([data-motion="reduced"]) .update-btn.is-ready,
:global([data-motion="reduced"]) .update-btn.has-update::before,
:global([data-motion="reduced"]) .spin-icon,
:global([data-motion="reduced"]) .update-popover {
  animation: none !important;
  transition: none !important;
}
:global([data-motion="reduced"]) .update-btn:hover {
  transform: none !important;
}
:global([data-motion="reduced"]) .update-btn:hover .update-btn-inner svg {
  transform: none !important;
}
:global([data-motion="reduced"]) .update-btn.has-update::before {
  display: none !important;
}
.update-btn.motion-reduced,
.update-btn.motion-reduced .update-btn-inner svg,
.update-btn.motion-reduced::before {
  animation: none !important;
  transition: none !important;
}
.update-btn.motion-reduced:hover {
  transform: none !important;
}
.update-btn.motion-reduced:hover .update-btn-inner svg {
  transform: none !important;
}
.update-btn.motion-reduced::before {
  display: none !important;
}
</style>
