import assert from 'node:assert/strict'
import test from 'node:test'
import vue from '@vitejs/plugin-vue'
import { createPinia, disposePinia } from 'pinia'
import { createServer } from 'vite'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { formatWorkLogDuration, readTurnTestResult } from '../src/services/chatHelpers.ts'
import { mapEpochSnapshotMessage } from '../src/services/epochSnapshot.ts'
import { buildThreadRenderItems } from '../src/services/messageSegments.ts'
import { createSessionSync, readSyncMode } from '../src/services/sessionSync.ts'

const snapshot = { messages: [{ role: 'assistant', text: '回答' }] }
const event = (seq, text = String(seq)) => ({ seq, text })
const opened = (epoch = 'one', lastSeq = 2) => ({ epoch, lastSeq, snapshot })
const page = (events, hasMore = false, epoch = 'one') => ({ epoch, events, hasMore })
const openRequest = sessionKey => ['session.snapshot', { sessionKey }]
const since = (sessionKey, lastSeq, epoch = 'one') => ['session.events.since', { sessionKey, epoch, lastSeq, limit: 500 }]

test('epoch snapshots preserve every tool in the existing work log with client statuses', () => {
  const toolCalls = [
    { callId: 'one', name: 'bash', status: 'completed', durationMs: 1234, input: 'node --test', output: '# pass 2\n# fail 0' },
    { callId: 'two', name: 'write', status: 'error', durationMs: null, output: 'permission denied' },
    { callId: 'three', name: 'read', status: 'failed' },
    { callId: 'four', name: 'bash', status: 'running' },
    { callId: 'five', name: 'search', status: 'queued' },
  ]
  const context = { session: { nodeId: 'node', provider: 'hermes' }, fallbackId: 'history-1', fallbackCreatedAt: 123 }
  const row = { role: 'assistant', text: '回答', turnId: 'turn', durationMs: null, toolCalls }
  for (const parts of [undefined, [{ type: 'tool', callId: 'one' }, { type: 'text', text: row.text }]]) {
    const message = mapEpochSnapshotMessage({ ...row, parts }, context)
    assert.equal(message.epochSnapshot, true)
    assert.equal(message.runId, 'turn')
    assert.equal(Object.hasOwn(message, 'durationMs'), false)
    assert.equal(message.toolCalls.length, toolCalls.length)
    assert.deepEqual(message.toolCalls.map(tool => tool.status), ['success', 'error', 'error', 'running', 'running'])
    assert.equal(message.toolCalls[0].durationMs, 1234)
    assert.equal(message.toolCalls[1].output, 'permission denied')
    assert.equal(Object.hasOwn(message.toolCalls[1], 'durationMs'), false)
    assert.deepEqual(readTurnTestResult(message.toolCalls), { passed: 2, failed: 0, successful: true })
    const steps = buildThreadRenderItems(message).flatMap(item => item.type === 'work-log' ? item.steps : [])
    assert.deepEqual(steps.filter(step => step.type === 'tool').map(step => step.callId), toolCalls.map(tool => tool.callId))
  }
  assert.equal(mapEpochSnapshotMessage({ ...row, durationMs: 1234 }, context).durationMs, 1234)
})

test('Fleet filters empty assistant turns at epoch projection', async t => {
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true },
  })
  t.after(() => server.close())
  const { useFleetStore, sessionKey } = await server.ssrLoadModule('/src/stores/fleet.ts')
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => ({ 'studiolo:access-token': 'token', 'studiolo.syncMode': 'epoch' })[key] ?? null,
    removeItem() {},
  } })
  t.after(() => {
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage)
    else delete globalThis.localStorage
  })
  const pinia = createPinia()
  t.after(() => disposePinia(pinia))
  const fleet = useFleetStore(pinia)
  const session = { nodeId: 'node', provider: 'codex', sessionId: 'empty', title: '测试', cwd: '' }
  const key = sessionKey(session.nodeId, session.provider, session.sessionId)
  fleet.sessionsByKey = { [key]: session }
  fleet.wsState = 'online'
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ...opened(), snapshot: {
    lastSeq: 2,
    messages: [
      { role: 'assistant', turnId: 'empty', text: '', toolCalls: [], thought: '' },
      { role: 'assistant', turnId: 'whitespace', text: ' ', parts: [{ type: 'thought', text: '\n ' }] },
    ],
  } }))
  assert.equal(fleet.subscribeSession(key), true)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(fleet.messagesBySession[key], [])
  assert.equal(fleet.historyStateBySession[key]?.state, 'empty')
})

test('epoch message duration omits missing or nonpositive values and keeps the existing format', () => {
  for (const durationMs of [undefined, null, 0, -1, NaN, Infinity]) {
    assert.equal(formatWorkLogDuration(durationMs), '')
  }
  assert.equal(formatWorkLogDuration(300), '用时 300 毫秒')
  assert.equal(formatWorkLogDuration(1234), '用时 1.2 秒')
  assert.equal(formatWorkLogDuration(60_000), '用时 1 分钟')
  assert.equal(formatWorkLogDuration(62_000), '用时 1 分钟 2 秒')
})

