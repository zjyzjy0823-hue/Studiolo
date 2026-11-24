import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import vue from '@vitejs/plugin-vue'
import { createPinia, disposePinia } from 'pinia'
import { createServer } from 'vite'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { createMessageCache } from '../src/services/messageCache.ts'

const switchKey = 'studiolo.localCache'
const scope = 'account'
const message = {
  id: 'message', role: 'assistant', text: '答复', thought: '思考',
  toolCalls: [{ id: 'tool', name: 'shell', title: '运行测试', toolKind: 'shell', status: 'completed', durationMs: 4 }],
  durationMs: 10, createdAt: 100, streaming: false,
}

function memoryStorage() {
  const records = new Map()
  return {
    getItem: key => records.get(key) ?? null,
    setItem: (key, value) => records.set(key, value),
    removeItem: key => records.delete(key),
    records,
  }
}

function fixture() {
  const storage = memoryStorage()
  const cache = createMessageCache({ indexedDB: () => undefined, localStorage: () => storage })
  return { cache, storage }
}

test('message cache round-trips its rendering fields and scopes session keys', async () => {
  const { cache } = fixture()
  await cache.write(scope, 'session', [message], 17, 'epoch-v1')
  const { createdAt, ...fields } = message
  const row = await cache.read(scope, 'session')
  assert.deepEqual(row, {
    updatedAt: row.updatedAt, lastSeq: 17, epoch: 'epoch-v1', messages: [{ ...fields, at: createdAt }],
  })
  assert.ok(row.updatedAt > 0)
  assert.equal(await cache.read('other-account', 'session'), undefined)
  await cache.write(scope, 'session', [], 18, null)
  assert.deepEqual((await cache.read(scope, 'session')).messages, [])
})

test('message cache retains the last 300 messages and the 30 most recently updated sessions', async () => {
  const { cache } = fixture()
  const messages = Array.from({ length: 400 }, (_, n) => ({ ...message, id: String(n) }))
  await cache.write(scope, 'session-0', messages, 0, null)
  assert.deepEqual((await cache.read(scope, 'session-0')).messages.map(row => row.id), messages.slice(-300).map(row => row.id))
  for (let n = 1; n < 40; n++) {
    if (n === 25) await cache.write(scope, 'session-0', [message], 0, null)
    await cache.write(scope, `session-${n}`, [message], 0, null)
  }
  const keys = await Promise.all(Array.from({ length: 40 }, (_, n) => cache.read(scope, `session-${n}`)))
  assert.deepEqual(keys.flatMap((value, n) => value ? [n] : []), [0, ...Array.from({ length: 29 }, (_, n) => n + 11)])
})

test('message cache omits live content, structured secrets, media payloads and recognized inline secrets', async () => {
  const { cache, storage } = fixture()
  const dataURL = 'data:image/png;base64,aGVsbG8='
  const rawBase64 = 'aGVsbG8='
  const token = 'secret-value-used-for-testing'
  await cache.write(scope, 'session', [
    { ...message, streaming: true, text: 'unfinished body' },
    {
      ...message, text: `正文 ![图](${dataURL})\nraw ${rawBase64}\nAuthorization: Bearer ${token}`,
      thought: 'api_key=another_test_secret', token, artifacts: [{ keyB64: 'artifact-key' }],
      media: [{ url: 'blob:internal-object' }],
      toolCalls: [{ ...message.toolCalls[0], input: { password: 'tool-password' }, output: 'tool-output',
        detail: 'tool-detail', title: 'access_token=tool-title-secret', media: [{ url: dataURL }] }],
    },
  ], 0, null)
  const [live, settled] = (await cache.read(scope, 'session')).messages
  assert.equal(live.streaming, false)
  assert.equal(live.text, '')
  assert.equal(live.thought, undefined)
  assert.equal(live.toolCalls, undefined)
  assert.match(settled.text, /正文/)
  const stored = [...storage.records.values()].join('')
  for (const excluded of [dataURL, rawBase64, token, 'another_test_secret', 'artifact-key', 'blob:internal-object',
    'tool-password', 'tool-output', 'tool-detail', 'tool-title-secret', 'unfinished body']) {
    assert.ok(!stored.includes(excluded), excluded)
  }
})

