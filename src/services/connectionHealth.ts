/**
 * Fleet WebSocket 连接健康监控（应用层心跳、陈旧判定、换网/切前台活性探测）
 * 与事件驱动的同步循环调度器（禁止空闲高频空转，后台自动暂停）。
 */

export const HEARTBEAT_INTERVAL_MS = 15_000
export const STALE_TIMEOUT_MS = 60_000
export const PROBE_TIMEOUT_MS = 5_000
export const MIN_SYNC_FALLBACK_INTERVAL_MS = 30_000
export const DEFAULT_SYNC_FALLBACK_INTERVAL_MS = 30_000

const MAX_TRACKED_PING_IDS = 32

export interface TimerLike {
  setTimeout: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeout: (id: ReturnType<typeof setTimeout>) => void
  now: () => number
}

export interface NetworkEventTarget {
  addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void
  removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void
}

export interface VisibilityDocument extends NetworkEventTarget {
  readonly hidden: boolean
}

export type StaleReason = 'stale_timeout' | 'probe_timeout' | 'ping_send_failed'
export type ProbeReason = 'online' | 'offline' | 'visibility' | 'manual'

export interface ConnectionHealthOptions {
  /** 发送应用层 ping（如 `node.ping`）。返回 false 表示底层传输已不可发送。 */
  sendPing: (requestId: string) => boolean
  /** 当前连接是否处于 online 状态。 */
  isOnline: () => boolean
  /** 当前连接是否处于重连退避中（换网/回前台时可直接立即重连）。 */
  isReconnecting?: () => boolean
  /** 判定连接陈旧或探测失败时触发，由调用方静默推进重连状态机（不弹错误）。 */
  onStale: (reason: StaleReason) => void
  /** 已处于重连退避中且网络/前台恢复时立即触发重连。 */
  onReconnectNow?: () => void
  /** 可选 ping requestId 生成器。 */
  createPingId?: () => string
  heartbeatIntervalMs?: number
  staleTimeoutMs?: number
  probeTimeoutMs?: number
  timers?: Partial<TimerLike>
  windowTarget?: NetworkEventTarget | null
  documentTarget?: VisibilityDocument | null
}

export interface ConnectionHealthMonitor {
  attach: () => void
  detach: () => void
  markConnected: () => void
  markDisconnected: () => void
  noteFrame: (frame?: { type?: string; requestId?: string }) => void
  notePingSendFailed: (requestId?: string) => void
  consumeHeartbeatRequest: (requestId?: string) => boolean
  probe: (reason?: ProbeReason) => void
  isProbing: () => boolean
  dispose: () => void
}

function resolveTimers(overrides?: Partial<TimerLike>): TimerLike {
  return {
    setTimeout: overrides?.setTimeout ?? ((cb, ms) => globalThis.setTimeout(cb, ms)),
    clearTimeout: overrides?.clearTimeout ?? (id => globalThis.clearTimeout(id)),
    now: overrides?.now ?? (() => Date.now()),
  }
}

