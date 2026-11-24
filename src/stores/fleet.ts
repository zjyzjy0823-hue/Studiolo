/**
 * Studiolo Fleet 状态容器。Core 只转发聊天，设备端可加密保存历史和待发消息。
 */

import { defineStore } from 'pinia'
import { Channel, invoke } from '@tauri-apps/api/core'
import { computed, nextTick, onScopeDispose, ref, shallowReactive, watch } from 'vue'
import { apiRequest, ApiError } from '../api/client'
import { androidInvoke, isAndroidLocal } from '../desktop/androidLocal'
import { desktopPlatform } from '../desktop/platform'
import { decodeBase64Url, downloadAndDecryptBlob, encryptAndUploadFile } from '../services/blobTransfer'
import { normalizeCoreOrigin } from '../services/fleetUrl'
import { FleetLocalStore, type FleetOutboxItem } from '../services/fleetLocal'
import { createSessionSync, readSyncMode } from '../services/sessionSync'
import {
  buildFleetWsUrl,
  createFleetNode,
  deleteFleetNode,
  fetchHermesMedia,
  getApiBaseUrl,
  listFleetNodes,
  revokeFleetNode,
  rotateFleetNodeToken,
} from '../services/fleet'
import type {
  AdapterProvider,
  AgentModeOption,
  AgentNode,
  ApprovalDecision,
  ArtifactRef,
  ChatContextUsage,
  ChatMessage,
  ChatSession,
  ChatSystemEvent,
  CheckpointInfo,
  ProjectPermission,
  ProjectPermissionSetting,
  DiffAnnotation,
  DiffFileEntry,
  FilePreviewState,
  FleetConnectionState,
  FleetUsageDay,
  FleetWsEvent,
  FleetModel,
  McpServerInfo,
  MessageFormRequest,
  QueuedPromptItem,
  RunOptions,
  NodePlatform,
  NodeTokenOut,
  PermissionRequestCard,
  SessionDiffState,
  SessionTokenUsage,
  SubscriptionQuota,
  SubscriptionQuotaProvider,
  TerminalSessionState,
  TodoItem,
  WorkspaceRule,
  WorkspaceSkill,
  WorkspaceTreeEntry,
} from '../types/fleet'
import { buildSessionHtmlReport } from '../services/htmlExport'
import {
  appendMessagePart,
  branchFromUserMessage,
  buildDiffAnnotationsPrompt,
  buildForkContextSeed,
  buildSessionMarkdown,
  deriveOptimisticSessionTitle,
  redactSessionTitleCredentials,
  isGenericSessionTitle,
  mergeToolCallUpdate,
  mergeHistoryBoundaries,
  sameTurnContent,
  switchMessageBranch,
} from '../services/chatHelpers'
import { loadSoundPref, playCueSound, saveSoundPref } from '../services/soundCue'
import { useRecordedTokenUsage } from '../services/recordedTokenUsage'
import {
  applyTokenUsageEvent,
  estimateTurnUsageFallback,
  hasRecordedTurnUsage,
  toSessionTokenSummary,
  type SessionTokenState,
  type TokenUsageInput,
} from '../services/tokenUsage'
import { resolveSavedModelPref, saveAgentModelPref } from '../services/modelPrefs'
import { saveBlobToDevice } from '../services/saveDownload'
import { useAuthStore } from './auth'

const MAX_MESSAGES_PER_SESSION = 500
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000]
const STREAM_BUFFER_CAP = 1000
const SUBSCRIBE_TIMEOUT_MS = 5000
const HISTORY_TIMEOUT_MS = 10000
const SUBSCRIBE_RETRY_DELAYS_MS = [500, 1000]
type StreamPhase = 'live' | 'gap' | 'resyncing'
type StreamState = {
  phase: StreamPhase
  buffer: FleetWsEvent[]
  retries: number
  timer?: ReturnType<typeof setTimeout>
  snapshotTimer?: ReturnType<typeof setTimeout>
  // Sequence numbers belong to a stream generation, while lastSeqBySession is a monotonic watermark.
  cursors: Map<string, number>
  snapshot?: { requestId?: string; streamId?: string; lastSeq: number }
}
const DESKTOP_NOTIFICATION_PREF = 'studiolo:fleet-system-notifications'
type NativeFleetEvent =
  | { event: 'frame'; frame: FleetWsEvent }
  | { event: 'reconnecting' | 'unauthorized' }

type AuditEntry = {
  t: number
  type: string
  session: string
  run: string
  stream: string
  seq: number | string
  call: string
  error?: string
}

function auditField(value: unknown, limit?: number): string {
  if (typeof value !== 'string' || !value) return '-'
  const field = limit === undefined ? value : Array.from(value).slice(0, limit).join('')
  return field.replace(/[\r\n]/g, '_')
}

type SnapshotFollowIntent = {
  followBefore: boolean
  cancelled: boolean
  requestId: string | null
  settled: boolean
}
const snapshotFollowIntent = new Map<string, SnapshotFollowIntent>()

export function sessionKey(nodeId: string, provider: AdapterProvider, sessionId: string): string {
  return `${nodeId}::${provider}::${sessionId}`
}