test('message cache silently falls back when IndexedDB throws and skips unavailable or damaged storage', async () => {
  const storage = memoryStorage()
  const unavailable = () => { throw new Error('storage unavailable') }
  const fallback = createMessageCache({ indexedDB: unavailable, localStorage: () => storage })
  await fallback.write(scope, 'session', [message], 0, null)
  assert.equal((await fallback.read(scope, 'session')).messages[0].text, message.text)
  await fallback.remove(scope, 'session')
  assert.equal(await fallback.read(scope, 'session'), undefined)
  storage.setItem('studiolo.messageCache.v1', '{broken')
  assert.equal(await fallback.read(scope, 'session'), undefined)
  await fallback.write(scope, 'session', [message], 0, null)
  assert.equal((await fallback.read(scope, 'session')).messages[0].text, message.text)

  const disabled = createMessageCache({ indexedDB: unavailable, localStorage: unavailable })
  assert.equal(await disabled.read(scope, 'session'), undefined)
  await assert.doesNotReject(disabled.write(scope, 'session', [message], 0, null))
  await assert.doesNotReject(disabled.remove(scope, 'session'))
})

test('message cache downgrades persisted running tools to completed and preserves terminal statuses', async () => {
  const { cache, storage } = fixture()
  const recordKey = JSON.stringify([scope, 'raw-session'])
  storage.setItem('studiolo.messageCache.v1', JSON.stringify({
    [recordKey]: {
      updatedAt: 100,
      lastSeq: 5,
      epoch: 'epoch-1',
      messages: [{
        id: 'm-raw',
        role: 'assistant',
        text: '缓存正文',
        at: 100,
        streaming: false,
        toolCalls: [
          { id: 't-run', name: 'shell', status: 'running' },
          { id: 't-done', name: 'read', status: 'completed' },
          { id: 't-ok', name: 'grep', status: 'success' },
          { id: 't-err', name: 'write', status: 'error' },
        ],
      }],
    },
  }))

  for (const mode of ['legacy', 'epoch']) {
    const read = await cache.read(scope, 'raw-session', mode)
    assert.deepEqual(
      read.messages[0].toolCalls.map(tool => [tool.id, tool.status]),
      [['t-run', 'completed'], ['t-done', 'completed'], ['t-ok', 'success'], ['t-err', 'error']],
    )
  }

  await cache.write(scope, 'written-session', [{
    ...message,
    id: 'm-write',
    toolCalls: [
      { id: 'w-run', name: 'shell', status: 'running' },
      { id: 'w-done', name: 'read', status: 'completed' },
      { id: 'w-err', name: 'write', status: 'error' },
    ],
  }], 6, null)
  const written = await cache.read(scope, 'written-session')
  assert.deepEqual(
    written.messages[0].toolCalls.map(tool => [tool.id, tool.status]),
    [['w-run', 'completed'], ['w-done', 'completed'], ['w-err', 'error']],
  )
})

test('message cache switch off skips cache reads and writes', async () => {
  const accessed = []
  const cache = createMessageCache({
    indexedDB: () => { accessed.push('IndexedDB'); return undefined },
    localStorage: () => ({
      getItem(key) { accessed.push(key); return 'off' },
      setItem(key) { accessed.push(key) },
    }),
  })
  assert.equal(await cache.read(scope, 'session'), undefined)
  await cache.write(scope, 'session', [message], 0, null)
  assert.deepEqual(accessed, [switchKey, switchKey])
})

