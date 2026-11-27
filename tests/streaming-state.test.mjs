import assert from 'node:assert/strict'
import test from 'node:test'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { createServer } from 'vite'

async function createFleetFixture(t, { syncMode = 'legacy' } = {}) {
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true },
  })
  t.after(() => server.close())
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const previousWindow = globalThis.window
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
    localStorage: globalThis.localStorage,
  }
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: key => ({ 'studiolo:access-token': 'token', 'studiolo.syncMode': syncMode })[key] ?? null,
      setItem() {},
      removeItem() {},
    },
  })
  const { useFleetStore, sessionKey, STREAM_STALE_MS } = await server.ssrLoadModule('/src/stores/fleet.ts')
  const pinia = createPinia()
  setActivePinia(pinia)
  const fleet = useFleetStore(pinia)
  t.after(() => {
    fleet.disconnectSocket()
    disposePinia(pinia)
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage)
    else delete globalThis.localStorage
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  })
  return { fleet, sessionKey, STREAM_STALE_MS, server, pinia }
}

test('1. 一个会话两条 assistant 消息都 streaming: true，收到 Completed（runId 命中第一条）→ 两条都变 false', async t => {
  const { fleet, sessionKey } = await createFleetFixture(t)
  const session = { nodeId: 'node-1', provider: 'codex', sessionId: 'sess-1', title: 'Test 1', cwd: '' }
  const key = sessionKey(session.nodeId, session.provider, session.sessionId)
  fleet.sessionsByKey = { [key]: session }
  fleet.runningBySession = { [key]: 'run-1' }
  fleet.messagesBySession = {
    [key]: [
      { id: 'msg-1', role: 'assistant', runId: 'run-1', text: 'reply 1', streaming: true, liveProgress: { type: 'text' } },
      { id: 'msg-2', role: 'assistant', runId: 'run-older', text: 'reply 2', streaming: true, liveProgress: { type: 'thought' } },
    ],
  }

  fleet.handleWsEvent({ ...session, type: 'Completed', runId: 'run-1' })

  assert.equal(fleet.messagesBySession[key][0].streaming, false)
  assert.equal(fleet.messagesBySession[key][0].liveProgress, undefined)
  assert.equal(fleet.messagesBySession[key][1].streaming, false)
  assert.equal(fleet.messagesBySession[key][1].liveProgress, undefined)
  assert.equal(fleet.isSessionStreaming(key), false)
})

test('2. Completed 的 runId 与任何消息都不匹配 → 仍然全部清零', async t => {
  const { fleet, sessionKey } = await createFleetFixture(t)
  const session = { nodeId: 'node-1', provider: 'codex', sessionId: 'sess-2', title: 'Test 2', cwd: '' }
  const key = sessionKey(session.nodeId, session.provider, session.sessionId)
  fleet.sessionsByKey = { [key]: session }
  fleet.runningBySession = { [key]: 'run-completed' }
  fleet.messagesBySession = {
    [key]: [
      { id: 'msg-1', role: 'assistant', runId: 'msg-run-1', text: 'reply 1', streaming: true },
      { id: 'msg-2', role: 'assistant', runId: 'msg-run-2', text: 'reply 2', streaming: true },
    ],
  }

  fleet.handleWsEvent({ ...session, type: 'Completed', runId: 'run-completed' })

  assert.equal(fleet.messagesBySession[key][0].streaming, false)
  assert.equal(fleet.messagesBySession[key][1].streaming, false)
  assert.equal(fleet.isSessionStreaming(key), false)
})

test('3. Failed 同样全部清零', async t => {
  const { fleet, sessionKey } = await createFleetFixture(t)
  const session = { nodeId: 'node-1', provider: 'codex', sessionId: 'sess-3', title: 'Test 3', cwd: '' }
  const key = sessionKey(session.nodeId, session.provider, session.sessionId)
  fleet.sessionsByKey = { [key]: session }
  fleet.runningBySession = { [key]: 'run-fail' }
  fleet.messagesBySession = {
    [key]: [
      { id: 'msg-1', role: 'assistant', runId: 'run-fail', text: 'reply 1', streaming: true },
      { id: 'msg-2', role: 'assistant', runId: 'run-other', text: 'reply 2', streaming: true },
    ],
  }

  fleet.handleWsEvent({ ...session, type: 'Failed', runId: 'run-fail', message: 'Execution error' })

  assert.equal(fleet.messagesBySession[key][0].streaming, false)
  assert.equal(fleet.messagesBySession[key][1].streaming, false)
  assert.equal(fleet.isSessionStreaming(key), false)
})

test('4. 无活回合 + 最后一帧 120s 前 + 仍有 streaming 消息 → isSessionStreaming() === false（且消息被 settle）', async t => {
  const { fleet, sessionKey, STREAM_STALE_MS } = await createFleetFixture(t)
  assert.equal(STREAM_STALE_MS, 90_000)
  const session = { nodeId: 'node-1', provider: 'codex', sessionId: 'sess-4', title: 'Test 4', cwd: '' }
  const key = sessionKey(session.nodeId, session.provider, session.sessionId)
  fleet.sessionsByKey = { [key]: session }
  delete fleet.runningBySession[key]
  fleet.messagesBySession = {
    [key]: [
      { id: 'msg-1', role: 'assistant', text: 'orphaned streaming message', streaming: true, liveProgress: { type: 'text' } },
    ],
  }
  fleet.lastFrameAtBySession[key] = Date.now() - 120_000

  assert.equal(fleet.isSessionStreaming(key), false)
  assert.equal(fleet.messagesBySession[key][0].streaming, false)
  assert.equal(fleet.messagesBySession[key][0].liveProgress, undefined)
})

