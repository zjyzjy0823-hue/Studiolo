import test from 'node:test'
import assert from 'node:assert/strict'
import { createPinia, disposePinia } from 'pinia'
import { createServer } from 'vite'
import { createRenderer } from 'vue'
import {
  createConnectionHealthMonitor,
  createSyncLoopController,
  HEARTBEAT_INTERVAL_MS,
  MIN_SYNC_FALLBACK_INTERVAL_MS,
  PROBE_TIMEOUT_MS,
  STALE_TIMEOUT_MS,
} from '../src/services/connectionHealth.ts'

function createFakeClock() {
  let now = 0
  let nextId = 0
  const timers = new Map()

  const timersApi = {
    setTimeout(callback, ms) {
      const id = ++nextId
      timers.set(id, { callback, at: now + Math.max(0, ms) })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    now() {
      return now
    },
  }

  async function flushMicrotasks() {
    for (let i = 0; i < 12; i++) {
      if (typeof setImmediate === 'function') {
        await new Promise(resolve => setImmediate(resolve))
      } else {
        await Promise.resolve()
      }
    }
  }

  async function advance(ms) {
    const target = now + ms
    while (true) {
      let earliest = null
      for (const [id, entry] of timers) {
        if (entry.at <= target && (!earliest || entry.at < earliest.at || (entry.at === earliest.at && id < earliest.id))) {
          earliest = { id, ...entry }
        }
      }
      if (!earliest) break
      now = earliest.at
      timers.delete(earliest.id)
      earliest.callback()
      await flushMicrotasks()
    }
    now = target
    await flushMicrotasks()
  }

  return { timersApi, advance, pendingCount: () => timers.size, now: () => now }
}

function createFakeTarget(extra = {}) {
  const listeners = new Map()
  return {
    ...extra,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(listener)
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener)
    },
    dispatch(type) {
      for (const listener of [...(listeners.get(type) ?? [])]) {
        if (typeof listener === 'function') listener({ type })
        else listener.handleEvent({ type })
      }
    },
    listenerCount(type) {
      return listeners.get(type)?.size ?? 0
    },
  }
}

test('心跳：15 秒定时触发，收到帧重置 60 秒陈旧计时；60 秒无帧判定陈旧并只触发一次重连', async () => {
  const clock = createFakeClock()
  const pings = []
  const staleReasons = []
  let online = true

  const monitor = createConnectionHealthMonitor({
    timers: clock.timersApi,
    windowTarget: null,
    documentTarget: null,
    isOnline: () => online,
    sendPing: id => {
      pings.push({ id, at: clock.now() })
      return true
    },
    onStale: reason => {
      online = false
      staleReasons.push({ reason, at: clock.now() })
    },
  })

  assert.equal(HEARTBEAT_INTERVAL_MS, 15_000)
  assert.equal(STALE_TIMEOUT_MS, 60_000)
  assert.equal(PROBE_TIMEOUT_MS, 5_000)

  monitor.markConnected()

  // 前 15s 内收到 Pong 回执，延长陈旧窗口
  await clock.advance(14_999)
  assert.equal(pings.length, 0)
  await clock.advance(1)
  assert.equal(pings.length, 1)
  assert.equal(pings[0].at, 15_000)

  monitor.noteFrame({ type: 'Pong', requestId: pings[0].id })
  await clock.advance(45_000)
  // 距离 t=15_000 收到 Pong 过去了 45s，尚未到 60s，不应判陈旧
  assert.equal(staleReasons.length, 0)
  assert.equal(pings.length, 4) // 15s, 30s, 45s, 60s

  // 再无任何帧到达，到 t=75_000（距上次帧正好 60s）触发一次 stale_timeout
  await clock.advance(14_999)
  assert.equal(staleReasons.length, 0)
  await clock.advance(1)
  assert.deepEqual(staleReasons, [{ reason: 'stale_timeout', at: 75_000 }])

  // 触发陈旧后所有定时器已清理，不会重复触发
  await clock.advance(120_000)
  assert.equal(staleReasons.length, 1)
  assert.equal(clock.pendingCount(), 0)
  monitor.dispose()
})