export function createRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `req-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
}

export const useFleetStore = defineStore('fleet', () => {
  const auth = useAuthStore()
  const useLinkedCore = computed(() => auth.mode === 'local' && auth.workstation)
  const linkedCore = computed(() => useLinkedCore.value && auth.coreConnection?.connected ? auth.coreConnection : null)
  type FleetRoute = { origin: string; token: string }
  const coreSession = ref<(FleetRoute & { localToken: string; workspaceId: string; coreUrl: string }) | null>(null)
  const fleetRoute = computed<FleetRoute | null>((previous) => {
    if (!auth.token || (useLinkedCore.value && !auth.coreConnection)) return null
    const core = linkedCore.value
    const session = coreSession.value
    const target = core
      ? session?.localToken === auth.token && session.workspaceId === core.workspaceId && session.coreUrl === core.coreUrl
        ? session : null
      : { origin: getApiBaseUrl(), token: auth.token }
    if (!target) return null
    return previous?.token === target.token && previous.origin === target.origin
      ? previous : { origin: target.origin, token: target.token }
  })
  const localCacheScope = computed(() => {
    if (!auth.token || (useLinkedCore.value && !auth.coreConnection)) return ''
    const account = auth.replicaAccount
    if (!account) return ''
    return JSON.stringify([linkedCore.value?.coreUrl ?? getApiBaseUrl(), linkedCore.value?.workspaceId ?? '', account])
  })
  const coreSignInUrl = computed(() => linkedCore.value && !fleetRoute.value ? linkedCore.value.coreUrl : '')
  const usageOrigin = computed(() => fleetRoute.value?.origin ?? null)
  const subscriptionQuotas = ref<Record<string, SubscriptionQuota>>({})
  const subscriptionQuotaLoading = ref<Record<string, boolean>>({})
  const recordedUsage = useRecordedTokenUsage(computed(() => {
    if (!auth.token || !auth.user) return ''
    return JSON.stringify([
      auth.user.id, auth.user.created_at, linkedCore.value?.coreUrl ?? getApiBaseUrl(), linkedCore.value?.workspaceId ?? '',
    ])
  }))
  let fleetRequested = false

  async function signInToCoreFleet(username: string, password: string) {
    const core = linkedCore.value
    const localToken = auth.token
    if (!core || !localToken) return
    const origin = normalizeCoreOrigin(core.coreUrl)
    const { access_token: token } = await apiRequest<{ access_token: string }>('/api/v1/auth/login', {
      method: 'POST', body: JSON.stringify({ username, password }),
    }, null, origin)
    if (!token) throw new Error('Core 没有返回有效的登录凭证。')
    const workspace = await apiRequest<{ id: string }>('/api/v1/workspace', {}, token, origin)
    if (workspace.id !== core.workspaceId) throw new Error('该 Core 账号与本机已连接的工作区不匹配。')
    if (localToken !== auth.token || linkedCore.value?.coreUrl !== core.coreUrl || linkedCore.value.workspaceId !== core.workspaceId) return
    coreSession.value = { origin, token, localToken, workspaceId: core.workspaceId, coreUrl: core.coreUrl }
  }

  function requireFleetRoute(): FleetRoute {
    const route = fleetRoute.value
    if (!route) throw new Error(coreSignInUrl.value ? '请先登录 Core 对话工作区' : '对话连接尚未就绪')
    return route
  }

  function checkFleetRoute(route: FleetRoute) {
    if (fleetRoute.value !== route) throw new Error('对话连接已变更，请重试')
  }

  async function loadTokenUsage(start: string, end: string, signal: AbortSignal) {
    const route = fleetRoute.value
    if (!route) return null
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    const query = new URLSearchParams({ start, end, tz })
    const report = await apiRequest<FleetUsageDay[]>(`/api/v1/fleet/usage/daily?${query}`, { signal }, route.token, route.origin)
    return fleetRoute.value === route ? report : null
  }

  async function refreshSubscriptionQuota(nodeId: string, provider: SubscriptionQuotaProvider = 'codex') {
    const route = fleetRoute.value
    const key = `${provider}:${nodeId}`
    if (!route || subscriptionQuotaLoading.value[key]) return
    subscriptionQuotaLoading.value[key] = true
    try {
      const quota = await apiRequest<SubscriptionQuota>(
        `/api/v1/fleet/nodes/${encodeURIComponent(nodeId)}/subscription-quota?provider=${provider}`, { method: 'POST' }, route.token, route.origin,
      )
      if (fleetRoute.value === route) subscriptionQuotas.value[key] = quota
    } catch (error) {
      if (fleetRoute.value === route) {
        subscriptionQuotas.value[key] = {
          status: error instanceof ApiError && error.status === 404 ? 'unsupported' : 'unavailable',
          checkedAt: null,
          windows: [],
        }
      }
    } finally {
      if (fleetRoute.value === route) delete subscriptionQuotaLoading.value[key]
    }
  }

  // ---------------- 节点元信息（允许从 Core REST 刷新，不包含聊天正文） ----------------
  const nodes = ref<AgentNode[]>([])
  const nodesLoading = ref(false)
  const lastError = ref<string | null>(null)

  // ---------------- 实时连接状态 ----------------
  const wsState = ref<FleetConnectionState>('disconnected')
  const nativeTransport = desktopPlatform() !== 'web'
  const syncMode = readSyncMode()
  const epochCapabilities = syncMode === 'epoch' ? { capabilities: ['session.events.v1'] } : undefined
  const declareNativeSessionEvents = nativeTransport && epochCapabilities
    ? () => sendWsCommand({ type: 'node.ping', ...epochCapabilities }, false)
    : undefined
  const legacySnapshotSessions = new WeakMap<FleetRoute, Set<string>>()
  let nativeConnectionId: string | null = null
  let socket: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectAttempt = 0
  let intentionalClose = false
  let activeConnectRoute: FleetRoute | null = null

  // ---------------- 纯内存会话/消息/审批/产物状态 ----------------
  const selectedNodeId = ref<string>('')
  const selectedProvider = ref<AdapterProvider>('codex')
  const activeSessionKey = ref<string>('')
  const sessionsByKey = ref<Record<string, ChatSession>>({})
  const messagesBySession = ref<Record<string, ChatMessage[]>>({})
  const pendingApprovalsByCall = ref<Record<string, PermissionRequestCard>>({})
  const runningBySession = ref<Record<string, string>>({}) // sessionKey -> active runId
  const composerDrafts = ref<Record<string, { text: string; files: File[] }>>({})
  const outbox = ref<FleetOutboxItem[]>([])
  const pendingOutboxWrites = new Set<string>()
  const transmittingOutbox = shallowReactive(new Map<string, object>())
  const attemptedOutboxSteers = new WeakMap<FleetOutboxItem, object>()
  const deliveredOutbox = new Map<string, FleetOutboxItem>()
  const cachedHistoryKeys = new Set<string>()
  const cachedHistoryTimes = new Map<string, number>()
  const queuedHistoryWrites = new Set<string>()
  let historyTimer: ReturnType<typeof setTimeout> | undefined
  let historyWrites: Promise<void> = Promise.resolve()
  let storage: FleetLocalStore | undefined
  const localCacheRequested = ref(false)
  const SEND_SHORTCUT_KEY = 'studiolo:fleet-send-shortcut:v1'
  const sendShortcut = ref<'enter' | 'ctrl-enter'>(
    typeof window !== 'undefined' && window.localStorage?.getItem(SEND_SHORTCUT_KEY) === 'ctrl-enter'
      ? 'ctrl-enter'
      : 'enter',
  )
  const soundEnabled = ref<boolean>(loadSoundPref())

  try { window.sessionStorage.removeItem('studiolo:fleet-drafts:v1') } catch { /* Storage may be unavailable. */ }

  function toggleSendShortcut() {
    sendShortcut.value = sendShortcut.value === 'enter' ? 'ctrl-enter' : 'enter'
    if (typeof window !== 'undefined') {
      try { window.localStorage?.setItem(SEND_SHORTCUT_KEY, sendShortcut.value) } catch { /* ignore */ }
    }
  }

  function toggleSoundCues() {
    soundEnabled.value = !soundEnabled.value
    saveSoundPref(soundEnabled.value)
    if (soundEnabled.value) playCueSound('complete')
  }
  const runSettings = ref<Record<string, RunOptions>>({})
  const catalogs = ref<Record<string, { models: FleetModel[]; message?: string }>>({})
  const agentsByTarget = ref<Record<string, AgentModeOption[]>>({})
  const mcpByTarget = ref<Record<string, McpServerInfo[]>>({})
  const rulesByTarget = ref<Record<string, WorkspaceRule[]>>({})
  const skillsByTarget = ref<Record<string, WorkspaceSkill[]>>({})
  const filePreviewBySession = ref<Record<string, FilePreviewState>>({})
  const fileTextCacheBySession = ref<Record<string, Record<string, string[]>>>({})
  const silentFileReadRequests = new Set<string>()
  const pendingDownloadRequests = new Map<string, { fileName: string; onSaved?: () => void }>()
  const pendingFormsById = ref<Record<string, MessageFormRequest>>({})
  const treeCacheByTarget = ref<Record<string, WorkspaceTreeEntry[]>>({})
  const trustPatternsByNode = ref<Record<string, string[]>>({})
  const terminalBySession = ref<Record<string, TerminalSessionState>>({})
  const terminalPreviews = ref<Record<string, Record<number, { requestId: string; pending?: boolean; url?: string; error?: string }>>>({})
  const bookmarkedIdsBySession = ref<Record<string, string[]>>({})
  const diffAnnotationsBySession = ref<Record<string, DiffAnnotation[]>>({})
  const unreadCountBySession = ref<Record<string, number>>({})
  let sessionViewVisible = true
  const firstUnreadMsgIdBySession = ref<Record<string, string>>({})
  const interruptedBySession = ref<Record<string, boolean>>({})
  const stopStatusBySession = ref<Record<string, { requestId?: string; state: 'requested' | 'accepted' | 'reusable' | 'unknown' | 'error'; message?: string }>>({})
  const historyLimitBySession = ref<Record<string, number>>({})
  const historyCursorBySession = ref<Record<string, string | null>>({})
  const pendingHistoryPages = ref<Record<string, string>>({})
  const contextUsageBySession = ref<Record<string, ChatContextUsage>>({})
  const contextReads = ref<Record<string, string>>({})
  const contextWaitingForModel = ref<Record<string, { runId?: string }>>({})
  const contextCompactions = ref<Record<string, string>>({})
  const historyStateBySession = ref<Record<string, { state: 'empty' | 'ready' | 'body-only' | 'error'; message?: string }>>({})
  const lastSeqBySession = ref<Record<string, number>>({})
  const streamIdBySession = new Map<string, string>()
  const auditRing: AuditEntry[] = []
  const pendingStreamResync = new Map<string, string>()
  const streamStateBySession = shallowReactive(new Map<string, StreamState>())
  const historyTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const retiredStreamRequests = new Set<string>()
  const forcedHistoryRequests = new Set<string>()
  const followIntentBySession = new Map<string, boolean>()
  const snapshotRestoreVersions = shallowReactive(new Map<string, number>())
  let snapshotRestoreTick = 0
  const forkSeedBySession = ref<Record<string, string>>({})
  const sideChatSessionKeyByParent = ref<Record<string, string>>({})
  const projectPermissionsByNode = ref<Record<string, ProjectPermission[]>>({})
  const projectPermissionWrites = new Map<string, (error?: Error) => void>()
  const pendingSessionWrites = new Map<string, {
    key: string
    field: 'currentModel' | 'currentEffort'
    finish: (result: string | null | Error) => void
  }>()
  const pendingSessionEffort = shallowReactive<Record<string, string>>({})
  const android = isAndroidLocal()
  const notificationsEnabled = ref(
    nativeTransport && !android
      ? localStorage.getItem(DESKTOP_NOTIFICATION_PREF) !== 'off'
      : !android && typeof Notification !== 'undefined' && Notification.permission === 'granted',
  )
  if (nativeTransport && !android) {
    watch(notificationsEnabled, enabled => {
      void invoke('fleet_notifications', { enabled }).catch(() => {})
    }, { immediate: true })
  }
  const androidNotificationsReady = android
    ? androidInvoke<boolean>('android_notifications_enabled').then(
      enabled => { notificationsEnabled.value = enabled },
      () => {},
    )
    : null
  let changingAndroidNotifications = false
  const unreadNotifyTitle = ref('')
  const tokenUsageStateBySession = ref<Record<string, SessionTokenState>>({})
  const todosBySession = ref<Record<string, TodoItem[]>>({})
  const diffBySession = ref<Record<string, SessionDiffState>>({})
  const checkpointsBySession = ref<Record<string, CheckpointInfo[]>>({})
  const filesCacheByTarget = ref<Record<string, string[]>>({})
  const queuedPromptsBySession = ref<Record<string, QueuedPromptItem[]>>({})
  const pendingSteers = new Map<string, {
    sessionKey: string
    result: Promise<boolean>
    finish: (accepted: boolean) => void
  }>()
  const imagePreviewByArtifactId = ref<Record<string, string>>({})
  const pendingRunPrompts = new Map<string, { text: string; model?: string; startedAt?: number }>()
  const pendingMcpRequests = new Map<string, string>()
  const mcpErrorsByTarget = ref<Record<string, string>>({})
  const autoPulledProviders = new Map<string, Set<AdapterProvider>>()
  const pendingSessionLists = new Map<string, string>()
  const sessionListStates = ref<Record<string, { loading?: boolean; error?: string }>>({})
  const steerSessionKeys = new Set<string>()
  const pendingOpenQueue: Array<{
    nodeId: string
    provider: AdapterProvider
    requestId: string
    onOpened?: (key: string) => void
    options?: RunOptions
    initialPrompt?: string
    initialAttachments?: ArtifactRef[]
    initialHandoff?: { summary: string; artifact?: ArtifactRef; sourceSessionKey?: string }
  }> = []

  // ---------------- Computed Views ----------------
  const selectedNode = computed(
    () => nodes.value.find(n => n.id === selectedNodeId.value) ?? nodes.value[0] ?? null,
  )

  const availableProviders = computed<AdapterProvider[]>(() => {
    const node = selectedNode.value
    if (!node || !node.adapters.length) {
      return ['codex', 'opencode', 'hermes', 'antigravity', 'dsh', 'openclaw', 'mock']
    }
    return node.adapters.map(a => a.provider)
  })

  const sessionsForCurrentNode = computed<ChatSession[]>(() => {
    const nid = selectedNode.value?.id
    if (!nid) return []
    return Object.values(sessionsByKey.value).filter(s => s.nodeId === nid)
  })

  const allSessions = computed<ChatSession[]>(() => Object.values(sessionsByKey.value))

  const currentSession = computed<ChatSession | null>(
    () => (activeSessionKey.value ? sessionsByKey.value[activeSessionKey.value] ?? null : null),
  )

  const currentMessages = computed<ChatMessage[]>(
    () => (activeSessionKey.value ? messagesBySession.value[activeSessionKey.value] ?? [] : []),
  )

  const pendingApprovalsList = computed<PermissionRequestCard[]>(() =>
    Object.values(pendingApprovalsByCall.value).filter(c => c.decision === 'pending'),
  )
  const notificationSessionKey = ref('')

  function openNotifiedSession(key?: string) {
    notificationSessionKey.value = key ?? ''
    if (key && sessionsByKey.value[key]) activateSession(key)
    window.dispatchEvent(new Event('studiolo:open-chat'))
  }

  if (android) {
    const channel = new Channel<{ action: 'open' | 'allow_once' | 'deny'; callId?: string; sessionKey?: string }>()
    channel.onmessage = ({ action, callId, sessionKey: target }) => {
      const card = callId ? pendingApprovalsByCall.value[callId] : undefined
      if (card?.decision === 'pending' && action !== 'open' && wsState.value === 'online') respondPermission(card.callId, action)
      openNotifiedSession(card ? sessionKey(card.nodeId, card.provider, card.sessionId) : target)
    }
    void androidInvoke('android_listen_fleet_approval', { channel }).catch(() => {})
    watch(() => [notificationsEnabled.value, pendingApprovalsList.value.map(card => card.callId).sort().join('|')], () => {
      const pending = pendingApprovalsList.value
      const count = notificationsEnabled.value ? pending.length : 0
      if (!count || document.hidden) {
        void androidInvoke('android_show_fleet_approval', { count, callId: count === 1 ? pending[0].callId : null }).catch(() => {})
      }
    })
  }

  const nodesWithApprovalPending = computed(() => {
    const set = new Set<string>()
    for (const card of pendingApprovalsList.value) {
      set.add(card.nodeId)
    }
    return set
  })

  function isSessionStreaming(sKey: string) {
    return (messagesBySession.value[sKey] ?? []).some(message => message.streaming)
  }
  const currentIsStreaming = computed<boolean>(() => isSessionStreaming(activeSessionKey.value))

  const tokenUsageBySession = computed<Record<string, SessionTokenUsage>>(() => {
    const out: Record<string, SessionTokenUsage> = {}
    for (const [k, state] of Object.entries(tokenUsageStateBySession.value)) {
      const summary = toSessionTokenSummary(state)
      if (summary) out[k] = summary
    }
    return out
  })

  const currentTodos = computed<TodoItem[]>(() =>
    activeSessionKey.value ? todosBySession.value[activeSessionKey.value] ?? [] : [],
  )

  const currentDiff = computed<SessionDiffState | null>(() =>
    activeSessionKey.value ? diffBySession.value[activeSessionKey.value] ?? null : null,
  )

  const currentCheckpoints = computed<CheckpointInfo[]>(() =>
    activeSessionKey.value ? checkpointsBySession.value[activeSessionKey.value] ?? [] : [],
  )

  const currentQueue = computed<QueuedPromptItem[]>(() =>
    activeSessionKey.value ? queuedPromptsBySession.value[activeSessionKey.value] ?? [] : [],
  )

  // ---------------- 内存清理（登出 / 切换工作区时必须彻底销毁正文与密钥） ----------------
  function clearSessionMemory() {
    disconnectSocket()
    auditRing.length = 0
    followIntentBySession.clear()
    sessionsByKey.value = {}
    messagesBySession.value = {}
    pendingApprovalsByCall.value = {}
    runningBySession.value = {}
    activeSessionKey.value = ''
    steerSessionKeys.clear()
    composerDrafts.value = {}
    outbox.value = []
    pendingOutboxWrites.clear()
    transmittingOutbox.clear()
    deliveredOutbox.clear()
    cachedHistoryKeys.clear()
    cachedHistoryTimes.clear()
    queuedHistoryWrites.clear()
    clearTimeout(historyTimer)
    historyTimer = undefined
    storage = undefined
    runSettings.value = {}
    catalogs.value = {}
    agentsByTarget.value = {}
    mcpByTarget.value = {}
    rulesByTarget.value = {}
    skillsByTarget.value = {}
    filePreviewBySession.value = {}
    fileTextCacheBySession.value = {}
    silentFileReadRequests.clear()
    pendingDownloadRequests.clear()
    pendingFormsById.value = {}
    treeCacheByTarget.value = {}
    trustPatternsByNode.value = {}
    terminalBySession.value = {}
    terminalPreviews.value = {}
    bookmarkedIdsBySession.value = {}
    diffAnnotationsBySession.value = {}
    unreadCountBySession.value = {}
    firstUnreadMsgIdBySession.value = {}
    interruptedBySession.value = {}
    stopStatusBySession.value = {}
    historyLimitBySession.value = {}
    historyCursorBySession.value = {}
    pendingHistoryPages.value = {}
    contextUsageBySession.value = {}
    contextReads.value = {}
    contextWaitingForModel.value = {}
    contextCompactions.value = {}
    historyStateBySession.value = {}
    lastSeqBySession.value = {}
    streamIdBySession.clear()
    clearTransportRequests()
    streamStateBySession.clear()
    retiredStreamRequests.clear()
    forcedHistoryRequests.clear()
    forkSeedBySession.value = {}
    sideChatSessionKeyByParent.value = {}
    for (const finish of projectPermissionWrites.values()) finish(new Error('节点连接已变更'))
    for (const { finish } of pendingSessionWrites.values()) finish(new Error('节点连接已变更'))
    projectPermissionsByNode.value = {}
    unreadNotifyTitle.value = ''
    tokenUsageStateBySession.value = {}
    todosBySession.value = {}
    diffBySession.value = {}
    checkpointsBySession.value = {}
    filesCacheByTarget.value = {}
    queuedPromptsBySession.value = {}
    for (const url of Object.values(imagePreviewByArtifactId.value)) {
      if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
        try { URL.revokeObjectURL(url) } catch { /* ignore */ }
      }
    }
    imagePreviewByArtifactId.value = {}
    pendingRunPrompts.clear()
    pendingMcpRequests.clear()
    mcpErrorsByTarget.value = {}
    autoPulledProviders.clear()
    pendingSessionLists.clear()
    sessionListStates.value = {}
    pendingOpenQueue.length = 0
  }

  function disconnectSocket() {
    for (const { finish } of pendingSteers.values()) finish(false)
    intentionalClose = true
    activeConnectRoute = null
    if (nativeConnectionId) {
      const id = nativeConnectionId
      nativeConnectionId = null
      void invoke('fleet_disconnect', { id }).catch(() => {})
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (socket) {
      try {
        socket.close(1000, 'client_disconnect')
      } catch {
        // 忽略已关闭连接错误
      }
      socket = null
    }
    snapshotFollowIntent.clear()
    clearTransportRequests()
    snapshotRestoreVersions.clear()
    wsState.value = 'disconnected'
  }

  onScopeDispose(disconnectSocket)

  // 当用户登出或 JWT 变更时立即清空所有内存会话与 E2EE 密钥
  watch(
    () => auth.token,
    (nextToken, prevToken) => {
      if (!nextToken || nextToken !== prevToken) {
        coreSession.value = null
        clearSessionMemory()
        nodes.value = []
      }
    },
  )
  watch(fleetRoute, (route, previous) => {
    if (previous) clearSessionMemory()
    nodes.value = []
    selectedNodeId.value = ''
    nodesLoading.value = false
    subscriptionQuotas.value = {}
    subscriptionQuotaLoading.value = {}
    lastError.value = null
    if (route && fleetRequested) {
      void loadNodes()
      connectSocket()
    }
  })

  watch([localCacheScope, fleetRoute, localCacheRequested], async ([scope, , requested]) => {
    if (storage && storage.scope !== scope) clearSessionMemory()
    if (!requested || !scope || !FleetLocalStore.available()) return
    const local = new FleetLocalStore(scope)
    storage = local
    const [cached, unsent] = await Promise.allSettled([local.history(), local.outbox()])
    if (storage !== local || localCacheScope.value !== scope) return
    if (cached.status === 'fulfilled') {
      for (const { id, value } of cached.value) {
        cachedHistoryTimes.set(id, value.savedAt)
        if (!sessionsByKey.value[id]) sessionsByKey.value[id] = value.session
        const existing = messagesBySession.value[id]
        if (!existing?.length) {
          cachedHistoryKeys.add(id)
          messagesBySession.value[id] = value.messages
        } else if (value.messages.some(row => row.systemEvents?.length || row.interrupted)) {
          messagesBySession.value = {
            ...messagesBySession.value,
            [id]: mergeHistoryBoundaries(value.messages, existing).slice(-MAX_MESSAGES_PER_SESSION),
          }
        }
      }
    }
    if (unsent.status === 'fulfilled') {
      const newIds = new Set(outbox.value.map(item => item.id))
      outbox.value = [...unsent.value.filter(item => !newIds.has(item.id)), ...outbox.value]
      for (const item of unsent.value) {
        if (item.session && !sessionsByKey.value[item.sessionKey]) sessionsByKey.value[item.sessionKey] = item.session
      }
      void flushOutbox()
    }
  }, { immediate: true })

  const chatNodes = computed<AgentNode[]>(() => {
    const byId = new Map(nodes.value.map(node => [node.id, node]))
    const unavailableRoots = new Map<string, Set<string>>()
    for (const session of Object.values(sessionsByKey.value)) {
      if (byId.has(session.nodeId)) continue
      const roots = unavailableRoots.get(session.nodeId) ?? new Set<string>()
      if (session.cwd) roots.add(session.cwd)
      unavailableRoots.set(session.nodeId, roots)
    }
    for (const [id, roots] of unavailableRoots) {
      byId.set(id, {
        id, workspaceId: '', name: id, platform: 'unknown', hostname: null, status: 'offline',
        tokenLast4: null, tokenCreatedAt: null, revokedAt: null, allowedRoots: [...roots],
        adapters: [], transferEndpoints: [], lastSeenAt: null, createdAt: '', updatedAt: '',
      })
    }
    return [...byId.values()]
  })

  watch(messagesBySession, (rows, previous) => {
    if (!storage) return
    for (const [key, messages] of Object.entries(rows)) {
      if (messages !== previous[key] && messages.length && !cachedHistoryKeys.has(key)) queuedHistoryWrites.add(key)
    }
    if (queuedHistoryWrites.size && !historyTimer) historyTimer = setTimeout(persistHistory, 500)
  })

  function persistHistory() {
    historyTimer = undefined
    const local = storage
    if (!local) return
    const keys = [...queuedHistoryWrites]
    queuedHistoryWrites.clear()
    historyWrites = historyWrites.then(async () => {
      for (const key of keys) {
        if (storage !== local) return
        const session = sessionsByKey.value[key]
        const rows = messagesBySession.value[key]
        if (!session || !rows?.length) continue
        await local.saveHistory(key, session, rows)
        cachedHistoryTimes.set(key, Date.now())
      }
      if (storage !== local) return
      const oldKeys = [...cachedHistoryTimes].sort((a, b) => b[1] - a[1]).slice(24)
      for (const [key] of oldKeys) {
        await local.remove('history', key)
        cachedHistoryTimes.delete(key)
      }
    }).catch(() => { /* The provider remains the source of online history. */ })
  }

  // ---------------- REST Node Lifecycle ----------------
  async function loadNodes() {
    fleetRequested = true
    localCacheRequested.value = true
    const route = fleetRoute.value
    if (!route) return
    nodesLoading.value = true
    lastError.value = null
    try {
      const fetched = await listFleetNodes(route.token, route.origin)
      if (fleetRoute.value !== route) return
      nodes.value = fetched
      if (!selectedNodeId.value || !fetched.some(n => n.id === selectedNodeId.value)) {
        const firstOnline = fetched.find(n => n.status === 'online') ?? fetched[0]
        if (firstOnline) {
          selectedNodeId.value = firstOnline.id
          syncProviderForNode(firstOnline)
        }
      }
      if (wsState.value === 'online') {
        fetched.forEach(initializeOnlineNode)
        void flushOutbox()
      }
    } catch (err) {
      if (fleetRoute.value !== route) return
      if (linkedCore.value && err instanceof ApiError && err.status === 401) coreSession.value = null
      lastError.value = err instanceof Error ? err.message : '加载节点列表失败'
    } finally {
      if (fleetRoute.value === route) nodesLoading.value = false
    }
  }

  function syncProviderForNode(node: AgentNode) {
    if (!node.adapters.length) return
    const currentOk = node.adapters.some(
      a => a.provider === selectedProvider.value && a.status === 'ready',
    )
    if (!currentOk) {
      const ready = node.adapters.find(a => a.status === 'ready') ?? node.adapters[0]
      if (ready) selectedProvider.value = ready.provider
    }
  }

  async function registerNode(payload: {
    name: string
    platform: NodePlatform
    hostname?: string | null
  }): Promise<NodeTokenOut> {
    const route = requireFleetRoute()
    const res = await createFleetNode(route.token, payload, route.origin)
    checkFleetRoute(route)
    nodes.value = [res.node, ...nodes.value.filter(n => n.id !== res.node.id)]
    if (!selectedNodeId.value) selectedNodeId.value = res.node.id
    return res
  }

  async function rotateNode(nodeId: string): Promise<NodeTokenOut> {
    const route = requireFleetRoute()
    const res = await rotateFleetNodeToken(route.token, nodeId, route.origin)
    checkFleetRoute(route)
    nodes.value = nodes.value.map(n => (n.id === nodeId ? res.node : n))
    return res
  }

  async function revokeNode(nodeId: string): Promise<AgentNode> {
    const route = requireFleetRoute()
    const updated = await revokeFleetNode(route.token, nodeId, route.origin)
    checkFleetRoute(route)
    nodes.value = nodes.value.map(n => (n.id === nodeId ? updated : n))
    return updated
  }

  async function removeNode(nodeId: string): Promise<void> {
    const route = requireFleetRoute()
    await deleteFleetNode(route.token, nodeId, route.origin)
    checkFleetRoute(route)
    nodes.value = nodes.value.filter(n => n.id !== nodeId)
    if (selectedNodeId.value === nodeId) {
      selectedNodeId.value = nodes.value[0]?.id ?? ''
    }
  }

  // ---------------- WebSocket 连接与首帧认证 ----------------
  function reportFollowIntent(sKey: string, follow: boolean) {
    if (sKey) followIntentBySession.set(sKey, follow)
  }

  function cancelSnapshotFollow(sKey: string) {
    const intent = snapshotFollowIntent.get(sKey)
    if (intent) {
      intent.cancelled = true
      intent.settled = true
    }
    snapshotRestoreVersions.delete(sKey)
  }

  function forgetFollowIntent(sKey: string) {
    cancelSnapshotFollow(sKey)
    snapshotFollowIntent.delete(sKey)
    followIntentBySession.delete(sKey)
  }

  function snapshotRestorePending(sKey: string) {
    const intent = snapshotFollowIntent.get(sKey)
    return Boolean(intent && !intent.settled)
  }

  function snapshotRestoreVersion(sKey: string) {
    return snapshotRestoreVersions.get(sKey) ?? 0
  }

  function captureSnapshotFollow(nodeId?: string) {
    for (const key of new Set([activeSessionKey.value, ...followIntentBySession.keys()])) {
      const session = sessionsByKey.value[key]
      if (!session || (nodeId && session.nodeId !== nodeId)) continue
      snapshotRestoreVersions.delete(key)
      snapshotFollowIntent.set(key, {
        followBefore: followIntentBySession.get(key) ?? true,
        cancelled: false, requestId: null, settled: false,
      })
    }
  }

  function streamState(sKey: string): StreamState {
    let state = streamStateBySession.get(sKey)
    if (!state) {
      state = { phase: 'live', buffer: [], retries: 0, cursors: new Map() }
      streamStateBySession.set(sKey, state)
    }
    return state
  }

  function clearSubscribe(sKey: string) {
    const state = streamStateBySession.get(sKey)
    clearTimeout(state?.timer)
    if (state) state.timer = undefined
    retireStreamRequest(pendingStreamResync.get(sKey))
    pendingStreamResync.delete(sKey)
  }

  function retireStreamRequest(requestId: string | undefined) {
    if (!requestId) return
    retiredStreamRequests.add(requestId)
    if (retiredStreamRequests.size > 1000) retiredStreamRequests.delete(retiredStreamRequests.values().next().value!)
  }

  function clearHistory(sKey: string) {
    const requestId = pendingHistoryPages.value[sKey]
    retireStreamRequest(requestId)
    if (requestId) forcedHistoryRequests.delete(requestId)
    delete pendingHistoryPages.value[sKey]
    clearTimeout(historyTimers.get(sKey))
    historyTimers.delete(sKey)
  }

  function reconcileRunMessages(sKey: string, runId = runningBySession.value[sKey]) {
    messagesBySession.value = { ...messagesBySession.value, [sKey]: (messagesBySession.value[sKey] ?? [])
      .map(message => {
        const streaming = Boolean(runId && message.role === 'assistant' && message.runId === runId)
        return Boolean(message.streaming) === streaming ? message
          : { ...message, streaming, ...(!streaming ? { liveProgress: undefined } : {}) }
      }) }
  }

  function reconcileRuntime(sKey: string, frame: FleetWsEvent) {
    if (frame.active && frame.runId) runningBySession.value = { ...runningBySession.value, [sKey]: frame.runId }
    else delete runningBySession.value[sKey]
    reconcileRunMessages(sKey)
  }

  function failRecovery(sKey: string, message: string) {
    clearSubscribe(sKey)
    clearHistory(sKey)
    const state = streamStateBySession.get(sKey)
    if (state) {
      clearTimeout(state.snapshotTimer)
      state.snapshotTimer = undefined
      state.phase = state.buffer.length ? 'gap' : 'live'
      state.snapshot = undefined
      state.retries = 0
    }
    snapshotFollowIntent.delete(sKey)
    delete runningBySession.value[sKey]
    reconcileRunMessages(sKey)
    historyStateBySession.value[sKey] = { state: 'error', message }
    lastError.value = message
  }

  function clearTransportRequests() {
    for (const key of new Set([...streamStateBySession.keys(), ...historyTimers.keys(), ...Object.keys(pendingHistoryPages.value), ...Object.keys(runningBySession.value)])) {
      clearSubscribe(key)
      clearHistory(key)
      const state = streamStateBySession.get(key)
      if (state) {
        clearTimeout(state.snapshotTimer)
        state.snapshotTimer = undefined
        state.phase = 'gap'
        state.snapshot = undefined
        state.retries = 0
      }
      delete runningBySession.value[key]
      reconcileRunMessages(key)
    }
  }

  function trackHistory(sKey: string, requestId: string) {
    pendingHistoryPages.value[sKey] = requestId
    historyTimers.set(sKey, setTimeout(() => {
      if (pendingHistoryPages.value[sKey] !== requestId) return
      if (streamStateBySession.get(sKey)?.snapshot?.requestId === requestId) failRecovery(sKey, '读取会话历史超时，请重试')
      else {
        clearHistory(sKey)
        delete runningBySession.value[sKey]
        reconcileRunMessages(sKey)
        historyStateBySession.value[sKey] = { state: 'error', message: '读取会话历史超时，请重试' }
        lastError.value = '读取会话历史超时，请重试'
      }
    }, HISTORY_TIMEOUT_MS))
  }

  function commitCursor(sKey: string, streamId: string | undefined, sequence: number) {
    if (streamId) {
      const state = streamState(sKey)
      state.cursors.set(streamId, Math.max(state.cursors.get(streamId) ?? 0, sequence))
    }
    lastSeqBySession.value = { ...lastSeqBySession.value, [sKey]: Math.max(lastSeqBySession.value[sKey] ?? 0, sequence) }
  }

  function requestSnapshotHistory(sKey: string, anchor?: { streamId?: string; lastSeq: number }) {
    const state = streamState(sKey)
    if (state.snapshot?.requestId && pendingHistoryPages.value[sKey] === state.snapshot.requestId) return
    clearSubscribe(sKey)
    // A snapshot must preempt pagination; late responses are rejected by requestId.
    clearHistory(sKey)
    const intent = snapshotFollowIntent.get(sKey)
    if (intent && (!intent.followBefore || intent.settled)) {
      intent.settled = true
      snapshotFollowIntent.delete(sKey)
    }
    const streamId = anchor?.streamId ?? state.buffer.at(-1)?.streamId ?? streamIdBySession.get(sKey)
    if (!anchor) {
      // No replay could confirm this runtime; a successful history read alone cannot confirm it either.
      delete runningBySession.value[sKey]
      reconcileRunMessages(sKey)
    }
    state.phase = 'resyncing'
    state.snapshot = anchor ?? { streamId, lastSeq: Math.max(state.cursors.get(streamId ?? '') ?? 0,
      ...state.buffer.filter(frame => frame.streamId === streamId).map(frame => frame.sequence ?? 0)) }
    // Preemption must not extend recovery forever under sustained buffer overflow or cursor expiry.
    state.snapshotTimer ??= setTimeout(() => failRecovery(sKey, '读取会话快照超时，请重试'), HISTORY_TIMEOUT_MS)
    const requestId = loadSessionHistory(sKey, true)
    if (!requestId) {
      failRecovery(sKey, '无法请求会话快照，请重试')
      return
    }
    state.snapshot.requestId = requestId
    if (intent && !intent.settled) intent.requestId = requestId
  }

  function finishSnapshotHistory(sKey: string, requestId: string | undefined, committed: boolean) {
    const state = streamStateBySession.get(sKey)
    if (!requestId || state?.snapshot?.requestId !== requestId) return
    if (!committed) {
      failRecovery(sKey, '无法应用会话快照，请重试')
      return
    }
    const { streamId, lastSeq } = state.snapshot
    reconcileRunMessages(sKey)
    // The committed full history supersedes buffered events from older stream generations.
    state.buffer = state.buffer.filter(frame => !streamId || frame.streamId === streamId)
    if (streamId) streamIdBySession.set(sKey, streamId)
    commitCursor(sKey, streamId, lastSeq)
    state.snapshot = undefined
    clearTimeout(state.snapshotTimer)
    state.snapshotTimer = undefined
    state.retries = 0
    const intent = snapshotFollowIntent.get(sKey)
    if (intent && requestId && requestId === intent.requestId) {
      const restore = committed && !intent.settled && !intent.cancelled
      intent.settled = true
      snapshotFollowIntent.delete(sKey)
      if (restore) snapshotRestoreVersions.set(sKey, ++snapshotRestoreTick)
    }
    state.phase = 'live'
    flushStreamBuffer(sKey)
  }

  function connectionLost(code?: number) {
    if (wsState.value !== 'reconnecting') {
      snapshotFollowIntent.clear()
      captureSnapshotFollow()
    }
    for (const { finish } of pendingSteers.values()) finish(false)
    autoPulledProviders.clear()
    clearTransportRequests()
    forcedHistoryRequests.clear()
    contextReads.value = {}
    contextCompactions.value = {}
    transmittingOutbox.clear()
    for (const finish of projectPermissionWrites.values()) finish(new Error('节点连接已断开'))
    for (const { finish } of pendingSessionWrites.values()) finish(new Error('节点连接已断开'))
    for (const target of pendingSessionLists.values()) sessionListStates.value[target] = {}
    pendingSessionLists.clear()
    if (code === 4401) {
      snapshotFollowIntent.clear()
      wsState.value = 'disconnected'
      if (linkedCore.value) coreSession.value = null
      lastError.value = 'Fleet 会话认证失败或登录已过期'
    } else {
      wsState.value = 'reconnecting'
    }
  }

  function connectNative(route: FleetRoute) {
    if (nativeConnectionId && activeConnectRoute === route) return
    if (nativeConnectionId) disconnectSocket()
    activeConnectRoute = route
    wsState.value = 'connecting'
    const id = createRequestId()
    nativeConnectionId = id
    const events = new Channel<NativeFleetEvent>(message => {
      if (nativeConnectionId !== id || fleetRoute.value !== route) return
      if (message.event === 'frame') {
        try {
          handleWsEvent(message.frame)
        } catch (error) {
          reportFrameFailure(message.frame, error)
        }
      } else if (message.event === 'unauthorized') {
        nativeConnectionId = null
        connectionLost(4401)
      } else {
        connectionLost()
      }
    })
    void invoke('fleet_connect', { id, url: buildFleetWsUrl(route.origin), token: route.token, events }).catch(error => {
      if (nativeConnectionId !== id || fleetRoute.value !== route) return
      nativeConnectionId = null
      wsState.value = 'disconnected'
      lastError.value = typeof error === 'string' ? error : 'Fleet 连接无法启动'
    })
  }

  function connectSocket() {
    fleetRequested = true
    localCacheRequested.value = true
    const route = fleetRoute.value
    if (!route) return
    if (nativeTransport) {
      connectNative(route)
      return
    }
    const { token, origin } = route
    if (
      socket &&
      activeConnectRoute === route &&
      (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
    ) {
      return
    }

    if (socket) disconnectSocket()
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    intentionalClose = false
    activeConnectRoute = route
    wsState.value = reconnectAttempt > 0 ? 'reconnecting' : 'connecting'

    const wsUrl = buildFleetWsUrl(origin)
    const ws = new WebSocket(wsUrl)
    socket = ws

    ws.onopen = () => {
      if (socket !== ws || fleetRoute.value !== route) return
      // 首帧发送认证 JWT（避免泄漏到 URL），待服务端回传 FleetSnapshot 验证握手成功后再转 online
      ws.send(JSON.stringify({ type: 'auth', token, ...epochCapabilities }))
    }

    ws.onmessage = event => {
      if (socket !== ws || fleetRoute.value !== route) return
      let frame: FleetWsEvent | undefined
      try {
        frame = JSON.parse(String(event.data)) as FleetWsEvent
        handleWsEvent(frame)
      } catch (error) {
        reportFrameFailure(frame, error)
      }
    }

    ws.onclose = ev => {
      if (socket !== ws || fleetRoute.value !== route) return
      socket = null
      if (intentionalClose) {
        wsState.value = 'disconnected'
        return
      }
      connectionLost(ev.code)
      if (ev.code === 4401) return
      const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)]
      reconnectAttempt += 1
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        if (!intentionalClose && fleetRoute.value === route) connectSocket()
      }, delay)
    }

    ws.onerror = () => {
      if (wsState.value === 'connecting') {
        wsState.value = 'reconnecting'
      }
    }
  }

  function sendWsCommand(frame: Record<string, unknown>, reportError = true): boolean {
    const route = fleetRoute.value
    if (!route) return false
    if (nativeTransport && nativeConnectionId && activeConnectRoute === route && wsState.value === 'online') {
      const id = nativeConnectionId
      void invoke('fleet_send', { id, frame }).catch(() => {
        if (nativeConnectionId !== id || fleetRoute.value !== route || wsState.value !== 'online') return
        if (typeof frame.requestId === 'string') {
          pendingSteers.get(frame.requestId)?.finish(false)
          pendingSessionWrites.get(frame.requestId)?.finish(new Error('Fleet 暂时无法发送请求'))
          projectPermissionWrites.get(frame.requestId)?.(new Error('Fleet 暂时无法发送请求'))
          transmittingOutbox.delete(frame.requestId)
        }
        if (reportError) lastError.value = 'Fleet 暂时无法发送请求'
      })
      return true
    }
    if (!socket || activeConnectRoute !== route || socket.readyState !== WebSocket.OPEN) {
      connectSocket()
      if (reportError) lastError.value = '正在建立到 Core Relay 的连接，请稍候重试'
      return false
    }
    try {
      socket.send(JSON.stringify(frame))
      return true
    } catch {
      if (reportError) lastError.value = 'Fleet 暂时无法发送请求'
      return false
    }
  }

  function appendMessage(sKey: string, msg: ChatMessage) {
    const prev = messagesBySession.value[sKey] ?? []
    const next = prev.length >= MAX_MESSAGES_PER_SESSION
      ? [...prev.slice(prev.length - MAX_MESSAGES_PER_SESSION + 1), msg]
      : [...prev, msg]
    messagesBySession.value = { ...messagesBySession.value, [sKey]: next }
  }

  function updatePromptDelivery(sKey: string, requestId: string, delivery: 'sent' | 'failed') {
    const rows = messagesBySession.value[sKey] ?? []
    const index = rows.findIndex(row => row.role === 'user' && row.requestId === requestId && row.delivery === 'sending')
    if (index !== -1) {
      const next = [...rows]
      next[index] = { ...next[index], delivery }
      messagesBySession.value = { ...messagesBySession.value, [sKey]: next }
    }
  }

  function appendSystemEvent(sKey: string, nodeId: string, provider: AdapterProvider, id: string, event: ChatSystemEvent) {
    if (messagesBySession.value[sKey]?.some(row => row.id === id)) return
    cachedHistoryKeys.delete(sKey)
    appendMessage(sKey, {
      id, role: 'system', nodeId, provider, text: '',
      systemEvents: [event], createdAt: event.at,
    })
  }

  function ensureStreamingAssistantMessage(
    sKey: string,
    nodeId: string,
    provider: AdapterProvider,
    runId?: string,
    requestId?: string,
  ): ChatMessage {
    const list = [...(messagesBySession.value[sKey] ?? [])]
    let idx = list.findIndex(
      m => m.role === 'assistant' && (runId ? m.runId === runId : m.streaming),
    )
    if (idx === -1 && requestId) {
      idx = list.findIndex(m => m.role === 'assistant' && m.requestId === requestId)
    }
    if (idx === -1) {
      const created: ChatMessage = {
        id: `msg-${createRequestId()}`,
        role: 'assistant',
        runId,
        requestId,
        nodeId,
        provider,
        text: '',
        thought: '',
        streaming: true,
        toolCalls: [],
        approvals: [],
        artifacts: [],
        createdAt: Date.now(),
      }
      list.push(created)
      messagesBySession.value = { ...messagesBySession.value, [sKey]: list.slice(-MAX_MESSAGES_PER_SESSION) }
      return created
    }
    return list[idx]
  }

  function updateAssistantMessage(
    sKey: string,
    nodeId: string,
    provider: AdapterProvider,
    runId: string | undefined,
    requestId: string | undefined,
    mutator: (msg: ChatMessage) => ChatMessage,
  ) {
    ensureStreamingAssistantMessage(sKey, nodeId, provider, runId, requestId)
    const list = [...(messagesBySession.value[sKey] ?? [])]
    let idx = list.findIndex(
      m => m.role === 'assistant' && (runId ? m.runId === runId : m.streaming),
    )
    if (idx === -1 && requestId) {
      idx = list.findIndex(m => m.role === 'assistant' && m.requestId === requestId)
    }
    if (idx === -1) {
      idx = list.length - 1
    }
    if (idx >= 0) {
      list[idx] = mutator(list[idx])
      messagesBySession.value = { ...messagesBySession.value, [sKey]: list }
    }
  }

  function autoPullSessionsForNode(node: AgentNode) {
    if (node.status !== 'online') return
    const pulled = autoPulledProviders.get(node.id) ?? new Set<AdapterProvider>()
    for (const adapter of node.adapters) {
      if (adapter.status !== 'ready' || !(adapter.supports?.history ?? adapter.capabilities.includes('history')) || pulled.has(adapter.provider)) continue
      if (requestSessionsList(node.id, adapter.provider)) pulled.add(adapter.provider)
    }
    autoPulledProviders.set(node.id, pulled)
  }

  // ---------------- 事件归并（WS 增量 & 控制帧） ----------------
  function initializeOnlineNode(node: AgentNode) {
    if (node.status !== 'online') return
    autoPullSessionsForNode(node)
    requestProjectPermissions(node.id)
  }

  function rememberSessionRuntime(key: string, frame: FleetWsEvent) {
    const session = sessionsByKey.value[key]
    if (!session) return
    const { currentModel, currentEffort } = frame
    const modelChanged = typeof currentModel === 'string' && session.currentModel !== currentModel
    const effortChanged = (typeof currentEffort === 'string' || currentEffort === null) && session.currentEffort !== currentEffort
    if (modelChanged && currentModel !== (session.currentModel ?? runSettings.value[key]?.model)) {
      delete contextUsageBySession.value[key]
      delete contextReads.value[key]
      delete contextWaitingForModel.value[key]
    }
    if (modelChanged || effortChanged) {
      sessionsByKey.value[key] = {
        ...session,
        ...(modelChanged ? { currentModel } : {}),
        ...(effortChanged ? { currentEffort } : {}),
      }
    }
  }

  function pushAudit(entry: AuditEntry) {
    auditRing.push(entry)
    if (auditRing.length > 300) auditRing.shift()
  }

  function dumpAuditLog(): string {
    return auditRing.map(e => `${new Date(e.t).toISOString()} [audit] side=client session=${e.session} run=${e.run} stream=${e.stream} seq=${e.seq} type=${e.type} call=${e.call}${e.error ? ` error=${e.error}` : ''}`).join('\n')
  }

  function frameSessionKey(frame: FleetWsEvent) {
    const nodeId = frame.nodeId ?? selectedNode.value?.id ?? ''
    if (!frame.sessionId) return activeSessionKey.value
    return frame.provider ? sessionKey(nodeId, frame.provider, frame.sessionId)
      : Object.keys(sessionsByKey.value).find(key => key.endsWith(`::${frame.sessionId}`) && key.startsWith(`${nodeId}::`))
        ?? sessionKey(nodeId, selectedProvider.value, frame.sessionId)
  }

  function reportFrameFailure(frame: FleetWsEvent | undefined, error: unknown) {
    const key = frame ? frameSessionKey(frame) : ''
    pushAudit({ t: Date.now(), type: 'ApplyError', session: auditField(frame?.sessionId, 8),
      run: auditField(frame?.runId, 8), stream: auditField(frame?.streamId, 8),
      seq: frame?.sequence ?? frame?.seq ?? '-', call: auditField(frame?.callId, 8),
      error: auditField(error instanceof Error ? `${error.name}: ${error.message}` : String(error), 200) })
    lastError.value = '会话事件应用失败，正在请求快照'
    if (!key || !sessionsByKey.value[key]) return
    const state = streamState(key)
    if (frame?.sequence !== undefined && !state.buffer.some(row => row.streamId === frame.streamId && row.sequence === frame.sequence)) {
      state.buffer.push(frame)
      if (state.buffer.length > STREAM_BUFFER_CAP) state.buffer.shift()
    }
    // A failed snapshot must terminate, rather than starting an unbounded recovery loop.
    if (state.snapshot) failRecovery(key, '会话快照应用失败，请重试')
    else requestSnapshotHistory(key)
  }

  function bufferStreamFrame(sKey: string, frame: FleetWsEvent) {
    const state = streamState(sKey)
    if (!state.buffer.some(row => row.streamId === frame.streamId && row.sequence === frame.sequence)) state.buffer.push(frame)
    if (state.buffer.length > STREAM_BUFFER_CAP) {
      pushAudit({ t: Date.now(), type: 'BufferOverflow', session: auditField(frame.sessionId, 8),
        run: '-', stream: auditField(frame.streamId, 8), seq: frame.sequence ?? '-', call: '-' })
      const covered = state.snapshot && state.buffer.findIndex(row => row.streamId === state.snapshot!.streamId
        && row.sequence! <= state.snapshot!.lastSeq)
      if (typeof covered === 'number' && covered >= 0) {
        state.buffer.splice(covered, 1)
        return
      }
      // The requested authoritative snapshot covers the discarded incrementals.
      clearHistory(sKey)
      state.snapshot = undefined
      requestSnapshotHistory(sKey)
      state.buffer.splice(0, state.buffer.length - STREAM_BUFFER_CAP)
    } else if (state.phase !== 'resyncing') {
      state.phase = 'gap'
      subscribeSession(sKey)
    }
  }

  function applyStreamFrame(sKey: string, frame: FleetWsEvent) {
    applyWsEvent(frame)
    const sequence = frame.sequence ?? frame.seq
    if (typeof sequence === 'number') commitCursor(sKey, frame.streamId, sequence)
  }

  function flushStreamBuffer(sKey: string) {
    const state = streamState(sKey)
    const streamId = streamIdBySession.get(sKey)
    state.buffer.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
    while (state.buffer.length) {
      const frame = state.buffer[0]
      const cursor = state.cursors.get(frame.streamId ?? '') ?? 0
      if (frame.streamId !== streamId) break
      if (frame.sequence! <= cursor) { state.buffer.shift(); continue }
      if (frame.sequence! !== cursor + 1) break
      try { applyStreamFrame(sKey, frame) }
      catch (error) { reportFrameFailure(frame, error); return }
      state.buffer.shift()
    }
    state.phase = state.buffer.length ? 'gap' : 'live'
    if (state.phase === 'gap') subscribeSession(sKey)
  }

  function applyStreamReplay(sKey: string, frame: FleetWsEvent) {
    if (frame.requestId && pendingStreamResync.get(sKey) !== frame.requestId) return
    const state = streamState(sKey)
    if (state.snapshot) return
    clearSubscribe(sKey)
    state.retries = 0
    const session = sessionsByKey.value[sKey]
    const nodeId = frame.nodeId ?? session?.nodeId
    const provider = frame.provider ?? session?.provider
    if (!nodeId || !provider || !frame.sessionId) return
    if (frame.streamId) streamIdBySession.set(sKey, frame.streamId)
    const refreshApprovals = () => {
      if (!Array.isArray(frame.pendingApprovals)) return
      dismissSessionApprovals(sKey, new Set(frame.pendingApprovals.map(event => event.callId)))
      for (const approval of frame.pendingApprovals) applyWsEvent({ ...approval, nodeId, provider, sessionId: frame.sessionId })
    }
    if (frame.snapshotRequired) {
      rememberSessionRuntime(sKey, frame)
      reconcileRuntime(sKey, frame)
      appendSystemEvent(sKey, nodeId, provider, `sys-reconnect-${frame.requestId ?? createRequestId()}`, {
        kind: 'reconnected', at: Date.now(), detail: { summary: '实时记录无法接续，已请求节点返回会话快照。' },
      })
      requestSnapshotHistory(sKey, { streamId: frame.streamId, lastSeq: frame.lastSeq ?? 0 })
      requestSessionDiff(sKey)
      refreshApprovals()
      return
    }
    state.phase = 'gap'
    const events = [...(frame.events ?? [])].sort((a, b) => (a.sequence ?? a.seq ?? 0) - (b.sequence ?? b.seq ?? 0))
    const initialCursor = state.cursors.get(frame.streamId ?? '') ?? 0
    if (!frame.incremental && !initialCursor && events.length) {
      const runIds = new Set(events.map(event => event.runId || event.requestId).filter(Boolean))
      messagesBySession.value = { ...messagesBySession.value, [sKey]: (messagesBySession.value[sKey] ?? [])
        .filter(message => !(message.role === 'assistant' && (message.streaming || (message.runId && runIds.has(message.runId))))) }
    }
    for (const event of events) {
      const sub = { ...event, nodeId, provider, sessionId: frame.sessionId }
      const cursor = state.cursors.get(sub.streamId ?? '') ?? 0
      if (typeof sub.sequence === 'number' && sub.streamId && sub.sequence <= cursor) continue
      if (frame.incremental && typeof sub.sequence === 'number' && sub.sequence > cursor + 1) {
        bufferStreamFrame(sKey, sub)
        requestSnapshotHistory(sKey)
        return
      }
      try { applyStreamFrame(sKey, sub) }
      catch (error) { reportFrameFailure(sub, error); return }
    }
    rememberSessionRuntime(sKey, frame)
    reconcileRuntime(sKey, frame)
    refreshApprovals()
    if (typeof frame.lastSeq === 'number') commitCursor(sKey, frame.streamId, frame.lastSeq)
    if (snapshotFollowIntent.get(sKey)?.requestId === null) snapshotFollowIntent.delete(sKey)
    state.phase = 'live'
    flushStreamBuffer(sKey)
    void flushOutbox()
  }

  function handleWsEvent(frame: FleetWsEvent) {
    const sKey = frameSessionKey(frame)
    try {
      if (frame.requestId && retiredStreamRequests.has(frame.requestId) && ['Failed', 'NodeUnavailable', 'Error'].includes(frame.type)) return
      if (frame.type === 'SessionStreamReplay' && sKey && Array.isArray(frame.events)) {
        applyStreamReplay(sKey, frame)
        return
      }
      if (sKey && typeof frame.sequence === 'number' && frame.streamId) {
        const state = streamState(sKey)
        const prior = streamIdBySession.get(sKey)
        const cursor = state.cursors.get(frame.streamId) ?? 0
        if (frame.sequence <= cursor) return // Already committed in this stream generation.
        if (!prior) streamIdBySession.set(sKey, frame.streamId)
        if (state.phase !== 'live' || (prior && prior !== frame.streamId) || frame.sequence > cursor + 1) {
          bufferStreamFrame(sKey, frame)
          return
        }
      }
      applyStreamFrame(sKey, frame)
    } catch (error) {
      reportFrameFailure(frame, error)
    }
  }

  function applyWsEvent(frame: FleetWsEvent) {
    const etype = frame.type
    const seq = frame.seq ?? frame.sequence
    pushAudit({
      t: Date.now(),
      type: auditField(etype),
      session: auditField(frame.sessionId, 8),
      run: auditField(frame.runId, 8),
      stream: auditField(frame.streamId, 8),
      seq: typeof seq === 'number' && Number.isInteger(seq) ? seq : auditField(seq),
      call: auditField(frame.callId, 8),
    })

    const steer = frame.requestId ? pendingSteers.get(frame.requestId) : undefined
    if (steer && (etype === 'SteerAccepted' || etype === 'SteerRejected' || etype === 'Error'
      || etype === 'NodeUnavailable' || etype === 'Failed')) {
      steer.finish(etype === 'SteerAccepted')
      return
    }

    if (etype === 'FleetSnapshot' && Array.isArray(frame.nodes)) {
      reconnectAttempt = 0
      wsState.value = 'online'
      declareNativeSessionEvents?.()
      lastError.value = null
      const onlineMap = new Map(frame.nodes.map(item => [((item as unknown as { nodeId?: string }).nodeId ?? item.id), item]))
      nodes.value = nodes.value.map(existing => {
        const live = onlineMap.get(existing.id)
        if (!live) {
          autoPulledProviders.delete(existing.id)
          return existing.status === 'revoked' ? existing : { ...existing, status: 'offline' }
        }
        return {
          ...existing,
          status: 'online',
          adapters: live.adapters ?? existing.adapters,
          allowedRoots: live.allowedRoots ?? existing.allowedRoots,
          transferEndpoints: live.transferEndpoints ?? existing.transferEndpoints,
        }
      })
      nodes.value.forEach(initializeOnlineNode)
      for (const key of new Set([activeSessionKey.value, ...Object.keys(runningBySession.value), ...snapshotFollowIntent.keys(), ...[...streamStateBySession].filter(([, state]) => state.phase !== 'live').map(([key]) => key)])) {
        if (key) subscribeSession(key)
      }
      if (activeSessionKey.value) loadSessionHistory(activeSessionKey.value, cachedHistoryKeys.has(activeSessionKey.value))
      void flushOutbox()
      return
    }

    if (etype === 'NodePresence' && frame.nodeId) {
      const liveStatus = (frame as unknown as { status?: string }).status ?? 'offline'
      if (liveStatus !== 'online') {
        if (nodes.value.find(node => node.id === frame.nodeId)?.status === 'online') {
          captureSnapshotFollow(frame.nodeId)
          for (const key of new Set([...snapshotFollowIntent.keys(), ...streamStateBySession.keys(), ...Object.keys(pendingHistoryPages.value), ...Object.keys(runningBySession.value)])) {
            if (sessionsByKey.value[key]?.nodeId !== frame.nodeId) continue
            clearSubscribe(key)
            clearHistory(key)
            const state = streamStateBySession.get(key)
            if (state) {
              clearTimeout(state.snapshotTimer)
              state.snapshotTimer = undefined
              state.phase = 'gap'
              state.snapshot = undefined
            }
            delete runningBySession.value[key]
            reconcileRunMessages(key)
          }
        }
        autoPulledProviders.delete(frame.nodeId)
        for (const [requestId, target] of pendingSessionLists) {
          if (!target.startsWith(`${frame.nodeId}::`)) continue
          pendingSessionLists.delete(requestId)
          sessionListStates.value[target] = {}
        }
      }
      nodes.value = nodes.value.map(n => {
        if (n.id !== frame.nodeId) return n
        return {
          ...n,
          status: liveStatus,
          adapters: ((frame as unknown as { adapters?: AgentNode['adapters'] }).adapters) ?? n.adapters,
          allowedRoots: ((frame as unknown as { allowedRoots?: string[] }).allowedRoots) ?? n.allowedRoots,
          transferEndpoints: ((frame as unknown as { transferEndpoints?: AgentNode['transferEndpoints'] }).transferEndpoints) ?? n.transferEndpoints,
        }
      })
      const liveNode = nodes.value.find(n => n.id === frame.nodeId)
      if (liveNode) initializeOnlineNode(liveNode)
      if (liveStatus === 'online') {
        for (const key of new Set([activeSessionKey.value, ...Object.keys(runningBySession.value), ...snapshotFollowIntent.keys(), ...[...streamStateBySession].filter(([, state]) => state.phase !== 'live').map(([key]) => key)])) {
          if (sessionsByKey.value[key]?.nodeId === frame.nodeId) subscribeSession(key)
        }
        void flushOutbox()
      }
      return
    }

    if (etype === 'ProjectPermissionsSnapshot' && frame.nodeId && Array.isArray(frame.projectPermissions)) {
      projectPermissionsByNode.value = { ...projectPermissionsByNode.value, [frame.nodeId]: frame.projectPermissions }
      if (frame.requestId) projectPermissionWrites.get(frame.requestId)?.()
      return
    }

    if (frame.requestId && ['Failed', 'NodeUnavailable', 'Error'].includes(etype)) {
      const settingWrite = pendingSessionWrites.get(frame.requestId)
      if (settingWrite) {
        settingWrite.finish(new Error(frame.message || (settingWrite.field === 'currentModel' ? '切换模型失败' : '切换思考强度失败')))
        return
      }
      const projectWrite = projectPermissionWrites.get(frame.requestId)
      if (projectWrite) {
        projectWrite(new Error(frame.message || '无法保存项目默认权限'))
        return
      }
      const pendingPrompt = outbox.value.find(item => item.id === frame.requestId)
      if (pendingPrompt) {
        transmittingOutbox.delete(pendingPrompt.id)
        const rows = messagesBySession.value[pendingPrompt.sessionKey] ?? []
        messagesBySession.value = { ...messagesBySession.value, [pendingPrompt.sessionKey]: rows.filter(row => row.id !== `user-${pendingPrompt.id}`) }
        if (etype !== 'NodeUnavailable') {
          restoreOutboxDraft(pendingPrompt)
          void removeOutboxPrompt(pendingPrompt)
          lastError.value = frame.message || '发送失败，消息已还原到输入框'
        }
        return
      }
      const streamRequest = [...pendingStreamResync].find(([, requestId]) => requestId === frame.requestId)
      if (streamRequest) {
        const [key] = streamRequest
        retrySubscribe(key)
        return
      }
      const forcedHistory = forcedHistoryRequests.delete(frame.requestId)
      const historyRequest = Object.keys(pendingHistoryPages.value).find(key => pendingHistoryPages.value[key] === frame.requestId)
      if (historyRequest) {
        clearHistory(historyRequest)
        historyStateBySession.value[historyRequest] = { state: 'error', message: frame.message || '无法读取历史消息' }
        finishSnapshotHistory(historyRequest, frame.requestId, false)
        if (streamStateBySession.get(historyRequest)?.phase !== 'live') failRecovery(historyRequest, frame.message || '无法读取历史消息')
        return
      }
      if (forcedHistory) return
      const contextRead = Object.keys(contextReads.value).find(key => contextReads.value[key] === frame.requestId)
      if (contextRead) {
        delete contextReads.value[contextRead]
        return
      }
      const compaction = Object.keys(contextCompactions.value).find(key => contextCompactions.value[key] === frame.requestId)
      if (compaction) delete contextCompactions.value[compaction]
      const listTarget = pendingSessionLists.get(frame.requestId)
      if (listTarget) {
        pendingSessionLists.delete(frame.requestId)
        sessionListStates.value[listTarget] = { error: frame.message || '无法读取会话列表' }
        return
      }
      const mcpTarget = pendingMcpRequests.get(frame.requestId)
      if (mcpTarget) {
        pendingMcpRequests.delete(frame.requestId)
        mcpErrorsByTarget.value = { ...mcpErrorsByTarget.value, [mcpTarget]: frame.message || '无法读取 MCP 服务状态' }
        return
      }
      const index = pendingOpenQueue.findIndex(p => p.requestId === frame.requestId)
      if (index >= 0) {
        pendingOpenQueue.splice(index, 1)
        lastError.value = frame.message || '无法创建会话'
        return
      }
    }

    if (etype === 'DuplicateIgnored' && frame.requestId) {
      const pending = outbox.value.find(item => item.id === frame.requestId)
      if (pending) {
        void removeOutboxPrompt(pending)
        subscribeSession(pending.sessionKey)
        loadSessionHistory(pending.sessionKey, true)
      }
      return
    }
    const nodeId = frame.nodeId ?? selectedNode.value?.id ?? ''
    const provider = (frame.provider ?? selectedProvider.value) as AdapterProvider

    if (etype === 'ModelsSnapshot' && nodeId && Array.isArray(frame.models)) {
      // 适配器可能漏字段（例如没有思考档位的 ACP 后端）；efforts 必填是 FleetModel 契约，
      // 缺了会让模型选择器渲染时 entry.efforts.length 抛错并连带整块会话视图白屏。
      const models = (frame.models as FleetModel[]).map(model => ({ ...model, efforts: model.efforts ?? [] }))
      catalogs.value[`${nodeId}::${provider}`] = { models, message: frame.message }

      applyDefaultModelPref(`${nodeId}::${provider}`, nodeId, provider)
      for (const [k, s] of Object.entries(sessionsByKey.value)) {
        if (s.nodeId === nodeId && s.provider === provider) {
          applyDefaultModelPref(k, nodeId, provider)
        }
      }
      return
    }

    if (etype === 'AgentsSnapshot' && nodeId && Array.isArray(frame.agents)) {
      agentsByTarget.value = { ...agentsByTarget.value, [`${nodeId}::${provider}`]: frame.agents }
      return
    }

    if (etype === 'McpSnapshot' && nodeId && Array.isArray(frame.servers)) {
      if (frame.requestId) pendingMcpRequests.delete(frame.requestId)
      const key = `${nodeId}::${provider}`
      mcpErrorsByTarget.value = { ...mcpErrorsByTarget.value, [key]: frame.message || '' }
      if (!frame.message) mcpByTarget.value = { ...mcpByTarget.value, [key]: frame.servers }
      return
    }

    if (etype === 'RulesSnapshot' && nodeId && Array.isArray(frame.rules)) {
      const target = frame.sessionId ? sessionKey(nodeId, provider, frame.sessionId) : `${nodeId}::${provider}`
      rulesByTarget.value = {
        ...rulesByTarget.value,
        [`${nodeId}::${provider}`]: frame.rules,
        [target]: frame.rules,
      }
      return
    }

    if (etype === 'SkillsSnapshot' && nodeId && Array.isArray(frame.skills)) {
      const target = frame.sessionId ? sessionKey(nodeId, provider, frame.sessionId) : `${nodeId}::${provider}`
      skillsByTarget.value = {
        ...skillsByTarget.value,
        [`${nodeId}::${provider}`]: frame.skills,
        [target]: frame.skills,
      }
      return
    }

    if (etype === 'FilesSnapshot' && nodeId && Array.isArray(frame.files)) {
      const filePaths = (frame.files as unknown[]).filter((x): x is string => typeof x === 'string')
      const nextCache = {
        ...filesCacheByTarget.value,
        [`${nodeId}::${provider}`]: filePaths,
      }
      if (frame.sessionId) {
        nextCache[sessionKey(nodeId, provider, frame.sessionId)] = filePaths
      }
      filesCacheByTarget.value = nextCache
      return
    }

    if (etype === 'FilesTreeSnapshot' && nodeId && Array.isArray(frame.entries)) {
      const relDir = frame.relDir || ''
      const scopeKey = frame.sessionId
        ? `${nodeId}::${provider}::${frame.sessionId}::${relDir}`
        : `${nodeId}::${provider}::${relDir}`
      treeCacheByTarget.value = {
        ...treeCacheByTarget.value,
        [scopeKey]: frame.entries,
        [`${nodeId}::${provider}::${relDir}`]: frame.entries,
      }
      return
    }

    if (etype === 'TrustPolicySnapshot' && nodeId && Array.isArray(frame.patterns)) {
      trustPatternsByNode.value = {
        ...trustPatternsByNode.value,
        [nodeId]: frame.patterns,
      }
      return
    }

    if (etype === 'SessionsSnapshot' && nodeId && Array.isArray(frame.sessions)) {
      const target = frame.requestId ? pendingSessionLists.get(frame.requestId) : undefined
      if (frame.requestId) pendingSessionLists.delete(frame.requestId)
      sessionListStates.value[target || `${nodeId}::${provider}`] = {}
      const next = { ...sessionsByKey.value }
      const added: Array<{ k: string; p: AdapterProvider }> = []
      for (const s of frame.sessions) {
        if (!s.sessionId) continue
        const p = (s.provider || provider) as AdapterProvider
        const k = sessionKey(nodeId, p, s.sessionId)
        const existingTitle = next[k]?.title
        let resolvedTitle = redactSessionTitleCredentials(s.title || '')
        if (isGenericSessionTitle(resolvedTitle)) {
          if (existingTitle && !isGenericSessionTitle(existingTitle)) {
            resolvedTitle = existingTitle
          } else {
            const firstUser = (messagesBySession.value[k] ?? []).find(m => m.role === 'user' && m.text.trim())
            resolvedTitle = (firstUser ? deriveOptimisticSessionTitle(firstUser.text) : '') || '新对话'
          }
        }
        next[k] = {
          ...(next[k] ?? {}),
          sessionId: s.sessionId,
          nodeId,
          provider: p,
          title: resolvedTitle,
          cwd: s.cwd || next[k]?.cwd || '',
          worktreePath: s.worktreePath || next[k]?.worktreePath,
          projectKey: s.projectKey || next[k]?.projectKey,
          projectName: s.projectName || next[k]?.projectName,
          projectDirectory: s.projectDirectory || next[k]?.projectDirectory,
          branch: s.branch || next[k]?.branch,
          model: s.model || next[k]?.model,
          updatedAt: s.updatedAt ?? next[k]?.updatedAt,
        }
        added.push({ k, p })
      }
      sessionsByKey.value = next
      for (const item of added) {
        applyDefaultModelPref(item.k, nodeId, item.p)
      }
      return
    }

    if (etype === 'SessionOpened' && nodeId && frame.sessionId) {
      const k = sessionKey(nodeId, provider, frame.sessionId)
      const existing = sessionsByKey.value[k]
      const initialTitle =
        frame.title && !isGenericSessionTitle(frame.title) ? redactSessionTitleCredentials(frame.title) : '新对话'
      sessionsByKey.value = {
        ...sessionsByKey.value,
        [k]: {
          sessionId: frame.sessionId,
          nodeId,
          provider,
          title: initialTitle,
          cwd: frame.cwd || '',
          worktreePath: frame.worktreePath ?? null,
          projectKey: frame.projectKey,
          projectName: frame.projectName,
          projectDirectory: frame.projectDirectory,
          branch: frame.branch,
          currentModel: frame.currentModel ?? existing?.currentModel,
          currentEffort: frame.currentEffort,
          updatedAt: existing?.updatedAt ?? Date.now(),
        },
      }
      if (!messagesBySession.value[k]) {
        messagesBySession.value = { ...messagesBySession.value, [k]: [] }
      }
      const queuedIdx = pendingOpenQueue.findIndex(
        item => item.requestId === frame.requestId && item.nodeId === nodeId && item.provider === provider,
      )
      if (queuedIdx >= 0 && !pendingOpenQueue[queuedIdx].onOpened) activeSessionKey.value = k
      if (queuedIdx >= 0) {
        const [item] = pendingOpenQueue.splice(queuedIdx, 1)
        // 先应用继承的模型与思考强度配置，再触发 onOpened，确保新会话/分屏/侧边问答首帧即显示继承模型
        if (item.options) {
          runSettings.value = { ...runSettings.value, [k]: { ...item.options } }
        }
        if (!runSettings.value[k]?.model && runSettings.value[k]?.model !== '') {
          applyDefaultModelPref(k, nodeId, provider)
        }
        item.onOpened?.(k)
        if (item.initialHandoff) {
          sendHandoff({ targetNodeId: nodeId, targetProvider: provider, targetSessionId: frame.sessionId, ...item.initialHandoff })
        } else if (item.initialPrompt) {
          void sendPromptToSession(k, item.initialPrompt, item.initialAttachments ?? [], runSettings.value[k])
        }
      } else {
        applyDefaultModelPref(k, nodeId, provider)
      }
      return
    }

    if (etype === 'SessionHistory' && nodeId && frame.sessionId && Array.isArray(frame.messages)) {
      const k = sessionKey(nodeId, provider, frame.sessionId)
      if (frame.requestId && pendingHistoryPages.value[k] !== frame.requestId) return
      rememberSessionRuntime(k, frame)
      const releasedPage = Boolean(frame.requestId && pendingHistoryPages.value[k] === frame.requestId)
      const forced = Boolean(frame.requestId && forcedHistoryRequests.has(frame.requestId))
      const snapshot = streamStateBySession.get(k)?.snapshot?.requestId === frame.requestId && Boolean(frame.requestId)
      if (releasedPage) clearHistory(k)
      if (frame.cursorExpired) {
        delete historyCursorBySession.value[k]
        const state = streamStateBySession.get(k)
        const anchor = state?.snapshot
        if (state && anchor) {
          state.snapshot = undefined
          requestSnapshotHistory(k, anchor)
        } else loadSessionHistory(k, true)
        return
      }
      if (frame.historyCursor !== undefined) historyCursorBySession.value[k] = frame.historyCursor
      if (frame.messages.length) {
        const hasDetails = frame.messages.some(row => row.thought || row.toolCalls?.length || row.parts?.some(part => part.type !== 'text'))
        if (!frame.beforeCursor || historyStateBySession.value[k]?.state !== 'ready') {
          historyStateBySession.value[k] = { state: provider === 'hermes' && !hasDetails ? 'body-only' : 'ready' }
        }
      } else if (!frame.beforeCursor) {
        historyStateBySession.value[k] = { state: 'empty' }
      }
      const existing = messagesBySession.value[k] ?? []
      const liveRunId = runningBySession.value[k]
      const hasLiveHistory = frame.messages.some(m => m.runId || m.thought || m.toolCalls?.length)
      if (!frame.messages.length) {
        if (!frame.beforeCursor) {
          if (snapshot) messagesBySession.value = { ...messagesBySession.value,
            [k]: existing.filter(message => message.role === 'system' || Boolean(liveRunId && message.runId === liveRunId)) }
          finishSnapshotHistory(k, frame.requestId, true)
        }
        return
      }
      // 支持向上分页加载更早历史：当新拉取条数多于当前内存条数时允许替换刷新
      const hasSystemHistory = frame.messages.some(m => m.systemEvents?.length)
      if (!forced && !frame.beforeCursor && !hasLiveHistory && !hasSystemHistory && existing.some(m => m.role !== 'system') &&
        frame.messages.length <= existing.length) return
      cachedHistoryKeys.delete(k)
      const hydrated: ChatMessage[] = frame.messages.map((m, idx) => {
        const live = (m.runId || m.requestId)
          ? existing.find(row => row.role === m.role && (
              Boolean(m.runId && (row.runId === m.runId || row.requestId === m.runId)) || Boolean(m.requestId && row.requestId === m.requestId)
            ))
          // 历史回放没有 runId/requestId：退回内容指纹，从最近的消息往前找
          : [...existing].reverse().find(row => sameTurnContent(row, m))
        if (!snapshot && live && live.text.length >= (m.text?.length ?? 0) && (live.thought?.length ?? 0) >= (m.thought?.length ?? 0) &&
          (live.toolCalls?.length ?? 0) >= (m.toolCalls?.length ?? 0)) {
          return live.delivery === 'sending' ? { ...live, delivery: 'sent' } : live
        }
        const mappedTools = Array.isArray(m.toolCalls) && m.toolCalls.length
          ? m.toolCalls.map((tc, tIdx) => ({
              id: tc.callId || tc.id || `hist-tc-${idx}-${tIdx}`,
              callId: tc.callId,
              name: tc.name || 'tool',
              toolKind: tc.toolKind,
              title: tc.title || tc.detail || tc.name,
              detail: tc.detail,
              status: tc.status || 'completed',
              input: tc.input,
              output: tc.output,
              error: tc.error,
              durationMs: tc.durationMs,
              subagentSessionId: tc.subagentSessionId,
              ...(tc.media?.length ? { media: tc.media } : {}),
            }))
          : undefined
        const combinedMedia: import('../types/fleet').MessageMediaItem[] = []
        const seenMediaUrls = new Set<string>()
        for (const item of [...(m.media ?? []), ...(mappedTools?.flatMap(t => t.media ?? []) ?? [])]) {
          if (item?.url && !seenMediaUrls.has(item.url)) {
            seenMediaUrls.add(item.url)
            combinedMedia.push(item)
          }
        }
        const mappedParts = Array.isArray(m.parts) && m.parts.length
          ? m.parts.reduce<import('../types/fleet').MessagePart[]>((acc, p) => {
              if (p.type === 'thought' && p.text) return appendMessagePart(acc, { type: 'thought', text: p.text })
              if (p.type === 'text' && p.text) return appendMessagePart(acc, { type: 'text', text: p.text })
              if (p.type === 'tool' && (p.callId || p.id)) return appendMessagePart(acc, { type: 'tool', callId: p.callId || p.id! })
              return acc
            }, [])
          : undefined
        return {
          id: m.id || (m.runId ? `hist-${m.role}-${m.runId}` : `hist-${frame.requestId ?? createRequestId()}-${idx}`),
          role: m.role === 'user' || m.role === 'system' ? m.role : 'assistant',
          nodeId,
          provider,
          runId: m.runId,
          requestId: m.requestId,
          text: m.text ?? '',
          ...(m.systemEvents?.length ? { systemEvents: m.systemEvents } : {}),
          ...(m.thought ? { thought: m.thought } : {}),
          ...(mappedTools ? { toolCalls: mappedTools } : {}),
          ...(mappedParts?.length ? { parts: mappedParts } : {}),
          ...(combinedMedia.length ? { media: combinedMedia } : {}),
          streaming: Boolean(m.runId && m.role === 'assistant' && m.runId === liveRunId),
          createdAt: m.createdAt ?? Date.now(),
        }
      })
      if (frame.beforeCursor) {
        const existingIds = new Set(existing.map(row => row.id))
        messagesBySession.value = { ...messagesBySession.value, [k]: [
          ...hydrated.filter(row => !existingIds.has(row.id)), ...existing,
        ].slice(-MAX_MESSAGES_PER_SESSION) }
        return
      }
      if (liveRunId) {
        for (const message of existing) {
          if ((message.runId === liveRunId || message.requestId === liveRunId)
            && !hydrated.some(row => row.role === message.role && (row.runId === liveRunId || row.requestId === liveRunId))) {
            hydrated.push(message)
          }
        }
      }
      messagesBySession.value = {
        ...messagesBySession.value,
        [k]: mergeHistoryBoundaries(existing, hydrated).slice(-MAX_MESSAGES_PER_SESSION),
      }
      const curSess = sessionsByKey.value[k]
      if (curSess && isGenericSessionTitle(curSess.title)) {
        const firstUser = hydrated.find(x => x.role === 'user' && x.text.trim())
        const derived = firstUser ? deriveOptimisticSessionTitle(firstUser.text) : ''
        if (derived) {
          sessionsByKey.value = {
            ...sessionsByKey.value,
            [k]: { ...curSess, title: derived },
          }
        }
      }
      finishSnapshotHistory(k, frame.requestId, true)
      return
    }

    // 以下事件均绑定到具体的 (nodeId, provider, sessionId)
    const sid = frame.sessionId
    const sKey = sid && nodeId
      ? (frame.provider ? sessionKey(nodeId, provider, sid) : Object.keys(sessionsByKey.value).find(
          k => k.endsWith(`::${sid}`) && k.startsWith(`${nodeId}::`),
        ) ?? sessionKey(nodeId, provider, sid))
      : activeSessionKey.value

    if (!sKey || !nodeId) {
      if (etype === 'Failed' || etype === 'NodeUnavailable' || etype === 'Error') {
        lastError.value = frame.message || '节点操作失败'
      }
      return
    }

    const effProvider = sessionsByKey.value[sKey]?.provider ?? provider

    if (etype !== 'SessionStreamReplay') rememberSessionRuntime(sKey, frame)

    if (etype === 'ContextUsage' && frame.requestId) {
      const settingWrite = pendingSessionWrites.get(frame.requestId)
      if (settingWrite?.key === sKey) {
        const value = frame[settingWrite.field]
        if (typeof value === 'string' || (settingWrite.field === 'currentEffort' && value === null)) {
          settingWrite.finish(value)
        } else {
          settingWrite.finish(new Error(settingWrite.field === 'currentModel' ? '节点未确认当前模型' : '节点未确认当前思考强度'))
        }
        return
      }
    }

    if (etype === 'FileWritten' && frame.path) {
      const existing = filePreviewBySession.value[sKey]
      if (existing && existing.path === frame.path) {
        filePreviewBySession.value = {
          ...filePreviewBySession.value,
          [sKey]: {
            ...existing,
            saving: false,
            lineCount: frame.lineCount ?? existing.lineCount,
            sizeBytes: frame.sizeBytes ?? existing.sizeBytes,
            updatedAt: Date.now(),
          },
        }
      }
      return
    }

    if (etype === 'FileBlameSnapshot' && frame.path && Array.isArray(frame.lines)) {
      const existing = filePreviewBySession.value[sKey]
      if (existing && existing.path === frame.path) {
        filePreviewBySession.value = {
          ...filePreviewBySession.value,
          [sKey]: {
            ...existing,
            blame: frame.lines,
            blameLoading: false,
          },
        }
      }
      return
    }

    if (etype === 'FileContentSnapshot' && frame.path) {
      if (!frame.isBinary && typeof frame.content === 'string') {
        const lines = frame.content.replace(/\r\n/g, '\n').split('\n')
        fileTextCacheBySession.value = {
          ...fileTextCacheBySession.value,
          [sKey]: {
            ...(fileTextCacheBySession.value[sKey] ?? {}),
            [frame.path]: lines,
          },
        }
      }
      const download = frame.requestId ? pendingDownloadRequests.get(frame.requestId) : undefined
      if (frame.requestId && download) {
        pendingDownloadRequests.delete(frame.requestId)
        silentFileReadRequests.delete(frame.requestId)
        if (frame.truncated || (frame.isBinary && !frame.base64Data) || frame.sizeBytes === 0
          || (!frame.base64Data && !frame.content)) {
          lastError.value = '无法下载文件：节点未返回完整文件'
          return
        }
        try {
          const blob = frame.base64Data
            ? new Blob([decodeBase64Url(frame.base64Data)], { type: frame.mime || 'application/octet-stream' })
            : new Blob([frame.content || ''], { type: `${frame.mime || 'text/plain'};charset=utf-8` })
          void saveBlobToDevice(blob, download.fileName).then(() => download.onSaved?.()).catch(error => {
            lastError.value = error instanceof Error ? error.message : '下载失败'
          })
        } catch {
          lastError.value = '无法下载文件：节点返回的文件数据无效'
        }
        return
      }
      if (frame.requestId && silentFileReadRequests.has(frame.requestId)) {
        silentFileReadRequests.delete(frame.requestId)
        return
      }
      const existing = filePreviewBySession.value[sKey]
      filePreviewBySession.value = {
        ...filePreviewBySession.value,
        [sKey]: {
          path: frame.path,
          language: frame.language || '',
          content: frame.content || '',
          lineCount: frame.lineCount || 0,
          truncated: Boolean(frame.truncated),
          sizeBytes: frame.sizeBytes || 0,
          isBinary: Boolean(frame.isBinary),
          mime: frame.mime,
          base64Data: frame.base64Data,
          loading: false,
          highlightLine: existing?.path === frame.path ? existing.highlightLine : undefined,
          updatedAt: Date.now(),
        },
      }
      return
    }

    if (etype === 'Accepted') {
      const rid = frame.runId || frame.requestId || createRequestId()
      const requestId = frame.requestId || rid
      const contextWait = contextWaitingForModel.value[sKey]
      const submittedPrompt = pendingRunPrompts.get(`${sKey}::${requestId}`)
      if (contextWait && !contextWait.runId
        && (!submittedPrompt || (submittedPrompt.model ?? '') === (runSettings.value[sKey]?.model ?? ''))) {
        contextWait.runId = rid
      }
      if (submittedPrompt && typeof frame.currentModel === 'string') submittedPrompt.model = frame.currentModel
      delete contextReads.value[sKey]
      updatePromptDelivery(sKey, requestId, 'sent')
      const delivered = outbox.value.find(item => item.id === requestId && item.sessionKey === sKey)
      if (delivered) {
        deliveredOutbox.set(rid, delivered)
        void removeOutboxPrompt(delivered)
      }
      lastError.value = null
      if (frame.requestId && frame.runId && frame.runId !== frame.requestId) {
        if (submittedPrompt) pendingRunPrompts.set(`${sKey}::${frame.runId}`, submittedPrompt)
      }
      runningBySession.value = { ...runningBySession.value, [sKey]: rid }
      delete stopStatusBySession.value[sKey]
      if (frame.handoffSummary) {
        appendSystemEvent(sKey, nodeId, effProvider, `sys-handoff-${frame.requestId || rid}`, {
          kind: 'handoff', at: Date.now(), detail: { summary: frame.handoffSummary, sourceSessionKey: frame.handoffSource },
        })
      }
      if (interruptedBySession.value[sKey]) {
        const nextInt = { ...interruptedBySession.value }
        delete nextInt[sKey]
        interruptedBySession.value = nextInt
      }
      ensureStreamingAssistantMessage(sKey, nodeId, effProvider, rid, frame.requestId)
      return
    }

    if (etype === 'RunStopStatus') {
      if (frame.requestId && stopStatusBySession.value[sKey]?.requestId === frame.requestId &&
        (frame.status === 'accepted' || frame.status === 'error')) {
        stopStatusBySession.value[sKey] = { requestId: frame.status === 'accepted' ? frame.requestId : undefined,
          state: frame.status, message: frame.message }
      }
      return
    }

    if (etype === 'TokenUsage') {
      recordedUsage.record(sKey, frame, frame.seq)
      tokenUsageStateBySession.value = {
        ...tokenUsageStateBySession.value,
        [sKey]: applyTokenUsageEvent(tokenUsageStateBySession.value[sKey], frame),
      }
      return
    }

    if (etype === 'ThoughtDelta' && frame.text) {
      const deltaText = frame.text
      updateAssistantMessage(sKey, nodeId, effProvider, frame.runId, frame.requestId, msg => ({
        ...msg,
        thought: (msg.thought ?? '') + deltaText,
        parts: appendMessagePart(msg.parts, { type: 'thought', text: deltaText }),
        liveProgress: { type: 'thought' },
      }))
      return
    }

    if (etype === 'TextDelta' && frame.text) {
      const deltaText = frame.text
      if (frame.idle && frame.messageId) {
        const lastAssistant = [...(messagesBySession.value[sKey] ?? [])].reverse().find(msg => msg.role === 'assistant')
        if (lastAssistant?.id === frame.messageId || lastAssistant?.text.includes(deltaText)) return
        cachedHistoryKeys.delete(sKey)
        appendMessage(sKey, {
          id: frame.messageId, role: 'assistant', nodeId, provider: effProvider,
          text: deltaText, createdAt: Date.now(),
        })
        return
      }
      updateAssistantMessage(sKey, nodeId, effProvider, frame.runId, frame.requestId, msg => ({
        ...msg,
        text: msg.text + deltaText,
        parts: appendMessagePart(msg.parts, { type: 'text', text: deltaText }),
        liveProgress: { type: 'text' },
      }))
      return
    }

    if ((etype === 'ToolCall' || etype === 'ToolCallUpdate') && (frame.name || frame.callId)) {
      const callKey = frame.callId || `legacy-${frame.name || 'tool'}`
      updateAssistantMessage(sKey, nodeId, effProvider, frame.runId, frame.requestId, msg => {
        let nextMedia = msg.media
        if (frame.media?.length) {
          const existingUrls = new Set((msg.media ?? []).map(m => m.url))
          const added = frame.media.filter(m => m?.url && !existingUrls.has(m.url))
          if (added.length) nextMedia = [...(msg.media ?? []), ...added]
        }
        return {
          ...msg,
          toolCalls: mergeToolCallUpdate(msg.toolCalls, frame),
          parts: appendMessagePart(msg.parts, { type: 'tool', callId: callKey }),
          liveProgress: { type: 'tool', callId: callKey },
          ...(nextMedia ? { media: nextMedia } : {}),
        }
      })
      return
    }

    if (etype === 'FormRequest' && frame.formId) {
      const formCard: MessageFormRequest = {
        formId: frame.formId,
        nodeId,
        sessionId: sid ?? sessionsByKey.value[sKey]?.sessionId ?? '',
        provider: effProvider,
        title: frame.title || '需要补充确认信息',
        fields: Array.isArray(frame.fields) ? frame.fields : [],
        status: 'pending',
        createdAt: Date.now(),
      }
      pendingFormsById.value = { ...pendingFormsById.value, [formCard.formId]: formCard }
      updateAssistantMessage(sKey, nodeId, effProvider, frame.runId, frame.requestId, msg => {
        const prev = msg.forms ?? []
        const exists = prev.some(f => f.formId === formCard.formId)
        return {
          ...msg,
          forms: exists ? prev.map(f => (f.formId === formCard.formId ? formCard : f)) : [...prev, formCard],
        }
      })
      notifyBackgroundEvent('Studiolo 智能体提问', formCard.title, 'approval', false, sKey)
      return
    }

    if (etype === 'FormResolved' && frame.formId) {
      const nextStatus = frame.cancelled ? 'cancelled' : 'submitted'
      const cur = pendingFormsById.value[frame.formId]
      if (cur) {
        pendingFormsById.value = { ...pendingFormsById.value, [frame.formId]: { ...cur, status: nextStatus } }
      }
      const list = messagesBySession.value[sKey]
      if (list) {
        messagesBySession.value = {
          ...messagesBySession.value,
          [sKey]: list.map(m =>
            m.forms?.some(f => f.formId === frame.formId)
              ? { ...m, forms: m.forms.map(f => (f.formId === frame.formId ? { ...f, status: nextStatus } : f)) }
              : m,
          ),
        }
      }
      return
    }

    if (etype === 'WorktreeMerged') {
      const count = Array.isArray(frame.mergedFiles) ? frame.mergedFiles.length : 0
      const detail = count > 0 ? frame.mergedFiles!.join(', ') : (frame.message || '无待合并改动')
      appendMessage(sKey, {
        id: `sys-wt-${Date.now()}`,
        role: 'system',
        nodeId,
        provider: effProvider,
        text: count > 0 ? `Worktree 合并完成：已将 ${count} 个文件改动合回主工作区（${detail}）` : detail,
        createdAt: Date.now(),
      })
      requestSessionDiff(sKey)
      return
    }

    if (etype === 'GitCommitted') {
      appendMessage(sKey, {
        id: `sys-gc-${Date.now()}`,
        role: 'system',
        nodeId,
        provider: effProvider,
        text: `已创建 Git 提交 ${frame.commitHash || ''}：${frame.message || ''}`,
        createdAt: Date.now(),
      })
      requestSessionDiff(sKey)
      return
    }

    if (etype === 'TerminalPreview' && frame.port && frame.requestId) {
      const pending = terminalPreviews.value[sKey]?.[frame.port]
      if (pending?.requestId === frame.requestId) {
        const valid = frame.previewUrl && /^http:\/\/(?:\d{1,3}\.){3}\d{1,3}:\d+\/__studiolo_preview\/[\w-]+$/.test(frame.previewUrl)
        terminalPreviews.value[sKey][frame.port] = valid ? { requestId: frame.requestId, url: frame.previewUrl }
          : { requestId: frame.requestId, error: frame.error || '未收到有效的节点预览地址' }
      }
      return
    }

    if (etype === 'TerminalOpened' && frame.terminalId) {
      terminalBySession.value = {
        ...terminalBySession.value,
        [sKey]: {
          terminalId: frame.terminalId,
          sessionId: sid ?? '',
          cwd: frame.cwd || '',
          output: '',
          pty: Boolean(frame.pty),
          closed: false,
        },
      }
      return
    }

    if (etype === 'TerminalOutput' && frame.terminalId && typeof frame.data === 'string') {
      const cur = terminalBySession.value[sKey]
      if (cur && cur.terminalId === frame.terminalId) {
        const combined = `${cur.output}${frame.data}`
        terminalBySession.value = {
          ...terminalBySession.value,
          [sKey]: {
            ...cur,
            output: combined.length > 80000 ? combined.slice(combined.length - 80000) : combined,
          },
        }
      }
      return
    }

    if (etype === 'TerminalClosed' && frame.terminalId) {
      const cur = terminalBySession.value[sKey]
      if (cur && cur.terminalId === frame.terminalId) {
        terminalBySession.value = {
          ...terminalBySession.value,
          [sKey]: {
            ...cur,
            closed: true,
            exitCode: frame.exitCode,
          },
        }
      }
      return
    }

    if (etype === 'TodoUpdated' && Array.isArray(frame.items)) {
      todosBySession.value = { ...todosBySession.value, [sKey]: frame.items }
      if (sessionsByKey.value[sKey]) {
        sessionsByKey.value = {
          ...sessionsByKey.value,
          [sKey]: {
            ...sessionsByKey.value[sKey],
            todoCount: frame.items.filter(t => t.status !== 'completed' && t.status !== 'cancelled').length,
          },
        }
      }
      return
    }

    if (etype === 'CheckpointCreated' && frame.checkpointId) {
      const cpInfo: CheckpointInfo = {
        checkpointId: frame.checkpointId,
        sessionId: sid ?? sessionsByKey.value[sKey]?.sessionId ?? '',
        runId: frame.runId,
        requestId: frame.requestId,
        summary: frame.summary ?? { filesChanged: 0, additions: 0, deletions: 0 },
        createdAt: Date.now(),
      }
      checkpointsBySession.value = {
        ...checkpointsBySession.value,
        [sKey]: [...(checkpointsBySession.value[sKey] ?? []), cpInfo],
      }
      const list = [...(messagesBySession.value[sKey] ?? [])]
      const targetIdx = list.findIndex(
        m => m.role === 'assistant' && ((frame.runId && m.runId === frame.runId) || (frame.requestId && m.requestId === frame.requestId)),
      )
      const fallbackIdx = targetIdx >= 0 ? targetIdx : [...list].reverse().findIndex(m => m.role === 'assistant')
      const resolvedIdx = targetIdx >= 0 ? targetIdx : (fallbackIdx >= 0 ? list.length - 1 - fallbackIdx : -1)
      if (resolvedIdx >= 0) {
        list[resolvedIdx] = {
          ...list[resolvedIdx],
          checkpointId: frame.checkpointId,
          diffSummary: cpInfo.summary,
        }
        messagesBySession.value = { ...messagesBySession.value, [sKey]: list }
      }
      return
    }

    if (etype === 'DiffSnapshot') {
      const files = Array.isArray(frame.files)
        ? (frame.files.filter(x => typeof x === 'object' && x !== null) as DiffFileEntry[])
        : []
      const summary = frame.summary ?? {
        filesChanged: files.length,
        additions: files.reduce((acc, f) => acc + (f.additions || 0), 0),
        deletions: files.reduce((acc, f) => acc + (f.deletions || 0), 0),
      }
        diffBySession.value = {
        ...diffBySession.value,
        [sKey]: {
          files,
          summary,
          isGitRepo: frame.isGitRepo,
          branch: typeof frame.branch === 'string' ? frame.branch : diffBySession.value[sKey]?.branch,
          cwd: frame.cwd,
          perTurn: frame.perTurn,
          updatedAt: Date.now(),
        },
      }
      if (fileTextCacheBySession.value[sKey]) {
        const nextTexts = { ...fileTextCacheBySession.value }
        delete nextTexts[sKey]
        fileTextCacheBySession.value = nextTexts
      }
      if (sessionsByKey.value[sKey]) {
        sessionsByKey.value = {
          ...sessionsByKey.value,
          [sKey]: { ...sessionsByKey.value[sKey], hasDiff: files.length > 0 },
        }
      }
      return
    }

    if (etype === 'CheckpointReverted' && frame.checkpointId) {
      const list = checkpointsBySession.value[sKey] ?? []
      checkpointsBySession.value = {
        ...checkpointsBySession.value,
        [sKey]: list.map(c => (c.checkpointId === frame.checkpointId ? { ...c, reverted: true } : c)),
      }
      const restored = frame.restoredFiles?.length ? frame.restoredFiles.join(', ') : '工作区快照'
      appendMessage(sKey, {
        id: `sys-rev-${Date.now()}`,
        role: 'system',
        nodeId,
        provider: effProvider,
        text: `已回滚检查点 ${frame.checkpointId}：已恢复 ${restored}`,
        createdAt: Date.now(),
      })
      return
    }

    if (etype === 'SessionRenamed' && frame.title) {
      if (sessionsByKey.value[sKey]) {
        sessionsByKey.value = {
          ...sessionsByKey.value,
          [sKey]: { ...sessionsByKey.value[sKey], title: redactSessionTitleCredentials(frame.title) },
        }
      }
      return
    }

    if (etype === 'SessionDeleted') {
      forgetFollowIntent(sKey)
      clearSubscribe(sKey)
      clearHistory(sKey)
      clearTimeout(streamStateBySession.get(sKey)?.snapshotTimer)
      streamStateBySession.delete(sKey)
      streamIdBySession.delete(sKey)
      delete contextUsageBySession.value[sKey]
      delete contextReads.value[sKey]
      delete contextWaitingForModel.value[sKey]
      delete contextCompactions.value[sKey]
      const local = storage
      cachedHistoryKeys.delete(sKey)
      cachedHistoryTimes.delete(sKey)
      queuedHistoryWrites.delete(sKey)
      historyWrites = historyWrites.then(() => local?.remove('history', sKey)).catch(() => {})
      for (const item of outbox.value.filter(row => row.sessionKey === sKey)) void removeOutboxPrompt(item)
      const nextSessions = { ...sessionsByKey.value }
      delete nextSessions[sKey]
      sessionsByKey.value = nextSessions
      const nextMsgs = { ...messagesBySession.value }
      delete nextMsgs[sKey]
      messagesBySession.value = nextMsgs
      const nextTodos = { ...todosBySession.value }
      delete nextTodos[sKey]
      todosBySession.value = nextTodos
      const nextDiffs = { ...diffBySession.value }
      delete nextDiffs[sKey]
      diffBySession.value = nextDiffs
      const nextCps = { ...checkpointsBySession.value }
      delete nextCps[sKey]
      checkpointsBySession.value = nextCps
      const nextQueues = { ...queuedPromptsBySession.value }
      delete nextQueues[sKey]
      queuedPromptsBySession.value = nextQueues
      const nextRunning = { ...runningBySession.value }
      delete nextRunning[sKey]
      runningBySession.value = nextRunning
      const nextPreviews = { ...filePreviewBySession.value }
      delete nextPreviews[sKey]
      filePreviewBySession.value = nextPreviews
      const nextTextCache = { ...fileTextCacheBySession.value }
      delete nextTextCache[sKey]
      fileTextCacheBySession.value = nextTextCache
      const nextTerms = { ...terminalBySession.value }
      delete nextTerms[sKey]
      terminalBySession.value = nextTerms
      const nextBm = { ...bookmarkedIdsBySession.value }
      delete nextBm[sKey]
      bookmarkedIdsBySession.value = nextBm
      if (activeSessionKey.value === sKey) {
        const sibling = Object.keys(nextSessions).find(k => nextSessions[k].nodeId === nodeId)
        activeSessionKey.value = sibling ?? Object.keys(nextSessions)[0] ?? ''
      }
      return
    }

    if (etype === 'ContextSnapshot' || etype === 'ContextUsage') {
      const snapshot = etype === 'ContextSnapshot'
      if (snapshot && (!frame.requestId || contextReads.value[sKey] !== frame.requestId)) return
      if (!snapshot && !frame.contextUsage) return
      const contextWait = contextWaitingForModel.value[sKey]
      if (contextWait && (snapshot || !contextWait.runId || frame.runId !== contextWait.runId)) return
      delete contextReads.value[sKey]
      const usage = frame.contextUsage
      if (usage && Number.isFinite(usage.usedTokens) && usage.usedTokens >= 0) {
        delete contextWaitingForModel.value[sKey]
        contextUsageBySession.value[sKey] = usage
      }
      return
    }

    if (etype === 'SessionCompacted') {
      if (frame.requestId === contextCompactions.value[sKey]) delete contextCompactions.value[sKey]
      if (frame.compactionPending || frame.systemEvent?.kind === 'compacted') {
        delete contextUsageBySession.value[sKey]
        delete contextReads.value[sKey]
        if (frame.systemEvent) requestContextUsage(sKey)
      }
      if (frame.systemEvent) {
        appendSystemEvent(sKey, nodeId, effProvider, frame.messageId ?? `sys-${frame.systemEvent.kind}-${frame.systemEvent.at}`, frame.systemEvent)
        return
      }
      appendMessage(sKey, {
        id: `sys-cmp-${Date.now()}`,
        role: 'system',
        nodeId,
        provider: effProvider,
        text: frame.supported
          ? (frame.message || '已触发上游代理压缩会话历史上下文。')
          : (frame.message || '当前适配器暂不支持服务端上下文压缩。'),
        createdAt: Date.now(),
      })
      return
    }

    if (etype === 'PermissionRequest' && frame.callId) {
      const wasPending = pendingApprovalsByCall.value[frame.callId]?.decision === 'pending'
      const card: PermissionRequestCard = {
        callId: frame.callId,
        nodeId,
        sessionId: sid ?? sessionsByKey.value[sKey]?.sessionId ?? '',
        provider: effProvider,
        title: frame.title || '需要节点执行确认',
        command: frame.command || '',
        risk: frame.risk || 'medium',
        decision: 'pending',
        createdAt: Date.now(),
      }
      pendingApprovalsByCall.value = { ...pendingApprovalsByCall.value, [card.callId]: card }
      updateAssistantMessage(sKey, nodeId, effProvider, frame.runId, frame.requestId, msg => ({
        ...msg,
        approvals: [...(msg.approvals ?? []).filter(approval => approval.callId !== card.callId), card],
      }))
      if (!wasPending) notifyBackgroundEvent('Studiolo 待执行审批', '有待审批请求', 'approval', true, sKey)
      return
    }

    if (etype === 'ArtifactOffered' && frame.artifact) {
      const artifact = frame.artifact
      updateAssistantMessage(sKey, nodeId, effProvider, frame.runId, frame.requestId, msg => ({
        ...msg,
        artifacts: [...(msg.artifacts ?? []), artifact],
      }))
      if (artifact.mime?.startsWith('image/')) {
        void ensureArtifactImagePreview(artifact)
      }
      return
    }

    if (etype === 'Completed') {
      const active = runningBySession.value[sKey]
      const knownRequest = frame.requestId && pendingRunPrompts.has(`${sKey}::${frame.requestId}`)
      if (active && frame.runId && active !== frame.runId && !knownRequest) return
      if (stopStatusBySession.value[sKey]?.requestId) {
        stopStatusBySession.value[sKey] = { state: 'unknown', message: '本轮已结束，代理未确认是否由停止请求触发' }
      }
      const promptMeta =
        (frame.runId ? pendingRunPrompts.get(`${sKey}::${frame.runId}`) : undefined) ??
        (frame.requestId ? pendingRunPrompts.get(`${sKey}::${frame.requestId}`) : undefined)
      const durationMs = promptMeta?.startedAt ? Math.max(0, Date.now() - promptMeta.startedAt) : undefined
      const modelIdEff = promptMeta?.model ?? sessionsByKey.value[sKey]?.currentModel ?? runSettings.value[sKey]?.model
      const modelLabel = modelIdEff
        ? (catalogs.value[`${nodeId}::${effProvider}`]?.models.find(m => m.id === modelIdEff)?.label || modelIdEff)
        : undefined
      updateAssistantMessage(sKey, nodeId, effProvider, frame.runId, frame.requestId, msg => ({
        ...msg,
        streaming: false,
        liveProgress: undefined,
        toolCalls: msg.toolCalls?.map(tool => tool.status === 'running' ? { ...tool, status: 'error', error: '本轮已结束，工具未返回最终状态' } : tool),
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(modelLabel ? { modelLabel } : {}),
      }))
      if (frame.usage && typeof frame.usage === 'object') {
        const usage = { ...(frame.usage as TokenUsageInput), runId: frame.runId, requestId: frame.requestId }
        recordedUsage.record(sKey, usage, frame.seq)
        tokenUsageStateBySession.value = {
          ...tokenUsageStateBySession.value,
          [sKey]: applyTokenUsageEvent(tokenUsageStateBySession.value[sKey], usage),
        }
      } else if (!hasRecordedTurnUsage(tokenUsageStateBySession.value[sKey], [frame.runId, frame.requestId])) {
        const list = messagesBySession.value[sKey] ?? []
        const targetMsg = [...list].reverse().find(m =>
          m.role === 'assistant'
          && ((frame.runId && m.runId === frame.runId) || (frame.requestId && m.requestId === frame.requestId) || !m.streaming),
        )
        const promptText = promptMeta?.text ?? ''
        const replyText = targetMsg?.text ?? ''
        const thoughtText = targetMsg?.thought ?? ''
        if (promptText || replyText || thoughtText) {
          tokenUsageStateBySession.value = {
            ...tokenUsageStateBySession.value,
            [sKey]: applyTokenUsageEvent(
              tokenUsageStateBySession.value[sKey],
              estimateTurnUsageFallback(promptText, thoughtText, replyText, {
                model: promptMeta?.model || runSettings.value[sKey]?.model,
                runId: frame.runId,
                requestId: frame.requestId,
              }),
            ),
          }
        }
      }
      const turnSummary = toSessionTokenSummary(tokenUsageStateBySession.value[sKey])
      if (turnSummary?.lastTurnTokens) {
        updateAssistantMessage(sKey, nodeId, effProvider, frame.runId, frame.requestId, msg => ({
          ...msg,
          turnTokens: turnSummary.lastTurnTokens,
          turnOutputTokens: turnSummary.lastOutputTokens,
        }))
      }
      if (frame.runId) pendingRunPrompts.delete(`${sKey}::${frame.runId}`)
      if (frame.requestId) pendingRunPrompts.delete(`${sKey}::${frame.requestId}`)
      if (frame.runId || frame.requestId) deliveredOutbox.delete((frame.runId || frame.requestId)!)
      const copy = { ...runningBySession.value }
      delete copy[sKey]
      runningBySession.value = copy
      const contextWait = contextWaitingForModel.value[sKey]
      if (contextWait?.runId && contextWait.runId === (frame.runId || frame.requestId)) {
        delete contextWaitingForModel.value[sKey]
      }
      if (effProvider === 'hermes' || !contextUsageBySession.value[sKey]?.capacityTokens) requestContextUsage(sKey)
      dismissSessionApprovals(sKey)
      steerSessionKeys.delete(sKey)
      if (sKey !== activeSessionKey.value || !sessionViewVisible) {
        unreadCountBySession.value = {
          ...unreadCountBySession.value,
          [sKey]: (unreadCountBySession.value[sKey] ?? 0) + 1,
        }
        if (!firstUnreadMsgIdBySession.value[sKey]) {
          const listNow = messagesBySession.value[sKey] ?? []
          const lastAssistant = [...listNow].reverse().find(m => m.role === 'assistant')
          if (lastAssistant) {
            firstUnreadMsgIdBySession.value = { ...firstUnreadMsgIdBySession.value, [sKey]: lastAssistant.id }
          }
        }
      }
      notifyBackgroundEvent(
        'Studiolo 任务已完成',
        sessionsByKey.value[sKey]?.title || '代理回复已就绪',
        'complete',
        false,
        sKey,
      )
      const pendingSteer = [...pendingSteers.values()].find(steer => steer.sessionKey === sKey)
      if (pendingSteer) {
        // 先让队列按钮处理插话结果，再唤醒下一条消息，避免自动重发同一条。
        const route = fleetRoute.value
        void pendingSteer.result.then(accepted => {
          if (accepted) {
            setTimeout(() => {
              if (fleetRoute.value === route && wsState.value === 'online') void drainNextQueuedPrompt(sKey)
            }, 0)
          }
        })
      } else {
        void drainNextQueuedPrompt(sKey)
      }
      void flushOutbox()
      return
    }

    if (etype === 'Failed' || etype === 'NodeUnavailable' || etype === 'Error') {
      const errText = frame.message || frame.code || '执行失败'
      if (frame.requestId && pendingDownloadRequests.has(frame.requestId)) {
        pendingDownloadRequests.delete(frame.requestId)
        silentFileReadRequests.delete(frame.requestId)
        lastError.value = `无法下载文件：${errText}`
        return
      }
      if (frame.requestId && silentFileReadRequests.has(frame.requestId)) {
        silentFileReadRequests.delete(frame.requestId)
        return
      }
      if (frame.requestId) updatePromptDelivery(sKey, frame.requestId, 'failed')
      const isActiveRunError = Boolean(
        (frame.runId && frame.runId === runningBySession.value[sKey]) ||
        (frame.runId && pendingRunPrompts.has(`${sKey}::${frame.runId}`)) ||
        (frame.requestId && pendingRunPrompts.has(`${sKey}::${frame.requestId}`)),
      )
      if (!isActiveRunError) {
        const curPreview = filePreviewBySession.value[sKey]
        if (curPreview?.loading) {
          filePreviewBySession.value = {
            ...filePreviewBySession.value,
            [sKey]: { ...curPreview, loading: false, error: errText },
          }
          return
        }
        if (frame.code === 'path_forbidden') {
          return
        }
        lastError.value = errText
        return
      }
      lastError.value = errText
      const deliveryId = frame.runId || frame.requestId
      if (deliveryId && contextWaitingForModel.value[sKey]?.runId === deliveryId) {
        contextWaitingForModel.value[sKey] = {}
      }
      const failedPrompt = (frame.runId ? pendingRunPrompts.get(`${sKey}::${frame.runId}`) : undefined)
        ?? (frame.requestId ? pendingRunPrompts.get(`${sKey}::${frame.requestId}`) : undefined)
      if (deliveryId) {
        const delivered = deliveredOutbox.get(deliveryId)
        deliveredOutbox.delete(deliveryId)
        if (delivered && frame.code !== 'cancelled') restoreOutboxDraft(delivered)
      }
      updateAssistantMessage(sKey, nodeId, effProvider, frame.runId, frame.requestId, msg => ({
        ...msg,
        streaming: false,
        liveProgress: undefined,
        ...(failedPrompt?.startedAt ? { durationMs: Math.max(0, Date.now() - failedPrompt.startedAt) } : {}),
        ...(frame.code === 'cancelled' || frame.code === 'stream_closed' ? { interrupted: true } : {}),
        toolCalls: msg.toolCalls?.map(tool => tool.status === 'running' ? { ...tool, status: 'error', error: errText } : tool),
        error: errText,
      }))
      if (frame.runId) pendingRunPrompts.delete(`${sKey}::${frame.runId}`)
      if (frame.requestId) pendingRunPrompts.delete(`${sKey}::${frame.requestId}`)
      const copy = { ...runningBySession.value }
      delete copy[sKey]
      runningBySession.value = copy
      dismissSessionApprovals(sKey)
      if (frame.code === 'cancelled' || frame.code === 'stream_closed') {
        interruptedBySession.value = { ...interruptedBySession.value, [sKey]: true }
      }
      if (frame.code === 'cancelled') {
        stopStatusBySession.value[sKey] = { state: 'reusable', message: '已停止，可以继续当前会话' }
      } else if (stopStatusBySession.value[sKey]?.requestId) {
        stopStatusBySession.value[sKey] = { state: 'unknown', message: '代理未确认会话能否继续' }
      }
      notifyBackgroundEvent('Studiolo 任务异常', errText, 'approval', false, sKey)
      if (steerSessionKeys.has(sKey)) {
        steerSessionKeys.delete(sKey)
        void drainNextQueuedPrompt(sKey)
      }
    }
  }

  // ---------------- 会话控制动作 ----------------
  function selectNode(nodeId: string) {
    lastError.value = null
    selectedNodeId.value = nodeId
    const found = nodes.value.find(n => n.id === nodeId)
    if (found) syncProviderForNode(found)
    const firstSess = Object.entries(sessionsByKey.value).find(([, s]) => s.nodeId === nodeId)?.[0]
    activeSessionKey.value = firstSess ?? ''
    if (firstSess && sessionsByKey.value[firstSess]) {
      const s = sessionsByKey.value[firstSess]
      applyDefaultModelPref(firstSess, s.nodeId, s.provider)
    } else if (found) {
      applyDefaultModelPref(`${found.id}::${selectedProvider.value}`, found.id, selectedProvider.value)
    }
  }

  function selectProvider(provider: AdapterProvider) {
    lastError.value = null
    selectedProvider.value = provider
    const nid = selectedNode.value?.id
    if (!nid) return
    const match = Object.entries(sessionsByKey.value).find(
      ([, s]) => s.nodeId === nid && s.provider === provider,
    )?.[0]
    activeSessionKey.value = match ?? ''
    if (match) applyDefaultModelPref(match, nid, provider)
    else applyDefaultModelPref(`${nid}::${provider}`, nid, provider)
  }

  function applyDefaultModelPref(settingKey: string, nodeId: string, provider: AdapterProvider) {
    if (!settingKey || !nodeId) return
    const existing = runSettings.value[settingKey]
    if (existing && existing.model !== undefined) return
    const saved = resolveSavedModelPref(nodeId, provider)
    if (!saved?.model) return
    const cat = catalogs.value[`${nodeId}::${provider}`]
    if (cat?.models?.length) {
      const matched = cat.models.find(m => m.id === saved.model && !m.unavailable)
      if (!matched) return
    }
    runSettings.value = {
      ...runSettings.value,
      [settingKey]: {
        ...(existing ?? {}),
        model: saved.model,
        ...(saved.effort ? { effort: saved.effort } : {}),
      },
    }
  }

  function sessionPromptOptions(key: string) {
    const options = runSettings.value[key]
    const session = sessionsByKey.value[key]
    if (!session || !options) return options
    const node = nodes.value.find(node => node.id === session.nodeId)
    const adapter = node?.adapters.find(adapter => adapter.provider === session.provider)
    return {
      ...options,
      ...(session.currentModel !== undefined ? { model: undefined } : {}),
      ...(session.currentEffort !== undefined && adapter?.capabilities.includes('session-effort') ? { effort: undefined } : {}),
    }
  }

  function setModelPreference(
    nodeId: string | undefined,
    provider: AdapterProvider,
    model: string,
    effort?: string,
    settingKey?: string,
  ) {
    saveAgentModelPref({ nodeId, provider, model, effort })
    const cleanModel = model.trim()
    const targetDraftKey = nodeId ? `${nodeId}::${provider}` : ''
    const keysToUpdate = Array.from(new Set([settingKey, targetDraftKey].filter((k): k is string => Boolean(k))))
    if (!keysToUpdate.length) return
    const next = { ...runSettings.value }
    for (const k of keysToUpdate) {
      if (sessionsByKey.value[k] && sessionsByKey.value[k].currentModel === undefined
        && (next[k]?.model ?? '') !== cleanModel) {
        delete contextUsageBySession.value[k]
        delete contextReads.value[k]
        contextWaitingForModel.value[k] = {}
      }
      next[k] = {
        ...(next[k] ?? {}),
        model: cleanModel,
        effort: cleanModel && effort ? effort : undefined,
      }
    }
    runSettings.value = next
  }

  function writeSessionSetting(
    key: string, field: 'currentModel' | 'currentEffort', command: Record<string, unknown>,
  ): Promise<string | null> {
    const session = sessionsByKey.value[key]
    if (!session) throw new Error('目标会话不存在')
    if ([...pendingSessionWrites.values()].some(write => write.key === key)) {
      throw new Error('正在等待节点确认会话设置，请稍候')
    }
    const { nodeId, provider, sessionId } = session
    const requestId = createRequestId()
    return new Promise((resolve, reject) => {
      const finish = (result: string | null | Error) => {
        clearTimeout(timer)
        pendingSessionWrites.delete(requestId)
        if (result instanceof Error) reject(result)
        else resolve(result)
      }
      const timeoutText = field === 'currentModel' ? '等待节点确认模型超时' : '等待节点确认思考强度超时'
      const timer = setTimeout(() => finish(new Error(timeoutText)), 120_000)
      pendingSessionWrites.set(requestId, { key, field, finish })
      if (!sendWsCommand({ ...command, nodeId, provider, sessionId, requestId }, false)) {
        finish(new Error('无法连接 Agent Node'))
      }
    })
  }

  async function setSessionModel(key: string, modelId: string): Promise<string> {
    const result = await writeSessionSetting(key, 'currentModel', { type: 'session.model.set', modelId })
    if (result === null) throw new Error('节点未确认当前模型')
    return result
  }

  async function setSessionEffort(key: string, modelId: string, effort: string): Promise<void> {
    if (pendingSessionEffort[key]) return
    const session = sessionsByKey.value[key]
    if (!session) throw new Error('目标会话不存在')
    pendingSessionEffort[key] = effort || 'default'
    try {
      if (session.currentModel !== modelId) modelId = await setSessionModel(key, modelId)
      const confirmed = await writeSessionSetting(key, 'currentEffort', {
        type: 'session.effort.set', effort: pendingSessionEffort[key],
      })
      setModelPreference(session.nodeId, session.provider, modelId, confirmed ?? undefined, key)
    } finally {
      delete pendingSessionEffort[key]
    }
  }

  function requestSessionsList(nodeId?: string, provider?: AdapterProvider) {
    const nid = nodeId ?? selectedNode.value?.id
    const prov = provider ?? selectedProvider.value
    if (!nid) return false
    const target = `${nid}::${prov}`
    if (sessionListStates.value[target]?.loading) return true
    const requestId = createRequestId()
    const sent = sendWsCommand({
      type: 'sessions.list',
      nodeId: nid,
      provider: prov,
      requestId,
      ...(prov === 'hermes' ? { limit: 100 } : {}),
    }, false)
    if (sent) pendingSessionLists.set(requestId, target)
    sessionListStates.value[target] = sent ? { loading: true } : { error: '节点连接尚未就绪' }
    if (sent) setTimeout(() => {
      if (pendingSessionLists.delete(requestId)) sessionListStates.value[target] = { error: '读取会话列表超时' }
    }, 65_000)
    return sent
  }

  /**
   * 为新开会话解析应继承的模型与思考强度：
   * 优先级：显式指定 > 指定源会话/当前活跃同引擎会话 > 目标节点内存偏好 > 持久化偏好。
   */
  function resolveInheritedRunOptions(
    nodeId: string,
    provider: AdapterProvider,
    sourceSessionKey?: string,
  ): RunOptions | undefined {
    const candidateKeys: string[] = []
    const srcKey = sourceSessionKey || activeSessionKey.value
    if (srcKey) {
      const srcSess = sessionsByKey.value[srcKey]
      if (srcSess && srcSess.provider === provider) {
        candidateKeys.push(srcKey)
      }
    }
    candidateKeys.push(`${nodeId}::${provider}`)

    const cat = catalogs.value[`${nodeId}::${provider}`]
    const isAvailableModel = (modelId: string) => {
      if (!cat?.models?.length) return true
      return Boolean(cat.models.find(m => m.id === modelId && !m.unavailable))
    }

    for (const key of candidateKeys) {
      const cfg = runSettings.value[key]
      if (cfg && cfg.model && isAvailableModel(cfg.model)) {
        return {
          model: cfg.model,
          ...(cfg.effort ? { effort: cfg.effort } : {}),
        }
      }
    }

    const saved = resolveSavedModelPref(nodeId, provider)
    if (saved?.model && isAvailableModel(saved.model)) {
      return {
        model: saved.model,
        ...(saved.effort ? { effort: saved.effort } : {}),
      }
    }
    return undefined
  }

  function isCwdWithinNodeRoots(node: AgentNode | undefined, candidateCwd?: string): boolean {
    if (!candidateCwd || !node?.allowedRoots?.length) return false
    const normCand = candidateCwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    return node.allowedRoots.some(r => {
      const normRoot = r.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
      return Boolean(normRoot) && (normCand === normRoot || normCand.startsWith(`${normRoot}/`))
    })
  }

  function openSession(options: {
    nodeId?: string
    provider?: AdapterProvider
    cwd?: string
    sessionId?: string
    requestId?: string
    onOpened?: (key: string) => void
    useWorktree?: boolean
    inheritFromKey?: string
    runOptions?: RunOptions
  } = {}) {
    const nid = options.nodeId ?? selectedNode.value?.id
    if (!nid) throw new Error('请先选择控制节点')
    const node = nodes.value.find(n => n.id === nid)
    const prov = options.provider ?? selectedProvider.value
    const cwd =
      options.cwd && (!node?.allowedRoots?.length || isCwdWithinNodeRoots(node, options.cwd))
        ? options.cwd
        : (node?.allowedRoots?.[0] ?? options.cwd ?? '')
    const requestId = options.requestId ?? createRequestId()
    const inheritedOptions = options.runOptions ?? resolveInheritedRunOptions(nid, prov, options.inheritFromKey)
    if (!pendingOpenQueue.some(p => p.requestId === requestId)) {
      pendingOpenQueue.push({
        nodeId: nid,
        provider: prov,
        requestId,
        onOpened: options.onOpened,
        ...(inheritedOptions ? { options: inheritedOptions } : {}),
      })
    }
    const sent = sendWsCommand({
      type: 'session.open',
      nodeId: nid,
      provider: prov,
      ...(cwd ? { cwd } : {}),
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      useWorktree: Boolean(options.useWorktree),
      requestId,
    })
    if (!sent) {
      const i = pendingOpenQueue.findIndex(p => p.requestId === requestId)
      if (i >= 0) pendingOpenQueue.splice(i, 1)
      throw new Error(lastError.value || '节点连接不可用')
    }
  }

  function activateSession(sKey: string) {
    lastError.value = null
    activeSessionKey.value = sKey
    const sess = sessionsByKey.value[sKey]
    if (unreadCountBySession.value[sKey]) {
      const nextUnread = { ...unreadCountBySession.value }
      delete nextUnread[sKey]
      unreadCountBySession.value = nextUnread
    }
    if (sess) {
      selectedNodeId.value = sess.nodeId
      selectedProvider.value = sess.provider
      applyDefaultModelPref(sKey, sess.nodeId, sess.provider)
      loadSessionHistory(sKey, cachedHistoryKeys.has(sKey))
      subscribeSession(sKey)
      if (!diffBySession.value[sKey]) {
        requestSessionDiff(sKey)
      }
    }
  }

  function markSessionRead(sKey: string) {
    if (!sKey) return
    if (unreadCountBySession.value[sKey]) {
      const next = { ...unreadCountBySession.value }
      delete next[sKey]
      unreadCountBySession.value = next
    }
    if (firstUnreadMsgIdBySession.value[sKey]) {
      const nextIds = { ...firstUnreadMsgIdBySession.value }
      delete nextIds[sKey]
      firstUnreadMsgIdBySession.value = nextIds
    }
  }

  function setSessionViewVisible(visible: boolean) {
    sessionViewVisible = visible
  }

  function subscribeSession(sKey: string) {
    const sess = sessionsByKey.value[sKey]
    if (!sess || wsState.value !== 'online') return false
    const state = streamState(sKey)
    if (pendingStreamResync.has(sKey) || state.timer || state.snapshot) return true
    state.retries = 0
    return sendSubscribe(sKey)
  }

  function retrySubscribe(sKey: string) {
    const state = streamState(sKey)
    clearSubscribe(sKey)
    if (state.retries >= SUBSCRIBE_RETRY_DELAYS_MS.length) {
      requestSnapshotHistory(sKey)
      return
    }
    const delay = SUBSCRIBE_RETRY_DELAYS_MS[state.retries++]
    state.phase = 'gap'
    state.timer = setTimeout(() => {
      state.timer = undefined
      sendSubscribe(sKey)
    }, delay)
  }

  function sendSubscribe(sKey: string) {
    const sess = sessionsByKey.value[sKey]
    if (!sess || wsState.value !== 'online') {
      failRecovery(sKey, '会话连接不可用，请重试')
      return false
    }
    if (syncMode === 'epoch') return openEpochSession(sess, sKey)
    const state = streamState(sKey)
    const streamId = streamIdBySession.get(sKey)
    const lastSeq = streamId ? state.cursors.get(streamId) ?? 0 : lastSeqBySession.value[sKey] ?? 0
    const requestId = createRequestId()
    const sent = sendWsCommand({
      type: 'session.subscribe',
      nodeId: sess.nodeId,
      provider: sess.provider,
      sessionId: sess.sessionId,
      lastSeq, afterSequence: lastSeq,
      streamId,
      requestId,
    })
    if (sent) {
      state.phase = 'gap'
      pendingStreamResync.set(sKey, requestId)
      state.timer = setTimeout(() => {
        if (pendingStreamResync.get(sKey) === requestId) retrySubscribe(sKey)
      }, SUBSCRIBE_TIMEOUT_MS)
    } else failRecovery(sKey, '无法订阅会话，请重试')
    return sent
  }

  function openEpochSession(sess: ChatSession, sKey: string) {
    const route = fleetRoute.value
    if (!route) {
      failRecovery(sKey, '会话连接不可用，请重试')
      return false
    }
    let downgraded = legacySnapshotSessions.get(route)
    if (!downgraded) legacySnapshotSessions.set(route, downgraded = new Set())
    if (downgraded.has(sKey)) {
      requestSnapshotHistory(sKey)
      return true
    }

    const state = streamState(sKey)
    const tail = state.buffer.at(-1)
    const streamId = tail?.streamId ?? streamIdBySession.get(sKey)
    const lastSeq = Math.max(state.cursors.get(streamId ?? '') ?? 0,
      ...state.buffer.filter(frame => frame.streamId === streamId).map(frame => frame.sequence ?? 0))
    const requestId = createRequestId()
    state.phase = 'gap'
    pendingStreamResync.set(sKey, requestId)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 50_000)

    const sessionSync = createSessionSync({
      mode: syncMode,
      rpc: () => apiRequest<unknown>(
        `/api/v1/fleet/nodes/${encodeURIComponent(sess.nodeId)}/session/snapshot`,
        { method: 'POST', body: JSON.stringify({ sessionId: sess.sessionId, provider: sess.provider }), signal: controller.signal },
        route.token, route.origin,
      ),
      apply: (_, value) => {
        if (fleetRoute.value !== route || pendingStreamResync.get(sKey) !== requestId) return
        const snapshot = value as {
          messages: Array<NonNullable<FleetWsEvent['messages']>[number] & { turnId?: string }>
          turns?: Array<{ turnId: string; startedAt?: number }>
          lastSeq?: number
          running?: boolean
          runId?: string
        }
        // The event-log cursor and live stream cursor count different frames.
        if (state.buffer.at(-1) !== tail || !Array.isArray(snapshot.messages) || snapshot.lastSeq === 0) {
          throw new Error('Epoch snapshot cannot cover the current live stream')
        }
        const startedAt = new Map(snapshot.turns?.map(turn => [turn.turnId, turn.startedAt]))
        const messages = snapshot.messages.map(message => ({
          ...message,
          runId: message.turnId ?? message.runId,
          createdAt: message.createdAt ?? startedAt.get(message.turnId ?? ''),
        }))
        clearHistory(sKey)
        pendingHistoryPages.value[sKey] = requestId
        forcedHistoryRequests.add(requestId)
        state.snapshot = { streamId, lastSeq, requestId }
        const intent = snapshotFollowIntent.get(sKey)
        if (intent && !intent.settled) intent.requestId = requestId
        reconcileRuntime(sKey, { type: 'SessionHistory', active: snapshot.running, runId: snapshot.runId })
        applyWsEvent({ type: 'SessionHistory', ...sess, requestId, messages })
        clearSubscribe(sKey)
        void flushOutbox()
      },
      append: () => { throw new Error('Fleet currently opens epoch snapshots through the subscription seam') },
    })
    void sessionSync.open(sKey).catch(() => {
      if (fleetRoute.value !== route || pendingStreamResync.get(sKey) !== requestId) return
      // A v1 connection can still request legacy history for an individual session.
      downgraded.add(sKey)
      state.snapshot = undefined
      requestSnapshotHistory(sKey)
    }).finally(() => clearTimeout(timeout))
    return true
  }

  function requestContextUsage(sKey: string) {
    const sess = sessionsByKey.value[sKey]
    if (!sess || wsState.value !== 'online' || contextReads.value[sKey] || contextWaitingForModel.value[sKey]) return false
    const node = nodes.value.find(row => row.id === sess.nodeId)
    if (node?.status !== 'online' || !node.adapters.find(adapter =>
      adapter.provider === sess.provider && adapter.capabilities.includes('context-usage'),
    )) return false
    const requestId = createRequestId()
    const sent = sendWsCommand({
      type: 'session.context.read', nodeId: sess.nodeId, provider: sess.provider, sessionId: sess.sessionId, requestId,
    }, false)
    if (sent) {
      contextReads.value[sKey] = requestId
      setTimeout(() => {
        if (contextReads.value[sKey] === requestId) delete contextReads.value[sKey]
      }, 12_000)
    }
    return sent
  }

  function loadSessionHistory(sKey: string, force = false) {
    const sess = sessionsByKey.value[sKey]
    if (wsState.value === 'online' && sess && !pendingHistoryPages.value[sKey] && (force || !messagesBySession.value[sKey]?.length)) {
      const limit = historyLimitBySession.value[sKey] ?? 60
      historyLimitBySession.value = { ...historyLimitBySession.value, [sKey]: limit }
      const requestId = createRequestId()
      const sent = sendWsCommand({
        type: 'session.history',
        nodeId: sess.nodeId,
        provider: sess.provider,
        sessionId: sess.sessionId,
        limit,
        pagination: true,
        requestId,
      })
      if (sent) {
        trackHistory(sKey, requestId)
        if (force) forcedHistoryRequests.add(requestId)
        return requestId
      }
    }
  }

  function requestOlderHistory(sKey: string) {
    const sess = sessionsByKey.value[sKey]
    if (!sess || pendingHistoryPages.value[sKey] || historyCursorBySession.value[sKey] === null) return false
    const beforeCursor = historyCursorBySession.value[sKey]
    const curLimit = historyLimitBySession.value[sKey] ?? Math.max(60, messagesBySession.value[sKey]?.length ?? 60)
    const nextLimit = Math.min(MAX_MESSAGES_PER_SESSION, curLimit + 60)
    const requestId = createRequestId()
    const sent = sendWsCommand({
      type: 'session.history',
      nodeId: sess.nodeId,
      provider: sess.provider,
      sessionId: sess.sessionId,
      limit: beforeCursor ? 60 : nextLimit,
      pagination: true,
      ...(beforeCursor ? { beforeCursor } : {}),
      requestId,
    })
    if (sent) {
      historyLimitBySession.value[sKey] = nextLimit
      trackHistory(sKey, requestId)
    }
    return sent
  }

  function searchOlderHistory(sKey: string) {
    if (wsState.value !== 'online' || pendingHistoryPages.value[sKey]) return
    historyLimitBySession.value[sKey] = MAX_MESSAGES_PER_SESSION
    loadSessionHistory(sKey, true)
  }

  async function sendPromptToSession(
    sKey: string,
    text: string,
    attachments: ArtifactRef[] = [],
    options?: RunOptions,
    appendUser = true,
    queued?: FleetOutboxItem,
  ) {
    const sess = sessionsByKey.value[sKey]
    if (!sess) throw new Error('目标会话不存在')
    const reqId = queued?.id ?? createRequestId()
    const seed = queued ? undefined : forkSeedBySession.value[sKey]
    const wireText = queued?.wireText ?? preparePromptText(text, seed)

    if (interruptedBySession.value[sKey]) {
      const nextInt = { ...interruptedBySession.value }
      delete nextInt[sKey]
      interruptedBySession.value = nextInt
    }
    lastError.value = null
    markSessionRead(sKey)

    const sent = sendWsCommand({
      type: 'prompt.send',
      options,
      nodeId: sess.nodeId,
      provider: sess.provider,
      sessionId: sess.sessionId,
      text: wireText,
      attachments: attachments.length ? attachments : undefined,
      requestId: reqId,
      commandId: reqId,
    }, !queued)
    if (!sent) throw new Error(lastError.value || '节点连接不可用')
    if (seed && forkSeedBySession.value[sKey] === seed) delete forkSeedBySession.value[sKey]
    pendingRunPrompts.set(`${sKey}::${reqId}`, { text: wireText, model: options?.model, startedAt: Date.now() })

    // 首句发出瞬间乐观命名默认标题，并通知上游代理同步持久化，避免新标签长时间显示原始 sessionId
    if (appendUser && isGenericSessionTitle(sess.title)) {
      const optimisticTitle = deriveOptimisticSessionTitle(text)
      if (optimisticTitle) {
        sessionsByKey.value = {
          ...sessionsByKey.value,
          [sKey]: { ...sess, title: optimisticTitle },
        }
        sendWsCommand({
          type: 'session.rename',
          nodeId: sess.nodeId,
          provider: sess.provider,
          sessionId: sess.sessionId,
          title: optimisticTitle,
          requestId: createRequestId(),
        })
      }
    }

    if (appendUser && !messagesBySession.value[sKey]?.some(row => row.id === `user-${reqId}`)) {
      appendMessage(sKey, {
        id: `user-${reqId}`,
        role: 'user',
        requestId: reqId,
        nodeId: sess.nodeId,
        provider: sess.provider,
        text,
        delivery: 'sending',
        artifacts: attachments.length ? attachments : undefined,
        createdAt: Date.now(),
      })
    }
  }

  function preparePromptText(text: string, seed?: string) {
    return seed ? `${seed}\n\n---\n${text}` : text
  }

  function restoreOutboxDraft(item: FleetOutboxItem) {
    const draft = composerDrafts.value[item.sessionKey] ?? { text: '', files: [] }
    draft.text = [item.text === '[发送了加密文件附件]' ? '' : item.text, draft.text].filter(Boolean).join('\n\n')
    draft.files = [...item.files, ...draft.files]
    composerDrafts.value[item.sessionKey] = draft
  }

  async function removeOutboxPrompt(item: FleetOutboxItem) {
    const local = storage
    transmittingOutbox.delete(item.id)
    outbox.value = outbox.value.filter(row => row.id !== item.id)
    try { await local?.remove('outbox', item.id) }
    catch { if (local === storage) lastError.value = '无法更新本机待发队列' }
  }

  function isOutboxTransmitting(id: string) {
    return transmittingOutbox.has(id)
  }

  function cancelDeferredPrompt(id: string) {
    const item = outbox.value.find(row => row.id === id)
    if (!item || transmittingOutbox.has(id)) return false
    restoreOutboxDraft(item)
    void removeOutboxPrompt(item).then(flushOutbox)
    return true
  }

  function appendSteerUserMessage(item: FleetOutboxItem) {
    const sKey = item.sessionKey
    const id = `user-${item.id}`
    if (messagesBySession.value[sKey]?.some(row => row.id === id)) return
    appendMessage(sKey, {
      id,
      role: 'user',
      nodeId: item.session.nodeId,
      provider: item.session.provider,
      text: item.text,
      createdAt: item.createdAt,
    })
  }

  async function flushOutbox() {
    const route = fleetRoute.value
    if (!route || wsState.value !== 'online') return
    const busySessions = new Set<string>()
    for (const item of outbox.value) {
      const session = sessionsByKey.value[item.sessionKey]
      if (busySessions.has(item.sessionKey)) continue
      const running = runningBySession.value[item.sessionKey]
      const transmission = transmittingOutbox.get(item.id)
      const steerAttempt = attemptedOutboxSteers.get(item)
      // 插话回执未到时，让下一条消息进入现有的 pendingSteers 检查。
      if (running && transmission && transmission === steerAttempt) continue
      busySessions.add(item.sessionKey)
      if (!session || nodes.value.find(node => node.id === session.nodeId)?.status !== 'online'
        || transmission) continue

      if (running) {
        if (session.provider === 'hermes' && item.files.length === 0 && !steerAttempt) {
          const attempt = {}
          attemptedOutboxSteers.set(item, attempt)
          transmittingOutbox.set(item.id, attempt)
          void (async () => {
            let accepted = false
            try {
              accepted = await steerPromptToSession(item.sessionKey, item.text)
            } catch { accepted = false }
            if (fleetRoute.value !== route || transmittingOutbox.get(item.id) !== attempt) return
            if (accepted) {
              await removeOutboxPrompt(item)
              if (fleetRoute.value !== route) return
              appendSteerUserMessage(item)
            } else {
              transmittingOutbox.delete(item.id)
            }
            // 回合可能已在插话回执前结束，本次处理完后补一次常规发送。
            if (!runningBySession.value[item.sessionKey]) void flushOutbox()
          })()
        }
        continue
      }

      const attempt = {}
      transmittingOutbox.set(item.id, attempt)
      void (async () => {
        try {
          const attachments = await uploadFilesWithPreview(item.files)
          if (fleetRoute.value !== route || transmittingOutbox.get(item.id) !== attempt) return
          await sendPromptToSession(item.sessionKey, item.text, attachments, item.options, true, item)
        } catch (cause) {
          if (fleetRoute.value !== route || transmittingOutbox.get(item.id) !== attempt) return
          transmittingOutbox.delete(item.id)
          if (wsState.value !== 'online' || nodes.value.find(node => node.id === session.nodeId)?.status !== 'online') return
          restoreOutboxDraft(item)
          await removeOutboxPrompt(item)
          lastError.value = cause instanceof Error ? cause.message : '发送失败，消息已还原到输入框'
        }
      })()
    }
  }

  async function drainNextQueuedPrompt(sKey: string) {
    const queue = queuedPromptsBySession.value[sKey]
    if (!queue?.length || runningBySession.value[sKey]) return
    const [nextItem, ...rest] = queue
    queuedPromptsBySession.value = { ...queuedPromptsBySession.value, [sKey]: rest }
    try {
      await sendPromptToSpecificSession(sKey, nextItem.text, nextItem.files ?? [], nextItem.options)
    } catch (err) {
      lastError.value = err instanceof Error ? err.message : '排队消息发送失败'
    }
  }

  function enqueuePrompt(sKey: string, text: string, files: File[] = [], options?: RunOptions): QueuedPromptItem | null {
    const clean = text.trim()
    if (!clean && !files.length) return null
    const item: QueuedPromptItem = {
      id: createRequestId(),
      text: clean || '[发送了加密文件附件]',
      files: files.length ? [...files] : undefined,
      options: options ? { ...options } : undefined,
      createdAt: Date.now(),
    }
    queuedPromptsBySession.value = {
      ...queuedPromptsBySession.value,
      [sKey]: [...(queuedPromptsBySession.value[sKey] ?? []), item],
    }
    return item
  }

  function removeQueuedPrompt(sKey: string, queueId: string) {
    const list = queuedPromptsBySession.value[sKey] ?? []
    queuedPromptsBySession.value = {
      ...queuedPromptsBySession.value,
      [sKey]: list.filter(i => i.id !== queueId),
    }
  }

  function steerPromptToSession(sKey: string, text: string): Promise<boolean> {
    const sess = sessionsByKey.value[sKey]
    const clean = text.trim()
    if (!sess || !clean || [...pendingSteers.values()].some(steer => steer.sessionKey === sKey)) {
      return Promise.resolve(false)
    }
    const requestId = createRequestId()
    let finish!: (accepted: boolean) => void
    const result = new Promise<boolean>(resolve => { finish = resolve })
    pendingSteers.set(requestId, { sessionKey: sKey, result, finish })
    void result.then(() => pendingSteers.delete(requestId))
    try {
      if (!sendWsCommand({
        type: 'prompt.steer',
        nodeId: sess.nodeId,
        provider: sess.provider,
        sessionId: sess.sessionId,
        text: clean,
        requestId,
      }, false)) finish(false)
    } catch {
      finish(false)
    }
    return result
  }

  function updateQueuedPrompt(sKey: string, queueId: string, nextText: string) {
    const clean = nextText.trim()
    if (!clean) {
      removeQueuedPrompt(sKey, queueId)
      return
    }
    const list = queuedPromptsBySession.value[sKey] ?? []
    queuedPromptsBySession.value = {
      ...queuedPromptsBySession.value,
      [sKey]: list.map(i => (i.id === queueId ? { ...i, text: clean } : i)),
    }
  }

  function steerQueuedPrompt(sKey: string, queueId: string) {
    const list = queuedPromptsBySession.value[sKey] ?? []
    const idx = list.findIndex(i => i.id === queueId)
    if (idx < 0) return
    const target = list[idx]
    const reordered = [target, ...list.filter(i => i.id !== queueId)]
    queuedPromptsBySession.value = { ...queuedPromptsBySession.value, [sKey]: reordered }
    if (runningBySession.value[sKey]) {
      steerSessionKeys.add(sKey)
      cancelSessionRun(sKey)
    } else {
      void drainNextQueuedPrompt(sKey)
    }
  }

  async function uploadFilesWithPreview(files: File[]): Promise<ArtifactRef[]> {
    const uploadedRefs: ArtifactRef[] = []
    if (!files.length) return uploadedRefs
    const route = requireFleetRoute()
    const nextPreviews: Record<string, string> = {}
    for (const file of files) {
      const ref = await encryptAndUploadFile({ file, token: route.token, apiBaseUrl: route.origin })
      checkFleetRoute(route)
      uploadedRefs.push(ref)
    }
    for (const [index, file] of files.entries()) {
      if (
        file.type.startsWith('image/')
        && typeof URL !== 'undefined'
        && typeof URL.createObjectURL === 'function'
      ) {
        nextPreviews[uploadedRefs[index].artifactId] = URL.createObjectURL(file)
      }
    }
    if (Object.keys(nextPreviews).length) {
      imagePreviewByArtifactId.value = { ...imagePreviewByArtifactId.value, ...nextPreviews }
    }
    return uploadedRefs
  }

  async function sendPromptToSpecificSession(sKey: string, text: string, files: File[] = [], options?: RunOptions) {
    const clean = text.trim()
    if (!clean && !files.length) return
    const body = clean || '[发送了加密文件附件]'
    if (!localCacheRequested.value) {
      localCacheRequested.value = true
      await nextTick()
    }
    const local = storage
    const session = sessionsByKey.value[sKey]
    if (!session) throw new Error('目标会话不存在')
    if (!local) {
      if (runningBySession.value[sKey]) { enqueuePrompt(sKey, body, files, options); return }
      if (wsState.value !== 'online') throw new Error('当前环境无法加密保存待发送消息')
      const uploadedRefs = await uploadFilesWithPreview(files)
      await sendPromptToSession(sKey, body, uploadedRefs, options)
      return
    }
    if (outbox.value.length + pendingOutboxWrites.size >= 32) throw new Error('待发送队列已满')
    if (files.reduce((total, file) => total + file.size, 0) > 20 * 1024 * 1024) throw new Error('待发送附件合计不能超过 20 MB')
    const id = createRequestId()
    const seed = forkSeedBySession.value[sKey]
    const item: FleetOutboxItem = { id, sessionKey: sKey, session, text: body, files: [...files], options: options && { ...options },
      wireText: preparePromptText(body, seed), createdAt: Date.now() }
    pendingOutboxWrites.add(id)
    try { await local.savePrompt(item) }
    finally { pendingOutboxWrites.delete(id) }
    if (storage !== local) throw new Error('对话账号已切换，消息已保存在原账号的待发队列')
    if (seed && forkSeedBySession.value[sKey] === seed) delete forkSeedBySession.value[sKey]
    outbox.value = [...outbox.value, item].sort((left, right) => left.createdAt - right.createdAt)
    void flushOutbox()
  }

  async function sendPrompt(text: string, files: File[] = [], options?: RunOptions) {
    const clean = text.trim()
    if (!clean && !files.length) return
    const targetKey = activeSessionKey.value
    if (targetKey && sessionsByKey.value[targetKey]) return sendPromptToSpecificSession(targetKey, clean, files, options)
    const nid = selectedNode.value?.id
    if (!nid) throw new Error('当前没有可用的节点')
    const prov = selectedProvider.value

    const uploadedRefs = await uploadFilesWithPreview(files)

    // 尚无活跃会话时，自动为当前节点 + Provider 打开会话并在 SessionOpened 后发出首条消息
    const requestId = createRequestId()
    pendingOpenQueue.push({
      requestId, options,
      nodeId: nid,
      provider: prov,
      initialPrompt: clean || '[发送了加密文件附件]',
      initialAttachments: uploadedRefs.length ? uploadedRefs : undefined,
    })
    openSession({ nodeId: nid, provider: prov, requestId })
  }

  function cancelSessionRun(sKey?: string) {
    const targetKey = sKey || activeSessionKey.value
    if (!targetKey) return
    const sess = sessionsByKey.value[targetKey]
    const runId = runningBySession.value[targetKey]
    if (!sess || !runId || stopStatusBySession.value[targetKey]?.requestId) return
    const requestId = createRequestId()
    const sent = sendWsCommand({
      type: 'prompt.cancel',
      nodeId: sess.nodeId,
      provider: sess.provider,
      sessionId: sess.sessionId,
      ...(runId ? { runId } : {}),
      requestId,
    })
    stopStatusBySession.value[targetKey] = sent ? { requestId, state: 'requested' }
      : { state: 'error', message: '连接不可用，停止请求未送达' }
    if (sent) setTimeout(() => {
      if (stopStatusBySession.value[targetKey]?.requestId === requestId) {
        stopStatusBySession.value[targetKey] = { state: 'error', message: '代理尚未确认停止，可以重试' }
      }
    }, 12_000)
  }

  function reorderQueuedPrompt(sKey: string, queueId: string, delta: -1 | 1) {
    const list = [...(queuedPromptsBySession.value[sKey] ?? [])]
    const idx = list.findIndex(i => i.id === queueId)
    const target = idx + delta
    if (idx < 0 || target < 0 || target >= list.length) return
    const [moved] = list.splice(idx, 1)
    list.splice(target, 0, moved)
    queuedPromptsBySession.value = { ...queuedPromptsBySession.value, [sKey]: list }
  }

  async function continueInterruptedRun(sKey: string) {
    if (!sKey || runningBySession.value[sKey]) return
    const nextInt = { ...interruptedBySession.value }
    delete nextInt[sKey]
    interruptedBySession.value = nextInt
    await sendPromptToSession(sKey, '请从刚才中断的地方继续完成剩余步骤。', [], sessionPromptOptions(sKey))
  }

  function cancelActiveRun() {
    cancelSessionRun(activeSessionKey.value)
  }

  function respondPermission(callId: string, decision: ApprovalDecision) {
    const card = pendingApprovalsByCall.value[callId]
    if (!card || card.decision !== 'pending') return
    if (!sendWsCommand({ type: 'permission.respond', nodeId: card.nodeId, provider: card.provider, callId, decision })) return
    const updatedCard: PermissionRequestCard = { ...card, decision }
    pendingApprovalsByCall.value = { ...pendingApprovalsByCall.value, [callId]: updatedCard }

    const sKey = sessionKey(card.nodeId, card.provider, card.sessionId)
    const list = messagesBySession.value[sKey]
    if (list) {
      messagesBySession.value = {
        ...messagesBySession.value,
        [sKey]: list.map(m =>
          m.approvals?.some(a => a.callId === callId)
            ? {
                ...m,
                approvals: m.approvals.map(a => (a.callId === callId ? updatedCard : a)),
              }
            : m,
        ),
      }
    }

  }

  function dismissSessionApprovals(sKey: string, keep = new Set<string | undefined>()) {
    const expired = pendingApprovalsList.value.filter(card =>
      sessionKey(card.nodeId, card.provider, card.sessionId) === sKey && !keep.has(card.callId))
    if (!expired.length) return
    for (const card of expired) delete pendingApprovalsByCall.value[card.callId]
    const ids = new Set(expired.map(card => card.callId))
    messagesBySession.value[sKey] = (messagesBySession.value[sKey] ?? []).map(message => message.approvals?.some(card => ids.has(card.callId))
      ? { ...message, approvals: message.approvals.filter(card => !ids.has(card.callId)) }
      : message)
  }

  function sendHandoff(options: {
    targetNodeId: string
    targetProvider: AdapterProvider
    targetSessionId?: string
    summary: string
    artifact?: ArtifactRef
    sourceSessionKey?: string
  }) {
    const targetKey = options.targetSessionId
      ? sessionKey(options.targetNodeId, options.targetProvider, options.targetSessionId)
      : Object.entries(sessionsByKey.value).find(
          ([, s]) => s.nodeId === options.targetNodeId && s.provider === options.targetProvider,
        )?.[0]

    const sid = options.targetSessionId ?? (targetKey ? sessionsByKey.value[targetKey]?.sessionId : undefined)
    if (!sid) {
      const requestId = createRequestId()
      pendingOpenQueue.push({
        requestId,
        nodeId: options.targetNodeId,
        provider: options.targetProvider,
        initialHandoff: { summary: options.summary, artifact: options.artifact, sourceSessionKey: options.sourceSessionKey },
      })
      openSession({ nodeId: options.targetNodeId, provider: options.targetProvider, requestId })
      return
    }

    const reqId = createRequestId()
    const sent = sendWsCommand({
      type: 'handoff.send',
      nodeId: options.targetNodeId,
      provider: options.targetProvider,
      sessionId: sid,
      summary: options.summary,
      sourceSessionKey: options.sourceSessionKey,
      ...(options.artifact ? { artifact: options.artifact } : {}),
      requestId: reqId,
    })
    if (sent && targetKey) {
      appendMessage(targetKey, {
        id: `handoff-${reqId}`,
        role: 'user',
        requestId: reqId,
        nodeId: options.targetNodeId,
        provider: options.targetProvider,
        text: `@Handoff · ${options.summary}`,
        delivery: 'sending',
        artifacts: options.artifact ? [options.artifact] : undefined,
        createdAt: Date.now(),
      })
      activateSession(targetKey)
    }
  }

  /**
   * 群发对比（Fan-out）：同时向多个在线（nodeId, provider）派发同一指令，便于并行横向对比。
   */
  async function sendFanout(
    targets: Array<{ nodeId: string; provider: AdapterProvider }>,
    text: string,
    onTarget?: (key: string, index: number) => void,
  ) {
    const clean = text.trim()
    if (!clean) return
    for (const [index, target] of targets.entries()) {
      const existingEntry = Object.entries(sessionsByKey.value).find(
        ([, s]) => s.nodeId === target.nodeId && s.provider === target.provider,
      )
      if (existingEntry) {
        onTarget?.(existingEntry[0], index)
        await sendPromptToSession(existingEntry[0], clean)
      } else {
        const requestId = createRequestId()
        pendingOpenQueue.push({ ...target, requestId, initialPrompt: clean, onOpened: onTarget ? key => onTarget(key, index) : undefined })
        openSession({ ...target, requestId })
      }
    }
  }

  async function ensureArtifactImagePreview(artifact: ArtifactRef) {
    const route = fleetRoute.value
    if (
      !route ||
      !artifact?.artifactId ||
      !artifact.keyB64 ||
      !artifact.mime?.startsWith('image/') ||
      imagePreviewByArtifactId.value[artifact.artifactId]
    ) {
      return
    }
    try {
      const { blob } = await downloadAndDecryptBlob({
        artifact,
        token: route.token,
        apiBaseUrl: route.origin,
      })
      checkFleetRoute(route)
      if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
        imagePreviewByArtifactId.value = {
          ...imagePreviewByArtifactId.value,
          [artifact.artifactId]: URL.createObjectURL(blob),
        }
      }
    } catch {
      // 静默降级为普通附件卡片下载
    }
  }

  async function downloadArtifactToBrowser(artifact: ArtifactRef) {
    const route = requireFleetRoute()
    const { blob, transport, fileName } = await downloadAndDecryptBlob({
      artifact,
      token: route.token,
      apiBaseUrl: route.origin,
    })
    checkFleetRoute(route)
    await saveBlobToDevice(blob, fileName)
    return transport
  }

  async function readHermesAttachment(
    key: string,
    reference: string,
    purpose: 'preview' | 'download',
    signal?: AbortSignal,
  ) {
    const session = sessionsByKey.value[key]
    if (!session || session.provider !== 'hermes') throw new Error('找不到附件所属的 Hermes 会话')
    const node = nodes.value.find(item => item.id === session.nodeId)
    if (node?.status === 'online' && !node.adapters.some(adapter =>
      adapter.provider === 'hermes' && adapter.capabilities.includes('hermes-media-v1'),
    )) throw new Error('当前节点未提供预览或下载服务')
    const route = requireFleetRoute()
    const media = await fetchHermesMedia(route.token, route.origin, {
      nodeId: session.nodeId, sessionId: session.sessionId, reference, purpose,
    }, signal)
    checkFleetRoute(route)
    return media
  }

  function requestFilesList(query = '', limit = 60, sKey?: string) {
    const key = sKey || activeSessionKey.value
    const sess = key ? sessionsByKey.value[key] : null
    const nid = sess?.nodeId ?? selectedNode.value?.id
    const prov = sess?.provider ?? selectedProvider.value
    if (!nid) return false
    return sendWsCommand({
      type: 'files.list',
      nodeId: nid,
      provider: prov,
      ...(sess ? { sessionId: sess.sessionId, cwd: sess.worktreePath || sess.cwd } : {}),
      query,
      limit,
      requestId: createRequestId(),
    })
  }

  function requestSessionDiff(sKey?: string, checkpointId?: string) {
    const key = sKey || activeSessionKey.value
    const sess = key ? sessionsByKey.value[key] : null
    if (!sess) return false
    return sendWsCommand({
      type: 'session.diff',
      nodeId: sess.nodeId,
      provider: sess.provider,
      sessionId: sess.sessionId,
      ...(sess.worktreePath || sess.cwd ? { cwd: sess.worktreePath || sess.cwd } : {}),
      ...(checkpointId ? { checkpointId } : {}),
      requestId: createRequestId(),
    })
  }

  function revertCheckpoint(sKey: string, checkpointId?: string) {
    const sess = sessionsByKey.value[sKey]
    if (!sess) return false
    return sendWsCommand({
      type: 'checkpoint.revert',
      nodeId: sess.nodeId,
      provider: sess.provider,
      sessionId: sess.sessionId,
      ...(checkpointId ? { checkpointId } : {}),
      requestId: createRequestId(),
    })
  }

  function requestAgents(nodeId: string, provider: AdapterProvider) {
    return sendWsCommand({ type: 'agents.list', nodeId, provider, requestId: createRequestId() })
  }

  function requestMcpServers(nodeId: string, provider: AdapterProvider) {
    const requestId = createRequestId()
    const target = `${nodeId}::${provider}`
    pendingMcpRequests.set(requestId, target)
    if (pendingMcpRequests.size > 100) {
      const oldest = pendingMcpRequests.keys().next().value
      if (oldest) pendingMcpRequests.delete(oldest)
    }
    const sent = sendWsCommand({ type: 'mcp.list', nodeId, provider, requestId }, false)
    if (!sent) {
      pendingMcpRequests.delete(requestId)
      mcpErrorsByTarget.value = { ...mcpErrorsByTarget.value, [target]: '节点连接尚未就绪' }
    }
    return sent
  }

  function requestRules(sKey?: string) {
    const key = sKey || activeSessionKey.value
    const sess = key ? sessionsByKey.value[key] : null
    const nid = sess?.nodeId ?? selectedNode.value?.id
    const prov = sess?.provider ?? selectedProvider.value
    if (!nid) return false
    return sendWsCommand({
      type: 'rules.list',
      nodeId: nid,
      provider: prov,
      ...(sess ? { sessionId: sess.sessionId, cwd: sess.worktreePath || sess.cwd } : {}),
      requestId: createRequestId(),
    })
  }

  function requestSkills(sKey?: string) {
    const key = sKey || activeSessionKey.value
    const sess = key ? sessionsByKey.value[key] : null
    const nid = sess?.nodeId ?? selectedNode.value?.id
    const prov = sess?.provider ?? selectedProvider.value
    if (!nid) return false
    return sendWsCommand({
      type: 'skills.list',
      nodeId: nid,
      provider: prov,
      ...(sess ? { sessionId: sess.sessionId, cwd: sess.worktreePath || sess.cwd } : {}),
      requestId: createRequestId(),
    })
  }

  function saveWorkspaceFile(path: string, content: string, sKey?: string) {
    const key = sKey || activeSessionKey.value
    const sess = key ? sessionsByKey.value[key] : null
    const clean = path.trim()
    if (!sess || !clean) return false
    const existing = filePreviewBySession.value[key]
    if (existing && existing.path === clean) {
      filePreviewBySession.value = {
        ...filePreviewBySession.value,
        [key]: { ...existing, content, saving: true },
      }
    }
    return sendWsCommand({
      type: 'file.write',
      nodeId: sess.nodeId,
      provider: sess.provider,
      sessionId: sess.sessionId,
      ...(sess.worktreePath || sess.cwd ? { cwd: sess.worktreePath || sess.cwd } : {}),
      path: clean,
      content,
      requestId: createRequestId(),
    })
  }

  function requestFileBlame(path: string, sKey?: string) {
    const key = sKey || activeSessionKey.value
    const sess = key ? sessionsByKey.value[key] : null
    const clean = path.trim()
    if (!sess || !clean) return false
    const existing = filePreviewBySession.value[key]
    if (existing && existing.path === clean) {
      filePreviewBySession.value = {
        ...filePreviewBySession.value,
        [key]: { ...existing, blameLoading: true },
      }
    }
    return sendWsCommand({
      type: 'file.blame',
      nodeId: sess.nodeId,
      provider: sess.provider,
      sessionId: sess.sessionId,
      ...(sess.worktreePath || sess.cwd ? { cwd: sess.worktreePath || sess.cwd } : {}),
      path: clean,
      requestId: createRequestId(),
    })
  }

  function addDiffAnnotation(
    sKey: string,
    payload: { filePath: string; lineNo: number; codeSnippet: string; comment: string },
  ): DiffAnnotation | null {
    const cleanComment = payload.comment.trim()
    if (!sKey || !payload.filePath || !cleanComment) return null
    const item: DiffAnnotation = {
      id: `ann-${createRequestId()}`,
      filePath: payload.filePath,
      lineNo: Math.max(1, payload.lineNo),
      codeSnippet: payload.codeSnippet,
      comment: cleanComment,
      resolved: false,
      createdAt: Date.now(),
    }
    diffAnnotationsBySession.value = {
      ...diffAnnotationsBySession.value,
      [sKey]: [...(diffAnnotationsBySession.value[sKey] ?? []), item],
    }
    return item
  }

  function toggleDiffAnnotationResolved(sKey: string, annId: string) {
    const list = diffAnnotationsBySession.value[sKey] ?? []
    diffAnnotationsBySession.value = {
      ...diffAnnotationsBySession.value,
      [sKey]: list.map(a => (a.id === annId ? { ...a, resolved: !a.resolved } : a)),
    }
  }

  function removeDiffAnnotation(sKey: string, annId: string) {
    const list = diffAnnotationsBySession.value[sKey] ?? []
    diffAnnotationsBySession.value = {
      ...diffAnnotationsBySession.value,
      [sKey]: list.filter(a => a.id !== annId),
    }
  }

  function clearResolvedDiffAnnotations(sKey: string) {
    const list = diffAnnotationsBySession.value[sKey] ?? []
    diffAnnotationsBySession.value = {
      ...diffAnnotationsBySession.value,
      [sKey]: list.filter(a => !a.resolved),
    }
  }

  async function sendDiffAnnotationsToAgent(sKey: string): Promise<number> {
    const list = diffAnnotationsBySession.value[sKey] ?? []
    const unresolved = list.filter(a => !a.resolved && a.comment.trim())
    const prompt = buildDiffAnnotationsPrompt(unresolved)
    if (!prompt) return 0
    const options = sessionPromptOptions(sKey)
    if (runningBySession.value[sKey]) {
      enqueuePrompt(sKey, prompt, [], options)
    } else {
      await sendPromptToSession(sKey, prompt, [], options)
    }
    return unresolved.length
  }

  function sendTerminalSignal(sKey: string, signal = 'SIGINT') {
    const sess = sessionsByKey.value[sKey]
    const term = terminalBySession.value[sKey]
    if (!sess || !term || term.closed) return false
    return sendWsCommand({
      type: 'terminal.signal',
      nodeId: sess.nodeId,
      provider: sess.provider,
      sessionId: sess.sessionId,
      terminalId: term.terminalId,
      signal,
    })
  }

  function resizeTerminal(sKey: string, cols: number, rows: number) {
    const sess = sessionsByKey.value[sKey]
    const term = terminalBySession.value[sKey]
    if (!sess || !term || term.closed) return false
    return sendWsCommand({
      type: 'terminal.resize',
      nodeId: sess.nodeId,
      provider: sess.provider,
      sessionId: sess.sessionId,
      terminalId: term.terminalId,
      cols,
      rows,
    })
  }

  async function openOrSendSideChat(parentKey: string, question?: string): Promise<string | null> {
    const parentSess = sessionsByKey.value[parentKey]
    if (!parentSess) return null
    const existingKey = sideChatSessionKeyByParent.value[parentKey]
    const cleanQ = (question || '').trim()
    if (existingKey && sessionsByKey.value[existingKey]) {
      if (cleanQ) {
        const sideOptions = sessionPromptOptions(existingKey)
        if (runningBySession.value[existingKey]) {
          enqueuePrompt(existingKey, cleanQ, [], sideOptions)
        } else {
          await sendPromptToSession(existingKey, cleanQ, [], sideOptions)
        }
      }
      return existingKey
    }

    const parentMsgs = messagesBySession.value[parentKey] ?? []
    const seed = buildForkContextSeed(parentMsgs, parentSess.title, 4200)
    const sideSeed = seed
      ? `[临时侧边问答 /btw · 只读参考主会话，不改动主会话任务进度]\n${seed}`
      : `[临时侧边问答 /btw · 当前工作目录 ${parentSess.worktreePath || parentSess.cwd || '-'}]`

    return new Promise(resolve => {
      const requestId = createRequestId()
      openSession({
        nodeId: parentSess.nodeId,
        provider: parentSess.provider,
        cwd: parentSess.worktreePath || parentSess.cwd || undefined,
        requestId,
        inheritFromKey: parentKey,
        onOpened(newKey) {
          sideChatSessionKeyByParent.value = {
            ...sideChatSessionKeyByParent.value,
            [parentKey]: newKey,
          }
          forkSeedBySession.value = {
            ...forkSeedBySession.value,
            [newKey]: sideSeed,
          }
          if (sessionsByKey.value[newKey]) {
            sessionsByKey.value = {
              ...sessionsByKey.value,
              [newKey]: { ...sessionsByKey.value[newKey], title: `侧边问答 · ${parentSess.title}` },
            }
          }
          if (cleanQ) {
            void sendPromptToSession(newKey, cleanQ, [], runSettings.value[newKey])
          }
          resolve(newKey)
        },
      })
    })
  }

  function requestFileContent(path: string, sKey?: string, highlightLine?: number) {
    const key = sKey || activeSessionKey.value
    const sess = key ? sessionsByKey.value[key] : null
    const clean = path.trim()
    if (!sess || !clean) return false
    filePreviewBySession.value = {
      ...filePreviewBySession.value,
      [key]: {
        path: clean,
        language: filePreviewBySession.value[key]?.path === clean ? filePreviewBySession.value[key].language : '',
        content: filePreviewBySession.value[key]?.path === clean ? filePreviewBySession.value[key].content : '',
        lineCount: filePreviewBySession.value[key]?.path === clean ? filePreviewBySession.value[key].lineCount : 0,
        truncated: false,
        sizeBytes: 0,
        isBinary: false,
        loading: true,
        highlightLine,
        updatedAt: Date.now(),
      },
    }
    return sendWsCommand({
      type: 'file.read',
      nodeId: sess.nodeId,
      provider: sess.provider,
      sessionId: sess.sessionId,
      ...(sess.worktreePath || sess.cwd ? { cwd: sess.worktreePath || sess.cwd } : {}),
      path: clean,
      requestId: createRequestId(),
    })
  }

  function downloadWorkspaceFile(path: string, sKey?: string, onSaved?: () => void) {
    const key = sKey || activeSessionKey.value
    const sess = key ? sessionsByKey.value[key] : null
    const clean = path.trim()
    if (!sess || !clean) return false
    const reqId = createRequestId()
    const fileName = clean.replace(/\\/g, '/').split('/').pop() || 'download'
    const sent = sendWsCommand({
      type: 'file.read',
      nodeId: sess.nodeId,
      provider: sess.provider,
      sessionId: sess.sessionId,
      ...(sess.worktreePath || sess.cwd ? { cwd: sess.worktreePath || sess.cwd } : {}),
      path: clean,
      requestId: reqId,
    })
    if (sent) {
      pendingDownloadRequests.set(reqId, { fileName, onSaved })
      silentFileReadRequests.add(reqId)
    }
    return sent
  }

  function requestDiffFileContext(path: string, sKey?: string, force = false) {
    const key = sKey || activeSessionKey.value
    const sess = key ? sessionsByKey.value[key] : null
    const clean = path.trim()
    if (!sess || !clean) return false
    if (!force && fileTextCacheBySession.value[key]?.[clean]) return true
    const reqId = createRequestId()
    silentFileReadRequests.add(reqId)
    return sendWsCommand({
      type: 'file.read',
      nodeId: sess.nodeId,
      provider: sess.provider,
      sessionId: sess.sessionId,
      ...(sess.worktreePath || sess.cwd ? { cwd: sess.worktreePath || sess.cwd } : {}),
      path: clean,
      requestId: reqId,
    })
  }

  function closeFilePreview(sKey?: string) {
    const key = sKey || activeSessionKey.value
    if (!key || !filePreviewBySession.value[key]) return
    const copy = { ...filePreviewBySession.value }
    delete copy[key]
    filePreviewBySession.value = copy
  }

  function revertFiles(sKey: string, paths: string[], checkpointId?: string) {
    const sess = sessionsByKey.value[sKey]
    if (!sess || !paths.length) return false
    return sendWsCommand({
      type: 'files.revert',
      nodeId: sess.nodeId,
      provider: sess.provider,
      sessionId: sess.sessionId,
      paths,
      ...(checkpointId ? { checkpointId } : {}),
      requestId: createRequestId(),
    })
  }

  function mergeSessionWorktree(sKey?: string) {
    const key = sKey || activeSessionKey.value
    const sess = key ? sessionsByKey.value[key] : null
    if (!sess?.worktreePath) return false
    return sendWsCommand({
      type: 'worktree.merge',
      nodeId: sess.nodeId,
      provider: sess.provider,
      sessionId: sess.sessionId,
      requestId: createRequestId(),
    })
  }

  function replyForm(formId: string, answer?: Record<string, unknown>, cancelled = false) {
    const form = pendingFormsById.value[formId]
    if (!form) return false
    const nextStatus = cancelled ? 'cancelled' : 'submitted'
    const updated: MessageFormRequest = { ...form, status: nextStatus, ...(answer ? { answer } : {}) }
    pendingFormsById.value = { ...pendingFormsById.value, [formId]: updated }
    const sKey = sessionKey(form.nodeId, form.provider, form.sessionId)
    const list = messagesBySession.value[sKey]
    if (list) {
      messagesBySession.value = {
        ...messagesBySession.value,
        [sKey]: list.map(m =>
          m.forms?.some(f => f.formId === formId)
            ? { ...m, forms: m.forms.map(f => (f.formId === formId ? updated : f)) }
            : m,
        ),
      }
    }
    return sendWsCommand({
      type: 'form.reply',
      nodeId: form.nodeId,
      provider: form.provider,
      sessionId: form.sessionId,
      formId,
      ...(answer ? { answer } : {}),
      cancelled,
      requestId: createRequestId(),
    })
  }

  function compactSession(sKey: string) {
    const sess = sessionsByKey.value[sKey]
    if (!sess || contextCompactions.value[sKey]) return false
    const requestId = createRequestId()
    const sent = sendWsCommand({
      type: 'session.compact',
      nodeId: sess.nodeId,
      provider: sess.provider,
      sessionId: sess.sessionId,
      requestId,
    })
    if (sent) {
      contextCompactions.value[sKey] = requestId
      setTimeout(() => {
        if (contextCompactions.value[sKey] === requestId) delete contextCompactions.value[sKey]
      }, 100_000)
    }
    return sent
  }

  function renameSession(sKey: string, title: string) {
    const sess = sessionsByKey.value[sKey]
    const clean = redactSessionTitleCredentials(title.trim())
    if (!sess || !clean) return false
    sessionsByKey.value = {
      ...sessionsByKey.value,
      [sKey]: { ...sess, title: clean },
    }
    return sendWsCommand({
      type: 'session.rename',
      nodeId: sess.nodeId,
      provider: sess.provider,
      sessionId: sess.sessionId,
      title: clean,
      requestId: createRequestId(),
    })
  }

  function deleteSession(sKey: string) {
    const sess = sessionsByKey.value[sKey]
    if (!sess) return false
    return sendWsCommand({
      type: 'session.delete',
      nodeId: sess.nodeId,
      provider: sess.provider,
      sessionId: sess.sessionId,
      requestId: createRequestId(),
    })
  }

  async function editMessageAndBranch(
    sKey: string,
    userMsgIndex: number,
    nextUserText: string,
    options?: RunOptions,
  ) {
    const list = messagesBySession.value[sKey]
    if (!list) return
    const clean = nextUserText.trim()
    if (!clean) return
    const nextList = branchFromUserMessage(list, userMsgIndex, clean)
    messagesBySession.value = { ...messagesBySession.value, [sKey]: nextList }
    await sendPromptToSession(sKey, clean, [], options ?? sessionPromptOptions(sKey), false)
  }

  async function regenerateAssistantMessage(
    sKey: string,
    assistantMsgIndex: number,
    options?: RunOptions,
    revertCodeIfCheckpointed = true,
  ) {
    const list = messagesBySession.value[sKey]
    if (!list || assistantMsgIndex <= 0) return
    const targetAssistant = list[assistantMsgIndex]
    if (revertCodeIfCheckpointed && targetAssistant?.checkpointId) {
      const cp = (checkpointsBySession.value[sKey] ?? []).find(c => c.checkpointId === targetAssistant.checkpointId)
      if (cp && !cp.reverted) {
        revertCheckpoint(sKey, targetAssistant.checkpointId)
      }
    }
    let userIdx = assistantMsgIndex - 1
    while (userIdx >= 0 && list[userIdx].role !== 'user') {
      userIdx -= 1
    }
    if (userIdx < 0) return
    const userPrompt = list[userIdx].text
    const nextList = branchFromUserMessage(list, userIdx, userPrompt)
    messagesBySession.value = { ...messagesBySession.value, [sKey]: nextList }
    const wirePrompt = `[重新生成上一轮回答] 请忽略上一版回复，重新完整处理以下请求：\n${userPrompt}`
    await sendPromptToSession(sKey, wirePrompt, [], options ?? sessionPromptOptions(sKey), false)
  }

  function switchBranch(sKey: string, anchorIndex: number, targetBranchIndex: number) {
    const list = messagesBySession.value[sKey]
    if (!list) return
    messagesBySession.value = {
      ...messagesBySession.value,
      [sKey]: switchMessageBranch(list, anchorIndex, targetBranchIndex),
    }
  }

  function forkSessionFromMessage(sKey: string, upToIndex: number, followUpPrompt?: string) {
    const sess = sessionsByKey.value[sKey]
    const list = messagesBySession.value[sKey] ?? []
    if (!sess) return
    const sliced = list.slice(0, Math.max(1, upToIndex + 1)).map(m => ({
      ...m,
      streaming: false,
    }))
    const requestId = createRequestId()
    const contextSeed = buildForkContextSeed(sliced, sess.title)

    openSession({
      nodeId: sess.nodeId,
      provider: sess.provider,
      cwd: sess.worktreePath || sess.cwd || undefined,
      requestId,
      inheritFromKey: sKey,
      onOpened(newKey) {
        messagesBySession.value = {
          ...messagesBySession.value,
          [newKey]: [
            ...sliced,
            {
              id: `sys-fork-${Date.now()}`,
              role: 'system',
              nodeId: sess.nodeId,
              provider: sess.provider,
              text: `已从「${sess.title}」分叉出独立会话（已自动继承前情上下文）`,
              createdAt: Date.now(),
            },
          ],
        }
        if (contextSeed) {
          forkSeedBySession.value = { ...forkSeedBySession.value, [newKey]: contextSeed }
        }
        if (sessionsByKey.value[newKey]) {
          sessionsByKey.value = {
            ...sessionsByKey.value,
            [newKey]: { ...sessionsByKey.value[newKey], title: `${sess.title} (分支)` },
          }
        }
        activeSessionKey.value = newKey
        if (followUpPrompt?.trim()) {
          void sendPromptToSession(newKey, followUpPrompt.trim(), [], runSettings.value[newKey], true)
        }
      },
    })
  }

  function exportSessionMarkdown(sKey?: string): string {
    const key = sKey || activeSessionKey.value
    const sess = key ? sessionsByKey.value[key] : null
    if (!sess) return ''
    const msgs = messagesBySession.value[key] ?? []
    const nodeName = nodes.value.find(n => n.id === sess.nodeId)?.name
    const md = buildSessionMarkdown(sess, msgs, nodeName)
    if (typeof document !== 'undefined' && typeof Blob !== 'undefined') {
      const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      try {
        const a = document.createElement('a')
        a.href = url
        const safeTitle = (sess.title || sess.sessionId).replace(/[^A-Za-z0-9._\-\u4e00-\u9fff]+/g, '_')
        a.download = `${safeTitle}.md`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
      } finally {
        URL.revokeObjectURL(url)
      }
    }
    return md
  }

  function exportSessionHtml(sKey?: string): string {
    const key = sKey || activeSessionKey.value
    const sess = key ? sessionsByKey.value[key] : null
    if (!sess) return ''
    const msgs = messagesBySession.value[key] ?? []
    const nodeName = nodes.value.find(n => n.id === sess.nodeId)?.name
    const html = buildSessionHtmlReport(sess, msgs, nodeName)
    if (typeof document !== 'undefined' && typeof Blob !== 'undefined') {
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      try {
        const a = document.createElement('a')
        a.href = url
        const safeTitle = (sess.title || sess.sessionId).replace(/[^A-Za-z0-9._\-\u4e00-\u9fff]+/g, '_')
        a.download = `${safeTitle}.html`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
      } finally {
        URL.revokeObjectURL(url)
      }
    }
    return html
  }

  function requestWorkspaceTree(relDir = '', sKey?: string) {
    const key = sKey || activeSessionKey.value
    const sess = key ? sessionsByKey.value[key] : null
    const nid = sess?.nodeId ?? selectedNode.value?.id
    const prov = sess?.provider ?? selectedProvider.value
    if (!nid) return false
    return sendWsCommand({
      type: 'files.tree',
      nodeId: nid,
      provider: prov,
      ...(sess ? { sessionId: sess.sessionId, cwd: sess.worktreePath || sess.cwd } : {}),
      relDir,
      requestId: createRequestId(),
    })
  }

  function revertDiffHunk(sKey: string, path: string, hunkPatch: string) {
    const sess = sessionsByKey.value[sKey]
    if (!sess || !path || !hunkPatch) return false
    return sendWsCommand({
      type: 'diff.revert_hunk',
      nodeId: sess.nodeId,
      provider: sess.provider,
      sessionId: sess.sessionId,
      path,
      patch: hunkPatch,
      requestId: createRequestId(),
    })
  }

  function commitWorkspaceChanges(sKey: string, message: string, paths?: string[]) {
    const sess = sessionsByKey.value[sKey]
    const cleanMsg = message.trim()
    if (!sess || !cleanMsg) return false
    return sendWsCommand({
      type: 'git.commit',
      nodeId: sess.nodeId,
      provider: sess.provider,
      sessionId: sess.sessionId,
      message: cleanMsg,
      ...(paths?.length ? { paths } : {}),
      requestId: createRequestId(),
    })
  }

  function supportsProjectPermissions(nodeId: string) {
    return Boolean(nodes.value.find(node => node.id === nodeId)?.adapters.some(
      adapter => adapter.capabilities.includes('project-permissions'),
    ))
  }

  function requestProjectPermissions(nodeId: string) {
    if (wsState.value !== 'online' || !supportsProjectPermissions(nodeId)) return
    sendWsCommand({ type: 'project.permissions.list', nodeId, requestId: createRequestId() }, false)
  }

  function saveProjectPermission(nodeId: string, cwd: string, mode: ProjectPermissionSetting) {
    return new Promise<void>((resolve, reject) => {
      if (wsState.value !== 'online' || nodes.value.find(node => node.id === nodeId)?.status !== 'online'
        || !supportsProjectPermissions(nodeId)) {
        reject(new Error('请连接支持项目权限的 Agent Node'))
        return
      }
      const requestId = createRequestId()
      const finish = (error?: Error) => {
        clearTimeout(timer)
        projectPermissionWrites.delete(requestId)
        if (error) reject(error)
        else resolve()
      }
      const timer = setTimeout(() => finish(new Error('未收到节点确认，请重新打开项目设置查看')), 8000)
      projectPermissionWrites.set(requestId, finish)
      if (!sendWsCommand({ type: 'project.permissions.set', nodeId, cwd, mode, requestId }, false)) {
        finish(new Error('无法连接 Agent Node'))
      }
    })
  }

  function requestTrustPolicies(nodeId?: string) {
    const nid = nodeId || selectedNode.value?.id
    if (!nid) return false
    return sendWsCommand({ type: 'trust.list', nodeId: nid, requestId: createRequestId() })
  }

  function addTrustPattern(nodeId: string, pattern: string) {
    const clean = pattern.trim()
    if (!nodeId || !clean) return false
    return sendWsCommand({ type: 'trust.add', nodeId, pattern: clean, requestId: createRequestId() })
  }

  function removeTrustPattern(nodeId: string, pattern: string) {
    if (!nodeId || !pattern) return false
    return sendWsCommand({ type: 'trust.remove', nodeId, pattern, requestId: createRequestId() })
  }

  function openTerminal(sKey?: string) {
    const key = sKey || activeSessionKey.value
    const sess = key ? sessionsByKey.value[key] : null
    if (!sess) return false
    return sendWsCommand({
      type: 'terminal.open',
      nodeId: sess.nodeId,
      provider: sess.provider,
      sessionId: sess.sessionId,
      ...(sess.worktreePath || sess.cwd ? { cwd: sess.worktreePath || sess.cwd } : {}),
      requestId: createRequestId(),
    })
  }

  function requestTerminalPreview(key: string, port: number, tls = false) {
    const session = sessionsByKey.value[key]
    const terminal = terminalBySession.value[key]
    if (!session || !terminal || terminal.closed || !Number.isInteger(port) || port < 1024 || port > 65535) return
    const requestId = createRequestId()
    const sent = sendWsCommand({
      type: 'terminal.preview', nodeId: session.nodeId, provider: session.provider, sessionId: session.sessionId,
      terminalId: terminal.terminalId, port, tls, requestId,
    })
    const previews = terminalPreviews.value[key] ??= {}
    previews[port] = sent ? { requestId, pending: true } : { requestId, error: '节点连接不可用' }
    if (sent) setTimeout(() => {
      const current = terminalPreviews.value[key]?.[port]
      if (current?.pending && current.requestId === requestId) {
        terminalPreviews.value[key][port] = { requestId, error: '等待节点响应超时' }
      }
    }, 6000)
  }

  function sendTerminalInput(sKey: string, data: string) {
    const sess = sessionsByKey.value[sKey]
    const term = terminalBySession.value[sKey]
    if (!sess || !term || term.closed) return false
    return sendWsCommand({
      type: 'terminal.input',
      nodeId: sess.nodeId,
      provider: sess.provider,
      sessionId: sess.sessionId,
      terminalId: term.terminalId,
      data,
    })
  }

  function closeTerminal(sKey?: string) {
    const key = sKey || activeSessionKey.value
    const sess = key ? sessionsByKey.value[key] : null
    const term = key ? terminalBySession.value[key] : null
    if (!sess || !term) return false
    return sendWsCommand({
      type: 'terminal.close',
      nodeId: sess.nodeId,
      provider: sess.provider,
      sessionId: sess.sessionId,
      terminalId: term.terminalId,
    })
  }

  function toggleMessageBookmark(sKey: string, msgId: string) {
    if (!sKey || !msgId) return
    const cur = bookmarkedIdsBySession.value[sKey] ?? []
    const exists = cur.includes(msgId)
    bookmarkedIdsBySession.value = {
      ...bookmarkedIdsBySession.value,
      [sKey]: exists ? cur.filter(id => id !== msgId) : [...cur, msgId],
    }
  }

  async function toggleDesktopNotifications(): Promise<boolean> {
    if (androidNotificationsReady) {
      if (changingAndroidNotifications) return notificationsEnabled.value
      changingAndroidNotifications = true
      try {
        await androidNotificationsReady
        notificationsEnabled.value = await androidInvoke<boolean>('android_set_notifications_enabled', {
          enabled: !notificationsEnabled.value,
        })
        return notificationsEnabled.value
      } catch {
        return false
      } finally {
        changingAndroidNotifications = false
      }
    }
    if (nativeTransport) {
      notificationsEnabled.value = !notificationsEnabled.value
      localStorage.setItem(DESKTOP_NOTIFICATION_PREF, notificationsEnabled.value ? 'on' : 'off')
      return notificationsEnabled.value
    }
    if (typeof window === 'undefined' || typeof Notification === 'undefined') return false
    if (notificationsEnabled.value) {
      notificationsEnabled.value = false
      return false
    }
    if (Notification.permission === 'granted') {
      notificationsEnabled.value = true
      return true
    }
    if (Notification.permission === 'denied') {
      return false
    }
    try {
      const res = await Notification.requestPermission()
      notificationsEnabled.value = res === 'granted'
      return notificationsEnabled.value
    } catch {
      return false
    }
  }

  function openExternalTarget(relPath = '', target: 'editor' | 'folder' = 'editor', sKey?: string) {
    const key = sKey || activeSessionKey.value
    const sess = key ? sessionsByKey.value[key] : null
    if (!sess) return false
    return sendWsCommand({
      type: 'workspace.open_external',
      nodeId: sess.nodeId,
      provider: sess.provider,
      sessionId: sess.sessionId,
      ...(sess.worktreePath || sess.cwd ? { cwd: sess.worktreePath || sess.cwd } : {}),
      path: relPath,
      target,
      requestId: createRequestId(),
    })
  }

  function notifyBackgroundEvent(title: string, body: string, cueKind: 'complete' | 'approval' = 'approval', isPermission = false, target?: string) {
    if (soundEnabled.value && (cueKind === 'approval' || (typeof document !== 'undefined' && document.hidden))) {
      playCueSound(cueKind)
    }
    if (typeof document === 'undefined') return
    if (document.hidden) {
      unreadNotifyTitle.value = title
      if (nativeTransport) {
        if (cueKind === 'complete' || !notificationsEnabled.value) return
        if (android) {
          if (!isPermission) void androidInvoke('android_show_fleet_notification', { title, body: body.slice(0, 120), sessionKey: target }).catch(() => {})
        } else {
          void invoke('fleet_notify_attention', { title, body: body.slice(0, 120) }).catch(() => {})
        }
      } else if (notificationsEnabled.value && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try {
          const notice = new Notification(title, { body: body.slice(0, 120) })
          notice.onclick = () => { window.focus(); openNotifiedSession(target) }
        } catch {
          // 浏览器禁止桌面弹窗时静默降级
        }
      }
    }
  }

  function clearUnreadNotifyTitle() {
    unreadNotifyTitle.value = ''
  }

  return {
    nodes,
    coreWorkspaceRoute: fleetRoute,
    coreSignInUrl,
    signInToCoreFleet,
    nodesLoading,
    lastError,
    wsState,
    selectedNodeId,
    selectedNode,
    selectedProvider,
    availableProviders,
    activeSessionKey,
    sessionsByKey,
    allSessions,
    sessionsForCurrentNode,
    sessionListStates,
    currentSession,
    messagesBySession,
    currentMessages,
    pendingApprovalsList,
    nodesWithApprovalPending,
    runningBySession,
    currentIsStreaming,
    clearSessionMemory,
    loadNodes,
    registerNode,
    rotateNode,
    revokeNode,
    removeNode,
    connectSocket,
    disconnectSocket,
    handleWsEvent,
    dumpAuditLog,
    selectNode,
    selectProvider,
    composerDrafts,
    chatNodes,
    outbox,
    isOutboxTransmitting,
    cancelDeferredPrompt,
    runSettings,
    catalogs,
    agentsByTarget,
    mcpByTarget,
    rulesByTarget,
    skillsByTarget,
    filePreviewBySession,
    fileTextCacheBySession,
    pendingFormsById,
    treeCacheByTarget,
    trustPatternsByNode,
    terminalBySession,
    terminalPreviews,
    requestTerminalPreview,
    bookmarkedIdsBySession,
    diffAnnotationsBySession,
    unreadCountBySession,
    firstUnreadMsgIdBySession,
    interruptedBySession,
    stopStatusBySession,
    sideChatSessionKeyByParent,
    projectPermissionsByNode,
    requestProjectPermissions,
    saveProjectPermission,
    supportsProjectPermissions,
    sendShortcut,
    soundEnabled,
    notificationsEnabled,
    notificationSessionKey,
    unreadNotifyTitle,
    tokenUsageBySession,
    recordedTokenUsage: recordedUsage.entries,
    usageOrigin,
    loadTokenUsage,
    subscriptionQuotas,
    subscriptionQuotaLoading,
    refreshSubscriptionQuota,
    todosBySession,
    currentTodos,
    diffBySession,
    currentDiff,
    checkpointsBySession,
    currentCheckpoints,
    filesCacheByTarget,
    queuedPromptsBySession,
    currentQueue,
    imagePreviewByArtifactId,
    requestModels(nodeId: string, provider: AdapterProvider) {
      return sendWsCommand({ type: 'models.list', nodeId, provider, requestId: createRequestId() })
    },
    requestAgents,
    requestMcpServers,
    mcpErrorsByTarget,
    requestRules,
    requestSkills,
    requestFileContent,
    downloadWorkspaceFile,
    saveWorkspaceFile,
    requestFileBlame,
    requestDiffFileContext,
    closeFilePreview,
    revertFiles,
    mergeSessionWorktree,
    replyForm,
    subscribeSession,
    markSessionRead,
    setSessionViewVisible,
    requestOlderHistory,
    searchOlderHistory,
    historyCursorBySession,
    historyStateBySession,
    deviceSessionScope: localCacheScope,
    pendingHistoryPages,
    pendingStreamResync,
    lastSeqBySession,
    streamStateBySession,
    isSessionStreaming,
    contextUsageBySession,
    contextCompactions,
    requestContextUsage,
    applyDefaultModelPref,
    sessionPromptOptions,
    setModelPreference,
    setSessionModel,
    setSessionEffort,
    pendingSessionEffort,
    requestSessionsList,
    openSession,
    activateSession,
    loadSessionHistory,
    reportFollowIntent,
    cancelSnapshotFollow,
    forgetFollowIntent,
    snapshotRestorePending,
    snapshotRestoreVersion,
    sendPromptToSpecificSession,
    sendPrompt,
    enqueuePrompt,
    removeQueuedPrompt,
    updateQueuedPrompt,
    reorderQueuedPrompt,
    steerPromptToSession,
    steerQueuedPrompt,
    continueInterruptedRun,
    addDiffAnnotation,
    toggleDiffAnnotationResolved,
    removeDiffAnnotation,
    clearResolvedDiffAnnotations,
    sendDiffAnnotationsToAgent,
    openOrSendSideChat,
    requestFilesList,
    requestSessionDiff,
    revertCheckpoint,
    compactSession,
    renameSession,
    deleteSession,
    editMessageAndBranch,
    regenerateAssistantMessage,
    switchBranch,
    forkSessionFromMessage,
    exportSessionMarkdown,
    exportSessionHtml,
    requestWorkspaceTree,
    revertDiffHunk,
    commitWorkspaceChanges,
    requestTrustPolicies,
    addTrustPattern,
    removeTrustPattern,
    openTerminal,
    sendTerminalInput,
    sendTerminalSignal,
    resizeTerminal,
    closeTerminal,
    toggleMessageBookmark,
    toggleDesktopNotifications,
    toggleSoundCues,
    toggleSendShortcut,
    openExternalTarget,
    clearUnreadNotifyTitle,
    cancelSessionRun,
    cancelActiveRun,
    respondPermission,
    sendHandoff,
    sendFanout,
    ensureArtifactImagePreview,
    downloadArtifactToBrowser,
    readHermesAttachment,
  }
})