test('5. 无活回合 + 最后一帧 5s 前 → isSessionStreaming() === true（不误杀）', async t => {
  const { fleet, sessionKey } = await createFleetFixture(t)
  const session = { nodeId: 'node-1', provider: 'codex', sessionId: 'sess-5', title: 'Test 5', cwd: '' }
  const key = sessionKey(session.nodeId, session.provider, session.sessionId)
  fleet.sessionsByKey = { [key]: session }
  delete fleet.runningBySession[key]
  fleet.messagesBySession = {
    [key]: [
      { id: 'msg-1', role: 'assistant', text: 'active stream message', streaming: true },
    ],
  }
  fleet.lastFrameAtBySession[key] = Date.now() - 5_000

  assert.equal(fleet.isSessionStreaming(key), true)
  assert.equal(fleet.messagesBySession[key][0].streaming, true)
})

test('6. 有活回合（runningBySession[sKey] 存在）+ streaming 消息 → true', async t => {
  const { fleet, sessionKey } = await createFleetFixture(t)
  const session = { nodeId: 'node-1', provider: 'codex', sessionId: 'sess-6', title: 'Test 6', cwd: '' }
  const key = sessionKey(session.nodeId, session.provider, session.sessionId)
  fleet.sessionsByKey = { [key]: session }
  fleet.runningBySession = { [key]: 'live-run' }
  fleet.messagesBySession = {
    [key]: [
      { id: 'msg-1', role: 'assistant', runId: 'live-run', text: 'still running', streaming: true },
    ],
  }
  fleet.lastFrameAtBySession[key] = Date.now() - 120_000

  assert.equal(fleet.isSessionStreaming(key), true)
  assert.equal(fleet.messagesBySession[key][0].streaming, true)
})

test('7. visibilitychange → visible 且 wsState !== online 时，对激活会话触发至少一次快照同步（用 spy 断言，不绑定内部实现细节）', async t => {
  const mockDoc = new EventTarget()
  mockDoc.visibilityState = 'hidden'
  const prevDoc = globalThis.document
  globalThis.document = mockDoc
  t.after(() => {
    if (prevDoc === undefined) delete globalThis.document
    else globalThis.document = prevDoc
  })

  const { fleet, sessionKey } = await createFleetFixture(t)
  const session = { nodeId: 'node-1', provider: 'codex', sessionId: 'sess-7', title: 'Test 7', cwd: '' }
  const key = sessionKey(session.nodeId, session.provider, session.sessionId)
  fleet.sessionsByKey = { [key]: session }
  fleet.activeSessionKey = key
  fleet.wsState = 'disconnected'

  const spy = t.mock.method(fleet, 'syncSessionSnapshot', () => {})

  // When visibilityState is hidden, dispatching event does not trigger snapshot
  mockDoc.dispatchEvent(new Event('visibilitychange'))
  assert.equal(spy.mock.calls.length, 0)

  // When visibilityState becomes visible and wsState !== 'online', triggers snapshot
  mockDoc.visibilityState = 'visible'
  mockDoc.dispatchEvent(new Event('visibilitychange'))
  assert.ok(spy.mock.calls.length >= 1)
  assert.equal(spy.mock.calls[0].arguments[0], key)

  // When wsState is online and idle time < 30s, does not trigger snapshot
  const callsBefore = spy.mock.calls.length
  fleet.wsState = 'online'
  fleet.lastFrameAtBySession[key] = Date.now()
  mockDoc.dispatchEvent(new Event('visibilitychange'))
  assert.equal(spy.mock.calls.length, callsBefore)

  // When wsState is online and idle time > 30s, triggers snapshot
  fleet.lastFrameAtBySession[key] = Date.now() - 35_000
  mockDoc.dispatchEvent(new Event('visibilitychange'))
  assert.equal(spy.mock.calls.length, callsBefore + 1)
  assert.equal(spy.mock.calls.at(-1).arguments[0], key)
})

test('8. settleSessionStreaming 幂等性：无 streaming 消息时不分配新数组', async t => {
  const { fleet, sessionKey } = await createFleetFixture(t)
  const session = { nodeId: 'node-1', provider: 'codex', sessionId: 'sess-8', title: 'Test 8', cwd: '' }
  const key = sessionKey(session.nodeId, session.provider, session.sessionId)
  fleet.messagesBySession = {
    [key]: [
      { id: 'msg-1', role: 'assistant', text: 'done', streaming: false },
    ],
  }
  const before = fleet.messagesBySession[key]

  fleet.settleSessionStreaming(key)
  assert.equal(fleet.messagesBySession[key], before, '无 streaming 时引用不得改变')
})

test('9. RunStopStatus 且 status === accepted 且 runningBySession 不存在时触发 settleSessionStreaming', async t => {
  const { fleet, sessionKey } = await createFleetFixture(t)
  const session = { nodeId: 'node-1', provider: 'codex', sessionId: 'sess-9', title: 'Test 9', cwd: '' }
  const key = sessionKey(session.nodeId, session.provider, session.sessionId)
  fleet.sessionsByKey = { [key]: session }
  delete fleet.runningBySession[key]
  fleet.messagesBySession = {
    [key]: [
      { id: 'msg-1', role: 'assistant', text: 'interrupted', streaming: true, liveProgress: { type: 'tool' } },
    ],
  }

  fleet.handleWsEvent({ ...session, type: 'RunStopStatus', status: 'accepted', requestId: 'stop-1' })
  assert.equal(fleet.messagesBySession[key][0].streaming, false)
  assert.equal(fleet.messagesBySession[key][0].liveProgress, undefined)
  assert.equal(fleet.isSessionStreaming(key), false)
})