test('换网与切前台：online/visibilitychange 触发 5 秒活性探测，成功不置重连，超时才重连且去重', async () => {
  const clock = createFakeClock()
  const win = createFakeTarget()
  const doc = createFakeTarget({ hidden: false })
  const pings = []
  const staleReasons = []
  let online = true

  const monitor = createConnectionHealthMonitor({
    timers: clock.timersApi,
    windowTarget: win,
    documentTarget: doc,
    isOnline: () => online,
    sendPing: id => {
      pings.push({ id, at: clock.now() })
      return true
    },
    onStale: reason => {
      online = false
      staleReasons.push({ reason, at: clock.now() })
    },
  })

  monitor.attach()
  monitor.markConnected()

  // 1) online 事件 -> 立即发一次探测；同时触发 visibilitychange 去重不重复发包
  win.dispatch('online')
  doc.dispatch('visibilitychange')
  assert.equal(pings.length, 1)
  assert.equal(monitor.isProbing(), true)

  // 2) 5 秒内收到 Pong -> 探测成功，不进入重连
  await clock.advance(2_000)
  monitor.noteFrame({ type: 'Pong', requestId: pings[0].id })
  assert.equal(monitor.isProbing(), false)
  await clock.advance(5_000)
  assert.equal(staleReasons.length, 0)
  assert.equal(online, true)

  // 3) 切后台不探测，切回前台触发一次 5 秒探测；5 秒无回执才触发 probe_timeout
  doc.hidden = true
  doc.dispatch('visibilitychange')
  assert.equal(monitor.isProbing(), false)
  const pingsBeforeForeground = pings.length

  doc.hidden = false
  doc.dispatch('visibilitychange')
  assert.equal(pings.length, pingsBeforeForeground + 1)
  assert.equal(monitor.isProbing(), true)

  await clock.advance(4_999)
  assert.equal(staleReasons.length, 0)
  await clock.advance(1)
  assert.equal(staleReasons.length, 1)
  assert.equal(staleReasons[0].reason, 'probe_timeout')

  monitor.dispose()
  assert.equal(win.listenerCount('online'), 0)
  assert.equal(win.listenerCount('offline'), 0)
  assert.equal(doc.listenerCount('visibilitychange'), 0)
})

test('空转轮询：空闲 60 秒内 sync/changes 调用 ≤ 3；document.hidden 时 0 次且回前台事件驱动恢复', async () => {
  const clock = createFakeClock()
  const win = createFakeTarget()
  const doc = createFakeTarget({ hidden: false })
  const calls = []

  // 即使外部传入低于 30s 的高频间隔，也会被钳制到 ≥ 30s
  const loop = createSyncLoopController({
    timers: clock.timersApi,
    windowTarget: win,
    documentTarget: doc,
    fallbackIntervalMs: 2_000,
    isOnline: () => true,
    runSync: async () => {
      calls.push({ url: '/api/v1/sync/changes', at: clock.now() })
    },
  })

  assert.equal(loop.intervalMs, MIN_SYNC_FALLBACK_INTERVAL_MS)
  assert.ok(loop.intervalMs >= 30_000)

  // 1) 空闲 60 秒：仅兜底触发 ≤ 3 次（30s、60s 共 2 次）
  loop.start()
  await clock.advance(60_000)
  assert.ok(calls.length <= 3, `expected <= 3 calls in 60s idle, got ${calls.length}`)
  assert.deepEqual(calls.map(item => item.at), [30_000, 60_000])

  // 2) 切到后台（document.hidden = true）：暂停轮询，推进 120 秒为 0 次
  calls.length = 0
  doc.hidden = true
  doc.dispatch('visibilitychange')
  assert.equal(clock.pendingCount(), 0)
  await clock.advance(120_000)
  assert.equal(calls.length, 0)

  // 后台期间手动 trigger 与 online 均不发起请求
  loop.trigger()
  win.dispatch('online')
  await clock.advance(60_000)
  assert.equal(calls.length, 0)

  // 3) 回到前台：事件驱动立即拉取 1 次，且重置 30s 兜底（60 秒总计 ≤ 3 次）
  doc.hidden = false
  doc.dispatch('visibilitychange')
  await clock.advance(0)
  assert.equal(calls.length, 1)
  await clock.advance(60_000)
  assert.ok(calls.length <= 3, `expected <= 3 calls across 60s after resume, got ${calls.length}`)
  assert.equal(calls.length, 3)

  loop.stop()
  assert.equal(clock.pendingCount(), 0)
  assert.equal(win.listenerCount('online'), 0)
  assert.equal(doc.listenerCount('visibilitychange'), 0)
})