export function createConnectionHealthMonitor(options: ConnectionHealthOptions): ConnectionHealthMonitor {
  const timers = resolveTimers(options.timers)
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS
  const staleTimeoutMs = options.staleTimeoutMs ?? STALE_TIMEOUT_MS
  const probeTimeoutMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS

  const getWindow = (): NetworkEventTarget | null =>
    options.windowTarget !== undefined
      ? options.windowTarget
      : (typeof window !== 'undefined' && typeof window.addEventListener === 'function' ? window : null)

  const getDocument = (): VisibilityDocument | null =>
    options.documentTarget !== undefined
      ? options.documentTarget
      : (typeof document !== 'undefined' && typeof document.addEventListener === 'function' ? document : null)

  let attached = false
  let attachedWindow: NetworkEventTarget | null = null
  let attachedDocument: VisibilityDocument | null = null
  let connected = false
  let pingCounter = 0
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null
  let staleTimer: ReturnType<typeof setTimeout> | null = null
  let probeTimer: ReturnType<typeof setTimeout> | null = null
  let activeProbeId: string | null = null
  const trackedPingIds = new Set<string>()

  function nextPingId(): string {
    pingCounter += 1
    return options.createPingId ? options.createPingId() : `health-ping-${pingCounter}`
  }

  function trackPingId(id: string) {
    trackedPingIds.add(id)
    if (trackedPingIds.size > MAX_TRACKED_PING_IDS) {
      const oldest = trackedPingIds.values().next().value
      if (oldest !== undefined) trackedPingIds.delete(oldest)
    }
  }

  function clearHeartbeatTimer() {
    if (heartbeatTimer !== null) {
      timers.clearTimeout(heartbeatTimer)
      heartbeatTimer = null
    }
  }

  function clearStaleTimer() {
    if (staleTimer !== null) {
      timers.clearTimeout(staleTimer)
      staleTimer = null
    }
  }

  function clearProbeTimer() {
    if (probeTimer !== null) {
      timers.clearTimeout(probeTimer)
      probeTimer = null
    }
  }

  function clearAllTimers() {
    clearHeartbeatTimer()
    clearStaleTimer()
    clearProbeTimer()
    activeProbeId = null
  }

  function triggerStale(reason: StaleReason) {
    if (!connected) return
    connected = false
    clearAllTimers()
    trackedPingIds.clear()
    options.onStale(reason)
  }

  function scheduleStaleCheck() {
    clearStaleTimer()
    if (!connected) return
    staleTimer = timers.setTimeout(() => {
      staleTimer = null
      if (!connected) return
      triggerStale('stale_timeout')
    }, staleTimeoutMs)
  }

  function scheduleHeartbeat() {
    clearHeartbeatTimer()
    if (!connected) return
    heartbeatTimer = timers.setTimeout(() => {
      heartbeatTimer = null
      if (!connected || !options.isOnline()) return
      const pingId = nextPingId()
      trackPingId(pingId)
      let sent = false
      try {
        sent = options.sendPing(pingId)
      } catch {
        sent = false
      }
      if (!sent) {
        triggerStale('ping_send_failed')
        return
      }
      if (connected) scheduleHeartbeat()
    }, heartbeatIntervalMs)
  }

  function probe(reason: ProbeReason = 'manual') {
    if (connected && options.isOnline()) {
      // 已有进行中的活性探测时去重，避免重复发包或重置 5 秒超时。
      if (activeProbeId !== null) return
      const probeId = nextPingId()
      trackPingId(probeId)
      activeProbeId = probeId
      let sent = false
      try {
        sent = options.sendPing(probeId)
      } catch {
        sent = false
      }
      if (!sent) {
        activeProbeId = null
        triggerStale('ping_send_failed')
        return
      }
      clearProbeTimer()
      probeTimer = timers.setTimeout(() => {
        probeTimer = null
        if (!connected || activeProbeId !== probeId) return
        activeProbeId = null
        triggerStale('probe_timeout')
      }, probeTimeoutMs)
      return
    }
    if (reason !== 'offline' && options.isReconnecting?.()) {
      options.onReconnectNow?.()
    }
  }

  const handleOnline = () => {
    probe('online')
  }

  const handleOffline = () => {
    probe('offline')
  }

  const handleVisibilityChange = () => {
    const doc = attachedDocument ?? getDocument()
    if (doc && !doc.hidden) {
      probe('visibility')
    }
  }

  function attach() {
    if (attached) return
    attached = true
    attachedWindow = getWindow()
    attachedDocument = getDocument()
    attachedWindow?.addEventListener('online', handleOnline)
    attachedWindow?.addEventListener('offline', handleOffline)
    attachedDocument?.addEventListener('visibilitychange', handleVisibilityChange)
  }

  function detach() {
    if (!attached) return
    attached = false
    attachedWindow?.removeEventListener('online', handleOnline)
    attachedWindow?.removeEventListener('offline', handleOffline)
    attachedDocument?.removeEventListener('visibilitychange', handleVisibilityChange)
    attachedWindow = null
    attachedDocument = null
  }

  function markConnected() {
    connected = true
    clearProbeTimer()
    activeProbeId = null
    scheduleStaleCheck()
    scheduleHeartbeat()
  }

  function markDisconnected() {
    connected = false
    clearAllTimers()
    trackedPingIds.clear()
  }

  function noteFrame(frame?: { type?: string; requestId?: string }) {
    if (!connected) return
    scheduleStaleCheck()
    const requestId = frame?.requestId
    if (frame?.type === 'Pong' && requestId) {
      trackedPingIds.delete(requestId)
    }
    if (activeProbeId !== null) {
      const probeSatisfied =
        !frame ||
        frame.type === 'FleetSnapshot' ||
        (frame.type === 'Pong' && (!requestId || requestId === activeProbeId))
      if (probeSatisfied) {
        clearProbeTimer()
        activeProbeId = null
        scheduleHeartbeat()
      }
    }
  }

  function notePingSendFailed(requestId?: string) {
    if (!connected || !options.isOnline()) return
    if (requestId && activeProbeId === requestId) {
      triggerStale('ping_send_failed')
      return
    }
    if (!requestId || trackedPingIds.has(requestId)) {
      if (requestId) trackedPingIds.delete(requestId)
      triggerStale('ping_send_failed')
    }
  }

  function consumeHeartbeatRequest(requestId?: string): boolean {
    if (!requestId || !trackedPingIds.has(requestId)) return false
    trackedPingIds.delete(requestId)
    return true
  }

  function dispose() {
    markDisconnected()
    detach()
  }

  return {
    attach,
    detach,
    markConnected,
    markDisconnected,
    noteFrame,
    notePingSendFailed,
    consumeHeartbeatRequest,
    probe,
    isProbing: () => activeProbeId !== null,
    dispose,
  }
}