function fixture(responses, mode = 'epoch') {
  const calls = []
  const applied = []
  const appended = []
  const sync = createSessionSync({
    mode,
    async rpc(method, params) {
      calls.push([method, params])
      assert.ok(responses.length, 'unexpected RPC')
      const response = responses.shift()
      if (response instanceof Error) throw response
      return response
    },
    apply: (key, value) => applied.push([key, value]),
    append: (key, events) => appended.push([key, events]),
  })
  return { sync, calls, applied, appended }
}

test('open projects the snapshot and records its cursor', async () => {
  const { sync, calls, applied, appended } = fixture([opened()])
  await sync.open('a')
  assert.deepEqual(calls, [openRequest('a')])
  assert.deepEqual(applied, [['a', snapshot]])
  assert.deepEqual(appended, [])
})

test('resume projects only events above lastSeq in ascending order', async () => {
  const { sync, calls, appended } = fixture([opened(), page([event(5), event(2), event(1), event(3)])])
  await sync.open('a')
  await sync.resume('a')
  assert.deepEqual(calls, [openRequest('a'), since('a', 2)])
  assert.deepEqual(appended, [['a', [event(3), event(5)]]])
})

test('resume reads every page using the last projected sequence', async () => {
  const { sync, calls, appended } = fixture([opened(), page([event(3), event(4)], true), page([event(4), event(6)])])
  await sync.open('a')
  await sync.resume('a')
  assert.deepEqual(calls, [openRequest('a'), since('a', 2), since('a', 4)])
  assert.deepEqual(appended, [['a', [event(3), event(4)]], ['a', [event(6)]]])
})

test('a new epoch replaces the projection and resets the previous sequence', async () => {
  const { sync, calls, applied, appended } = fixture([
    opened('one', 93), page([event(94)], false, 'two'), opened('two', 0), page([event(1)], false, 'two'),
  ])
  await sync.open('a')
  await sync.resume('a')
  await sync.resume('a')
  assert.deepEqual(calls, [openRequest('a'), since('a', 93), openRequest('a'), since('a', 0, 'two')])
  assert.deepEqual(applied, [['a', snapshot], ['a', snapshot]])
  assert.deepEqual(appended, [['a', [event(1)]]])
})

test('an incomplete snapshot rejects with a per-session fallback hint', async () => {
  const { sync, applied, appended } = fixture([{ code: 'replay_incomplete' }, opened(), page([event(3)])])
  await assert.rejects(sync.open('a'), /replay_incomplete.*legacy/)
  await sync.open('b')
  await sync.syncAll()
  assert.deepEqual(applied, [['b', snapshot]])
  assert.deepEqual(appended, [['b', [event(3)]]])
})

test('duplicate events within a page and later requests are dropped', async () => {
  const { sync, calls, appended } = fixture([
    opened(), page([event(3, 'first'), event(3, 'duplicate')]), page([event(3), event(4)]),
  ])
  await sync.open('a')
  await Promise.all([sync.resume('a'), sync.resume('a')])
  assert.deepEqual(calls, [openRequest('a'), since('a', 2), since('a', 3)])
  assert.deepEqual(appended, [['a', [event(3, 'first')]], ['a', [event(4)]]])
})

test('failed RPCs reject and retry from the last successfully applied page', async () => {
  const offline = new Error('network offline')
  const { sync, calls, appended } = fixture([
    opened(), page([event(3)], true), offline, { ok: false, code: 'node_offline' }, page([event(4)]),
  ])
  await sync.open('a')
  await assert.rejects(sync.resume('a'), error => error === offline)
  await assert.rejects(sync.resume('a'), /node_offline/)
  await sync.resume('a')
  assert.deepEqual(calls, [openRequest('a'), since('a', 2), since('a', 3), since('a', 3), since('a', 3)])
  assert.deepEqual(appended, [['a', [event(3)]], ['a', [event(4)]]])
})

test('legacy mode never calls the replay RPCs', async () => {
  const { sync, calls } = fixture([], 'legacy')
  await sync.open('a')
  await sync.resume('a')
  await sync.syncAll()
  assert.deepEqual(calls, [])
})

test('the sync mode defaults to legacy and accepts explicit storage or URL opt-in', t => {
  let stored = 'unknown'
  const url = { search: '' }
  for (const [name, value] of Object.entries({ localStorage: { getItem: () => stored }, location: url })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)
    Object.defineProperty(globalThis, name, { configurable: true, value })
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    })
  }
  assert.equal(readSyncMode(), 'legacy')
  stored = 'epoch'
  assert.equal(readSyncMode(), 'epoch')
  stored = 'legacy'
  url.search = '?syncMode=epoch'
  assert.equal(readSyncMode(), 'epoch')
})