test('Fleet Store 集成：心跳/陈旧重连、换网探测不闪屏、恢复后回到 online 不重复触发', async t => {
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true },
  })
  t.after(() => server.close())

  const { useFleetStore } = await server.ssrLoadModule('/src/stores/fleet.ts')
  const sockets = []
  class MockSocket {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSED = 3
    readyState = MockSocket.OPEN
    sent = []
    closed = []
    constructor(url) {
      this.url = url
      sockets.push(this)
    }
    send(raw) {
      this.sent.push(JSON.parse(raw))
    }
    close(code, reason) {
      this.readyState = MockSocket.CLOSED
      this.closed.push({ code, reason })
      this.onclose?.({ code: code ?? 1000 })
    }
  }

  const fakeWin = createFakeTarget({
    localStorage: { getItem: key => (key === 'studiolo:access-token' ? 'test-token' : null), setItem() {}, removeItem() {} },
    sessionStorage: { removeItem() {} },
  })
  const fakeDoc = createFakeTarget({ hidden: false })

  const originalSocket = globalThis.WebSocket
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')

  globalThis.WebSocket = MockSocket
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWin })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDoc })
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: fakeWin.localStorage })

  t.after(() => {
    globalThis.WebSocket = originalSocket
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete globalThis.window
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
    else delete globalThis.document
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage)
    else delete globalThis.localStorage
  })

  await t.test('15 秒心跳与 60 秒无帧陈旧重连：不弹 lastError，恢复后回 online 且不重复重连', t => {
    sockets.length = 0
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const pinia = createPinia()
    const fleet = useFleetStore(pinia)
    t.after(() => {
      fleet.disconnectSocket()
      disposePinia(pinia)
    })

    fleet.connectSocket()
    assert.equal(sockets.length, 1)
    fleet.handleWsEvent({ type: 'FleetSnapshot', nodes: [] })
    assert.equal(fleet.wsState, 'online')
    assert.equal(fleet.lastError, null)

    // 15 秒触发一次 node.ping
    t.mock.timers.tick(15_000)
    const pings1 = sockets[0].sent.filter(frame => frame.type === 'node.ping')
    assert.equal(pings1.length, 1)
    assert.ok(pings1[0].requestId)

    // 心跳返回 Error 帧也不弹 lastError
    fleet.handleWsEvent({ type: 'Error', requestId: pings1[0].requestId, message: 'ignore heartbeat error' })
    assert.equal(fleet.lastError, null)

    // 连续 60 秒无任何帧 -> 判陈旧，主动断开旧 socket 并切入 reconnecting 打开新 socket
    t.mock.timers.tick(59_999)
    assert.equal(fleet.wsState, 'online')
    assert.equal(sockets.length, 1)

    t.mock.timers.tick(1)
    assert.equal(fleet.wsState, 'reconnecting')
    assert.equal(fleet.lastError, null)
    assert.equal(sockets[0].closed.length, 1)
    assert.equal(sockets.length, 2)

    // 新连接恢复 FleetSnapshot -> 状态回 online，不再重复建连
    fleet.handleWsEvent({ type: 'FleetSnapshot', nodes: [] })
    assert.equal(fleet.wsState, 'online')
    assert.equal(fleet.lastError, null)

    // 后续正常心跳有 Pong 回执 -> 持续 online，不会重复重连
    t.mock.timers.tick(15_000)
    const pings2 = sockets[1].sent.filter(frame => frame.type === 'node.ping')
    assert.equal(pings2.length, 1)
    fleet.handleWsEvent({ type: 'Pong', requestId: pings2[0].requestId })
    t.mock.timers.tick(50_000)
    assert.equal(fleet.wsState, 'online')
    assert.equal(sockets.length, 2)
  })

  await t.test('换网 online 触发 5 秒探测：成功不置 reconnecting，失败才进入重连并恢复 online', t => {
    sockets.length = 0
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const pinia = createPinia()
    const fleet = useFleetStore(pinia)
    t.after(() => {
      fleet.disconnectSocket()
      disposePinia(pinia)
    })

    fleet.connectSocket()
    fleet.handleWsEvent({ type: 'FleetSnapshot', nodes: [] })
    assert.equal(fleet.wsState, 'online')

    // 1) online 触发探测，5 秒内收到 Pong -> 始终 online，未置 reconnecting
    fakeWin.dispatch('online')
    assert.equal(fleet.wsState, 'online')
    const probe1 = sockets[0].sent.filter(frame => frame.type === 'node.ping')
    assert.equal(probe1.length, 1)

    t.mock.timers.tick(1_500)
    fleet.handleWsEvent({ type: 'Pong', requestId: probe1[0].requestId })
    t.mock.timers.tick(5_000)
    assert.equal(fleet.wsState, 'online')
    assert.equal(sockets.length, 1)

    // 2) 再次 online 探测但无回执 -> 5 秒超时后才进入 reconnecting 并建新连接
    fakeWin.dispatch('online')
    assert.equal(fleet.wsState, 'online')
    t.mock.timers.tick(4_999)
    assert.equal(fleet.wsState, 'online')
    assert.equal(sockets.length, 1)

    t.mock.timers.tick(1)
    assert.equal(fleet.wsState, 'reconnecting')
    assert.equal(fleet.lastError, null)
    assert.equal(sockets.length, 2)

    // 3) 恢复后回 online，再次 online 若探测成功不重复重连
    fleet.handleWsEvent({ type: 'FleetSnapshot', nodes: [] })
    assert.equal(fleet.wsState, 'online')

    fakeWin.dispatch('online')
    const probeAfterRecovery = sockets[1].sent.filter(frame => frame.type === 'node.ping')
    assert.equal(probeAfterRecovery.length, 1)
    fleet.handleWsEvent({ type: 'Pong', requestId: probeAfterRecovery[0].requestId })
    t.mock.timers.tick(5_000)
    assert.equal(fleet.wsState, 'online')
    assert.equal(sockets.length, 2)
  })
})