export interface SyncLoopOptions {
  /** 执行一次同步拉取/推送（允许返回 Promise）。 */
  runSync: () => Promise<void> | void
  /** 兜底同步间隔（毫秒），强制不低于 30_000ms。 */
  fallbackIntervalMs?: number
  /** 判断当前是否在线，默认读取 navigator.onLine。 */
  isOnline?: () => boolean
  /** 可注入定时器（供单测假时钟使用）。 */
  timers?: Partial<TimerLike>
  /** 可注入 window 事件源（监听 online）。 */
  windowTarget?: NetworkEventTarget | null
  /** 可注入 document 事件源（读取 hidden 并监听 visibilitychange）。 */
  documentTarget?: VisibilityDocument | null
}

export interface SyncLoopController {
  start: (runImmediately?: boolean) => void
  stop: () => void
  trigger: () => void
  isRunning: () => boolean
  readonly intervalMs: number
}

export function createSyncLoopController(options: SyncLoopOptions): SyncLoopController {
  const timers = resolveTimers(options.timers)
  const intervalMs = Math.max(
    MIN_SYNC_FALLBACK_INTERVAL_MS,
    options.fallbackIntervalMs ?? DEFAULT_SYNC_FALLBACK_INTERVAL_MS,
  )

  const getWindow = (): NetworkEventTarget | null =>
    options.windowTarget !== undefined
      ? options.windowTarget
      : (typeof window !== 'undefined' && typeof window.addEventListener === 'function' ? window : null)

  const getDocument = (): VisibilityDocument | null =>
    options.documentTarget !== undefined
      ? options.documentTarget
      : (typeof document !== 'undefined' && typeof document.addEventListener === 'function' ? document : null)

  let started = false
  let inFlight = false
  let queuedEvent = false
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null
  let attachedWindow: NetworkEventTarget | null = null
  let attachedDocument: VisibilityDocument | null = null

  function isHidden(): boolean {
    const doc = attachedDocument ?? getDocument()
    return Boolean(doc?.hidden)
  }

  function isOnline(): boolean {
    if (options.isOnline) return options.isOnline()
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return false
    return true
  }

  function clearFallback() {
    if (fallbackTimer !== null) {
      timers.clearTimeout(fallbackTimer)
      fallbackTimer = null
    }
  }

  function scheduleFallback() {
    clearFallback()
    if (!started || isHidden()) return
    fallbackTimer = timers.setTimeout(() => {
      fallbackTimer = null
      void execute('fallback')
    }, intervalMs)
  }

  async function execute(source: 'event' | 'fallback') {
    if (!started || isHidden()) {
      clearFallback()
      return
    }
    if (!isOnline()) {
      scheduleFallback()
      return
    }
    if (inFlight) {
      if (source === 'event') queuedEvent = true
      return
    }
    clearFallback()
    inFlight = true
    queuedEvent = false
    try {
      await options.runSync()
    } catch {
      // 同步错误由调用方自行记录，循环本身不抛出未捕获异常。
    } finally {
      inFlight = false
      if (started && !isHidden()) {
        if (queuedEvent && isOnline()) {
          queuedEvent = false
          void execute('event')
        } else {
          scheduleFallback()
        }
      }
    }
  }

  const handleOnline = () => {
    if (!started || isHidden()) return
    void execute('event')
  }

  const handleVisibilityChange = () => {
    if (!started) return
    if (isHidden()) {
      queuedEvent = false
      clearFallback()
      return
    }
    if (isOnline()) {
      void execute('event')
    } else {
      scheduleFallback()
    }
  }

  function start(runImmediately = false) {
    if (started) return
    started = true
    attachedWindow = getWindow()
    attachedDocument = getDocument()
    attachedWindow?.addEventListener('online', handleOnline)
    attachedDocument?.addEventListener('visibilitychange', handleVisibilityChange)
    if (isHidden()) return
    if (runImmediately && isOnline()) {
      void execute('event')
    } else {
      scheduleFallback()
    }
  }

  function trigger() {
    if (!started || isHidden() || !isOnline()) return
    void execute('event')
  }

  function stop() {
    if (!started) return
    started = false
    queuedEvent = false
    clearFallback()
    attachedWindow?.removeEventListener('online', handleOnline)
    attachedDocument?.removeEventListener('visibilitychange', handleVisibilityChange)
    attachedWindow = null
    attachedDocument = null
  }

  return {
    start,
    stop,
    trigger,
    isRunning: () => started,
    intervalMs,
  }
}