test('Fleet opts in on its auth frame and falls back for only the incomplete session', async t => {
  const server = await createServer({
    configFile: false,
    plugins: [vue()],
    server: { middlewareMode: true, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true },
  })
  t.after(() => server.close())
  const { useFleetStore, sessionKey } = await server.ssrLoadModule('/src/stores/fleet.ts')
  const { default: WorkLog } = await server.ssrLoadModule('/src/components/chat/WorkLog.vue')
  const pinia = createPinia()
  const requests = []
  const sent = []
  let socket
  class MockSocket {
    static OPEN = 1
    readyState = MockSocket.OPEN
    constructor() { socket = this }
    send(raw) { sent.push(JSON.parse(raw)) }
    close() {}
  }
  t.mock.method(globalThis, 'fetch', async (url, { body }) => {
    const params = JSON.parse(body)
    requests.push([url, params])
    if (params.sessionId === 'incomplete') return Response.json({ code: 'replay_incomplete' })
    return Response.json({ ...opened('one', 0), snapshot: { lastSeq: 0, messages: [{
      ...snapshot.messages[0], durationMs: null,
      toolCalls: [
        { callId: 'one', name: 'bash', status: 'completed', output: 'fixture output', durationMs: null },
        { callId: 'two', name: 'bash', status: 'failed', output: 'fixture error', durationMs: 1234 },
      ],
    }] } })
  })
  for (const [name, value] of Object.entries({
    WebSocket: MockSocket,
    localStorage: {
      getItem: key => ({ 'studiolo:access-token': 'token', 'studiolo.syncMode': 'epoch' })[key] ?? null,
      removeItem() {},
    },
  })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)
    Object.defineProperty(globalThis, name, { configurable: true, value })
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    })
  }
  const fleet = useFleetStore(pinia)
  t.after(() => { fleet.disconnectSocket(); disposePinia(pinia) })
  const session = sessionId => ({ nodeId: 'node', provider: 'hermes', sessionId, title: '测试', cwd: '' })
  const incomplete = sessionKey('node', 'hermes', 'incomplete')
  const complete = sessionKey('node', 'hermes', 'complete')
  fleet.sessionsByKey = { [incomplete]: session('incomplete'), [complete]: session('complete') }
  fleet.connectSocket()
  socket.onopen()
  assert.deepEqual(sent, [{ type: 'auth', token: 'token', capabilities: ['session.events.v1'] }])
  fleet.handleWsEvent({ type: 'FleetSnapshot', nodes: [] })
  fleet.handleWsEvent({ type: 'Ready', serverCapabilities: ['session.events.v1'] })
  assert.equal(fleet.subscribeSession(incomplete), true)
  assert.equal(fleet.subscribeSession(complete), true)
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(requests, ['incomplete', 'complete'].map(sessionId => [
    '/api/v1/fleet/nodes/node/session/snapshot', { sessionId, provider: 'hermes' },
  ]))
  const [message] = fleet.messagesBySession[complete]
  assert.equal(message.text, '回答')
  assert.equal(message.durationMs, undefined)
  assert.deepEqual(message.toolCalls.map(tool => [tool.status, tool.durationMs]), [['success', undefined], ['error', 1234]])
  const log = buildThreadRenderItems(message).find(item => item.type === 'work-log')
  const renderLog = (durationMs, reveal) => renderToString(createSSRApp(WorkLog, {
    steps: log.steps, epochSnapshot: message.epochSnapshot, durationMs, reveal,
  }).use(pinia))
  const html = await renderLog(message.durationMs)
  assert.equal((html.match(/class="tool-card is-/g) ?? []).length, 2)
  assert.match(html, /工作步骤/)
  assert.doesNotMatch(html, /用时/)
  const renderTransition = syncMode => renderToString(createSSRApp(WorkLog, {
    steps: [{ type: 'thought', text: '有思考', id: 'thought' }], epochSnapshot: false, syncMode,
  }).use(pinia))
  const transition = await renderTransition('epoch')
  assert.match(transition, /工作步骤/)
  assert.doesNotMatch(transition, /用时未记录/)
  assert.match(await renderTransition('legacy'), /用时未记录/)
  const withoutToolDuration = await renderLog(undefined, { stepId: log.steps[0].id })
  assert.match(withoutToolDuration, /fixture output/)
  assert.doesNotMatch(withoutToolDuration, /class="num"/)
  const withDurations = await renderLog(1500, { stepId: log.steps[1].id })
  assert.match(withDurations, /用时 1\.5 秒/)
  assert.match(withDurations, /1\.2s/)
  assert.deepEqual(sent.filter(frame => frame.type === 'session.subscribe'), [])
  const history = sent.find(frame => frame.type === 'session.history')
  assert.equal(history.sessionId, 'incomplete')
  fleet.handleWsEvent({ type: 'SessionHistory', ...session('incomplete'), requestId: history.requestId,
    messages: [{ id: 'legacy', role: 'assistant', text: '旧历史' }] })
  assert.equal(fleet.messagesBySession[incomplete][0].text, '旧历史')
  fleet.subscribeSession(incomplete)
  assert.equal(requests.length, 2)
  assert.equal(sent.filter(frame => frame.type === 'session.history').length, 2)
})