test('useCoreSync 在 document.hidden 时暂停状态轮询，回到前台后恢复', async t => {
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true },
  })
  t.after(() => server.close())

  const { useCoreSync, CORE_SYNC_STATUS_POLL_INTERVAL_MS } = await server.ssrLoadModule('/src/composables/useCoreSync.ts')
  const { useAuthStore } = await server.ssrLoadModule('/src/stores/auth.ts')

  const clock = createFakeClock()
  const fakeDoc = createFakeTarget({ hidden: false })
  const calls = []
  const original = {
    fetch: globalThis.fetch,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    localStorage: globalThis.localStorage,
    document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
  }

  globalThis.setTimeout = clock.timersApi.setTimeout
  globalThis.clearTimeout = clock.timersApi.clearTimeout
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
  Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDoc })
  globalThis.fetch = async path => {
    calls.push(String(path))
    const body = String(path).endsWith('/connection')
      ? { connected: true, coreUrl: 'http://127.0.0.1:8000', clientId: 'c', workspaceId: 'w', installationId: 'i', clientName: 'n', platform: 'macos', appVersion: '1', connectedAt: '2026-01-01T00:00:00Z' }
      : { enabled: true, running: false, connected: true, blocked: false, pending: 0, conflicts: 0, inFlight: 0, rejected: 0, cursor: 1, queueSeeded: true, lastAttemptAt: null, lastSuccessAt: null, nextRetryAt: null, lastError: null }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }

  const renderer = createRenderer({
    insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
    setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null, patchProp() {},
  })
  const pinia = createPinia()
  const auth = useAuthStore(pinia)
  auth.mode = 'local'
  auth.token = 'local-test-token'

  const app = renderer.createApp({
    setup() {
      useCoreSync(() => {})
      return () => null
    },
  })
  app.use(pinia)
  app.mount({})
  t.after(() => {
    app.unmount()
    disposePinia(pinia)
    globalThis.fetch = original.fetch
    globalThis.setTimeout = original.setTimeout
    globalThis.clearTimeout = original.clearTimeout
    globalThis.localStorage = original.localStorage
    if (original.document) Object.defineProperty(globalThis, 'document', original.document)
    else delete globalThis.document
  })

  await clock.advance(0)
  const initialCalls = calls.length
  assert.ok(initialCalls >= 2)

  // 切到后台：停止轮询，长时间推进无新增请求
  fakeDoc.hidden = true
  fakeDoc.dispatch('visibilitychange')
  await clock.advance(CORE_SYNC_STATUS_POLL_INTERVAL_MS * 10)
  assert.equal(calls.length, initialCalls)

  // 回到前台：立刻恢复轮询
  fakeDoc.hidden = false
  fakeDoc.dispatch('visibilitychange')
  await clock.advance(0)
  assert.equal(calls.length, initialCalls + 1)
})