test('Fleet renders cached messages before requesting history and replaces them with the authoritative response', async t => {
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true },
  })
  t.after(() => server.close())
  const { useFleetStore, sessionKey } = await server.ssrLoadModule('/src/stores/fleet.ts')
  const { getApiBaseUrl } = await server.ssrLoadModule('/src/services/fleetUrl.ts')
  const { messageCache: cache } = await server.ssrLoadModule('/src/services/messageCache.ts')
  const storage = memoryStorage()
  const token = 'fixture-access-token'
  storage.setItem('studiolo:access-token', token)
  storage.setItem('studiolo:replica-account', JSON.stringify({
    id: 42, createdAt: 'test', origin: getApiBaseUrl(), fingerprint: createHash('sha256').update(token).digest('hex'),
  }))
  const primary = { nodeId: 'node', provider: 'codex', sessionId: 'primary', title: '测试', cwd: '' }
  const other = { ...primary, sessionId: 'other' }
  const key = sessionKey(primary.nodeId, primary.provider, primary.sessionId)
  const otherKey = sessionKey(other.nodeId, other.provider, other.sessionId)
  const sent = []
  let fleet
  class MockSocket {
    static OPEN = 1
    readyState = MockSocket.OPEN
    send(raw) {
      const frame = JSON.parse(raw)
      sent.push({ ...frame, visible: fleet.currentMessages.map(row => row.text) })
    }
    close() {}
  }
  for (const [name, value] of Object.entries({ localStorage: storage, indexedDB: undefined, WebSocket: MockSocket })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)
    Object.defineProperty(globalThis, name, { configurable: true, value })
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    })
  }
  const pinia = createPinia()
  fleet = useFleetStore(pinia)
  t.after(() => disposePinia(pinia))
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const sessionScope = fleet.deviceSessionScope
  assert.ok(sessionScope)
  await cache.write(sessionScope, key, [{ ...message, text: '上次答复' }], 99, 'old')
  await cache.write(sessionScope, otherKey, [{ ...message, text: '另一会话缓存' }], 12, null)
  fleet.sessionsByKey = { [key]: primary, [otherKey]: other }
  fleet.connectSocket()
  fleet.handleWsEvent({ type: 'FleetSnapshot', nodes: [] })
  fleet.activateSession(key)
  assert.equal(sent.some(frame => frame.type === 'session.history'), false)
  await new Promise(resolve => setImmediate(resolve))
  const history = sent.find(frame => frame.type === 'session.history')
  const subscription = sent.find(frame => frame.type === 'session.subscribe')
  assert.deepEqual(history.visible, ['上次答复'])
  assert.deepEqual(subscription.visible, ['上次答复'])
  assert.equal(subscription.lastSeq, 0)

  fleet.runningBySession[key] = 'live-run'
  fleet.handleWsEvent({ ...primary, type: 'SessionHistory', requestId: history.requestId, messages: [
    { id: 'final', role: 'assistant', text: '最新答复', createdAt: 200 },
    { id: 'live', role: 'assistant', runId: 'live-run', text: '尚未结束', createdAt: 201 },
  ] })
  assert.deepEqual(fleet.currentMessages.map(row => row.text), ['最新答复', '尚未结束'])
  assert.equal(fleet.currentMessages[1].streaming, true)
  const refreshId = fleet.loadSessionHistory(key, true)
  fleet.handleWsEvent({ ...primary, type: 'SessionHistory', requestId: refreshId, messages: [
    { id: 'final', role: 'assistant', text: '校正后的答复', createdAt: 200 },
    { id: 'live', role: 'assistant', runId: 'live-run', text: '尚未结束', createdAt: 201 },
  ] })
  assert.equal((await cache.read(sessionScope, key)).messages[0].text, '上次答复')
  t.mock.timers.tick(500)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual((await cache.read(sessionScope, key)).messages.map(row => row.text), ['校正后的答复'])
  fleet.handleWsEvent({ ...primary, type: 'TextDelta', runId: 'live-run', text: '，现已完成' })
  fleet.handleWsEvent({ ...primary, type: 'Completed', runId: 'live-run', seq: 12 })
  t.mock.timers.tick(500)
  await new Promise(resolve => setImmediate(resolve))
  const settled = await cache.read(sessionScope, key)
  assert.deepEqual(settled.messages.map(row => row.text), ['校正后的答复', '尚未结束，现已完成'])
  assert.equal(settled.lastSeq, 12)

  fleet.disconnectSocket()
  fleet.activateSession(otherKey)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(fleet.currentMessages.map(row => row.text), ['另一会话缓存'])
  fleet.connectSocket()
  fleet.handleWsEvent({ type: 'FleetSnapshot', nodes: [] })
  const otherHistory = sent.filter(frame => frame.type === 'session.history').at(-1)
  assert.equal(otherHistory.sessionId, other.sessionId)
  fleet.handleWsEvent({ ...other, type: 'SessionHistory', requestId: otherHistory.requestId, messages: [] })
  assert.deepEqual(fleet.currentMessages, [])
  fleet.handleWsEvent({ ...primary, type: 'SessionDeleted' })
  storage.setItem(`studiolo:fleet:organization:${sessionScope}`, JSON.stringify({
    [otherKey]: { placement: 'archived', changedAt: 201 },
  }))
  fleet.removeSessionMessageCache(otherKey)
  fleet.handleWsEvent({ ...other, type: 'SessionHistory', messages: [
    { id: 'late', role: 'assistant', text: '归档后的历史响应' },
  ] })
  t.mock.timers.tick(500)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(await cache.read(sessionScope, key), undefined)
  assert.equal(await cache.read(sessionScope, otherKey), undefined)
})

