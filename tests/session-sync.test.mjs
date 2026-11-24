import assert from 'node:assert/strict'
import test from 'node:test'
import { createPinia, disposePinia } from 'pinia'
import { createServer } from 'vite'
import { createSessionSync, readSyncMode } from '../src/services/sessionSync.ts'

const snapshot = { messages: [{ role: 'assistant', text: '回答' }] }
const event = (seq, text = String(seq)) => ({ seq, text })
const opened = (epoch = 'one', lastSeq = 2) => ({ epoch, lastSeq, snapshot })
const page = (events, hasMore = false, epoch = 'one') => ({ epoch, events, hasMore })
const openRequest = sessionKey => ['session.snapshot', { sessionKey }]
const since = (sessionKey, lastSeq, epoch = 'one') => ['session.events.since', { sessionKey, epoch, lastSeq, limit: 500 }]

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
    server: { middlewareMode: true, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true },
  })
  t.after(() => server.close())
  const { useFleetStore, sessionKey } = await server.ssrLoadModule('/src/stores/fleet.ts')
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
    return Response.json(params.sessionId === 'incomplete' ? { code: 'replay_incomplete' } : opened())
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
  assert.equal(fleet.messagesBySession[complete][0].text, '回答')
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