test('epoch thread renders the cache first and replaces it with the snapshot', async t => {
  const server = await createServer({
    configFile: false,
    plugins: [vue()],
    server: { middlewareMode: true, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true },
  })
  t.after(() => server.close())
  const { useFleetStore, sessionKey } = await server.ssrLoadModule('/src/stores/fleet.ts')
  const { getApiBaseUrl } = await server.ssrLoadModule('/src/services/fleetUrl.ts')
  const { default: AgentChatThread } = await server.ssrLoadModule('/src/components/chat/AgentChatThread.vue')
  const storage = memoryStorage()
  const token = 'fixture-access-token'
  storage.setItem('studiolo:access-token', token)
  storage.setItem('studiolo.syncMode', 'epoch')
  storage.setItem('studiolo:replica-account', JSON.stringify({
    id: 42, createdAt: 'test', origin: getApiBaseUrl(), fingerprint: createHash('sha256').update(token).digest('hex'),
  }))
  const sent = []
  class MockSocket {
    static OPEN = 1
    readyState = MockSocket.OPEN
    send(raw) { sent.push(JSON.parse(raw)) }
    close() {}
  }
  for (const [name, value] of Object.entries({ localStorage: storage, indexedDB: undefined, WebSocket: MockSocket })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)
    Object.defineProperty(globalThis, name, { configurable: true, value })
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    })
  }
  const pinia = createPinia()
  const fleet = useFleetStore(pinia)
  t.after(() => disposePinia(pinia))
  const session = { nodeId: 'node', provider: 'codex', sessionId: 'primary', title: '测试', cwd: '' }
  const key = sessionKey(session.nodeId, session.provider, session.sessionId)
  assert.ok(fleet.deviceSessionScope)
  storage.setItem('studiolo.messageCache.v1', JSON.stringify({
    [JSON.stringify([fleet.deviceSessionScope, key])]: {
      updatedAt: 1, lastSeq: 2, epoch: 'cached-epoch', messages: [
        { id: 'same', role: 'assistant', text: '缓存正文', at: 100 },
        { id: 'tool-only', role: 'assistant', toolCalls: message.toolCalls, at: 101 },
        { id: 'parts-only', role: 'assistant', parts: [{ type: 'text', text: '缓存片段' }], at: 102 },
        { id: 'empty', role: 'assistant', text: '', at: 103 },
      ],
    },
  }))
  const snapshot = Promise.withResolvers()
  t.after(() => snapshot.resolve(Response.json({ code: 'test_finished' })))
  const frames = []
  t.mock.method(globalThis, 'fetch', () => {
    frames.push(fleet.currentMessages.map(row => row.id))
    return snapshot.promise
  })
  const renderThread = () => renderToString(createSSRApp(AgentChatThread, { mobile: true }).use(pinia))
  fleet.sessionsByKey = { [key]: session }
  fleet.connectSocket()
  fleet.handleWsEvent({ type: 'FleetSnapshot', nodes: [] })
  fleet.activateSession(key)
  const opening = renderThread()
  await new Promise(resolve => setImmediate(resolve))

  // Reproduce the fast history response while the epoch snapshot is still pending.
  const history = sent.find(frame => frame.type === 'session.history')
  if (history) fleet.handleWsEvent({ ...session, type: 'SessionHistory', requestId: history.requestId, messages:
    Array.from({ length: 12 }, (_, n) => ({ id: `shell-${n}`, role: 'assistant', text: '',
      parts: [{ type: 'thought', text: '\n ' }] })),
  })
  const cached = await renderThread()
  assert.equal((cached.match(/用时未记录/g) ?? []).length, 0)
  assert.doesNotMatch(await opening, /mmsgs-inner|thread-empty/)
  assert.match(cached, /缓存正文/)
  assert.match(cached, /运行测试/)
  assert.match(cached, /缓存片段/)
  assert.deepEqual(frames, [['same', 'tool-only', 'parts-only']])
  assert.equal(history, undefined)
  snapshot.resolve(Response.json({ epoch: 'new', lastSeq: 3, snapshot: { lastSeq: 3, messages: [
    { id: 'same', role: 'assistant', text: '最新正文' },
  ] } }))
  await new Promise(resolve => setImmediate(resolve))
  const fresh = await renderThread()
  assert.match(fresh, /最新正文/)
  assert.doesNotMatch(fresh, /缓存正文|运行测试|缓存片段/)
  assert.deepEqual(fleet.currentMessages.map(row => row.id), ['same'])
})
