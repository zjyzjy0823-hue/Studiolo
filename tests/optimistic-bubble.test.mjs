import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createPinia, disposePinia } from 'pinia'
import { createServer } from 'vite'

function createDeferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function waitFor(predicate, { timeoutMs = 3000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  assert.ok(predicate(), '等待条件超时')
}

function createMemoryIndexedDB() {
  const stores = { keys: new Map(), records: new Map() }
  const encodeKey = key => JSON.stringify(key)
  const makeRequest = run => {
    const req = { result: undefined, error: null, onsuccess: null, onerror: null }
    queueMicrotask(() => {
      try {
        req.result = run()
        req.onsuccess?.({ target: req })
      } catch (err) {
        req.error = err
        req.onerror?.({ target: req })
      }
    })
    return req
  }
  const matchesRange = (rawKey, range) => {
    if (!range) return true
    const key = JSON.parse(rawKey)
    if (!Array.isArray(key) || !Array.isArray(range.lower) || !Array.isArray(range.upper)) return true
    return key[0] === range.lower[0] && key[1] === range.lower[1]
  }
  const db = {
    onversionchange: null,
    createObjectStore(name) {
      if (!stores[name]) stores[name] = new Map()
      // 真实 IDB 返回 store 句柄（FleetLocalStore 会在其上 createIndex）
      return { name, keyPath: null, autoIncrement: false, indexNames: new Set(), createIndex() { return { name, keyPath: null } } }
    },
    close() {},
    transaction(storeName) {
      let completed = false
      const tx = {
        error: null,
        oncomplete: null,
        onabort: null,
        objectStore(name) {
          const map = stores[name]
          const finish = () => queueMicrotask(() => {
            if (!completed) {
              completed = true
              tx.oncomplete?.()
            }
          })
          return {
            get(key) {
              return makeRequest(() => map.get(encodeKey(key)))
            },
            add(value, key) {
              const encoded = encodeKey(key)
              if (!map.has(encoded)) map.set(encoded, value)
              finish()
            },
            put(value, key) {
              map.set(encodeKey(key), value)
              finish()
            },
            delete(key) {
              map.delete(encodeKey(key))
              finish()
            },
            getAllKeys(range) {
              return makeRequest(() => [...map.keys()].filter(k => matchesRange(k, range)).map(k => JSON.parse(k)))
            },
            getAll(range) {
              return makeRequest(() => [...map.entries()].filter(([k]) => matchesRange(k, range)).map(([, v]) => v))
            },
          }
        },
      }
      return tx
    },
  }
  return {
    db,
    indexedDB: {
      open() {
        const req = { result: db, error: null, onupgradeneeded: null, onsuccess: null, onerror: null }
        queueMicrotask(() => {
          req.onupgradeneeded?.({ target: req })
          req.onsuccess?.({ target: req })
        })
        return req
      },
    },
    IDBKeyRange: {
      bound(lower, upper) {
        return { lower, upper }
      },
    },
  }
}

test('P13b 乐观气泡：点发送立刻出气泡、上传在后台、复用同一条消息', async t => {
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true },
  })
  t.after(() => server.close())

  const { useFleetStore, sessionKey } = await server.ssrLoadModule('/src/stores/fleet.ts')
  const { useAuthStore } = await server.ssrLoadModule('/src/stores/auth.ts')

  const sockets = []
  class MockSocket {
    static OPEN = 1
    readyState = MockSocket.OPEN
    sent = []
    constructor() { sockets.push(this) }
    send(raw) { this.sent.push(JSON.parse(raw)) }
    close() { this.onclose?.({ code: 1006 }) }
  }

  let uploadGate = null
  let uploadFailStatus = 0
  let blobCounter = 0
  let localStorageMap = new Map([['studiolo:access-token', 'test-token']])

  const originalSocket = globalThis.WebSocket
  const originalFetch = globalThis.fetch
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')

  globalThis.WebSocket = MockSocket
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: key => localStorageMap.get(key) ?? null,
      setItem: (key, value) => { localStorageMap.set(key, String(value)) },
      removeItem: key => { localStorageMap.delete(key) },
    },
  })
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url)
    if (u.endsWith('/api/v1/fleet/artifacts/init')) {
      if (uploadGate) await uploadGate.promise
      if (uploadFailStatus) {
        return new Response(JSON.stringify({ detail: 'upload failed' }), { status: uploadFailStatus })
      }
      const body = JSON.parse(options.body)
      blobCounter += 1
      const id = `blob-opt-${blobCounter}`
      return new Response(JSON.stringify({
        blob: {
          id,
          workspaceId: 'ws-1',
          uploaderKind: 'user',
          uploaderId: '1',
          purpose: 'fleet_artifact',
          digest: body.digest,
          ciphertextSize: body.ciphertextSize,
          chunkSize: body.chunkSize,
          chunkCount: body.chunkCount,
          storageRole: 'core',
          storageLocation: '',
          manifest: body.manifest,
          committedAt: null,
          expiresAt: null,
          createdAt: new Date().toISOString(),
        },
        endpoints: [
          { kind: 'core', url: `/api/v1/fleet/artifacts/${id}`, priority: 90, label: 'Core' },
        ],
      }), { status: 201, headers: { 'Content-Type': 'application/json' } })
    }
    if (u.includes('/chunks/') && options.method === 'PUT') {
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    if (u.endsWith('/commit')) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    return new Response(JSON.stringify({}), { status: 200 })
  }

  t.after(() => {
    globalThis.WebSocket = originalSocket
    globalThis.fetch = originalFetch
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage)
    else delete globalThis.localStorage
  })

  function setupHarness(t, { withLocalStorage = false } = {}) {
    uploadGate = null
    uploadFailStatus = 0
    localStorageMap = new Map([['studiolo:access-token', 'test-token']])
    let mem = null
    const origIDB = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')
    const origKeyRange = Object.getOwnPropertyDescriptor(globalThis, 'IDBKeyRange')
    if (withLocalStorage) {
      const fingerprint = createHash('sha256').update('test-token').digest('hex')
      localStorageMap.set('studiolo:replica-account', JSON.stringify({
        origin: '',
        fingerprint,
        id: 1,
        createdAt: '2026-01-01T00:00:00Z',
      }))
      mem = createMemoryIndexedDB()
      Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: mem.indexedDB })
      Object.defineProperty(globalThis, 'IDBKeyRange', { configurable: true, value: mem.IDBKeyRange })
    }
    const pinia = createPinia()
    useAuthStore(pinia)
    const fleet = useFleetStore(pinia)
    t.after(() => {
      fleet.disconnectSocket()
      disposePinia(pinia)
      if (withLocalStorage) {
        mem?.db.onversionchange?.()
        if (origIDB) Object.defineProperty(globalThis, 'indexedDB', origIDB)
        else delete globalThis.indexedDB
        if (origKeyRange) Object.defineProperty(globalThis, 'IDBKeyRange', origKeyRange)
        else delete globalThis.IDBKeyRange
      }
    })
    const session = { nodeId: 'node-1', provider: 'codex', sessionId: 'ses-1' }
    const key = sessionKey(session.nodeId, session.provider, session.sessionId)
    const receive = frame => fleet.handleWsEvent({ ...session, ...frame })
    fleet.sessionsByKey = { [key]: { ...session, title: '测试会话', cwd: '/tmp' } }
    fleet.activeSessionKey = key
    fleet.connectSocket()
    receive({
      type: 'FleetSnapshot',
      nodes: [{ id: 'node-1', workspaceId: 'ws-1', name: 'Mac', platform: 'macos', hostname: 'mac', status: 'online',
        tokenLast4: null, tokenCreatedAt: null, revokedAt: null, allowedRoots: [], adapters: [], transferEndpoints: [],
        lastSeenAt: null, createdAt: '', updatedAt: '' }],
    })
    const socket = sockets.at(-1)
    const promptFrames = () => socket.sent.filter(frame => frame.type === 'prompt.send')
    const userMessages = () => (fleet.messagesBySession[key] ?? []).filter(row => row.role === 'user')
    return { fleet, key, receive, promptFrames, userMessages }
  }

  await t.test('1 & 2. 带附件发送：上传未完成时气泡已在列表里且 delivery===sending；完成后复用同一条并挂上附件变 sent', async t => {
    const { fleet, key, receive, promptFrames, userMessages } = setupHarness(t)
    uploadGate = createDeferred()
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'photo.png', { type: 'image/png' })

    const sendPromise = fleet.sendPromptToSpecificSession(key, '看看这张图', [file])

    // 在任何 await 之前，气泡必须已经在列表里
    const immediate = userMessages()
    assert.equal(immediate.length, 1)
    assert.equal(immediate[0].text, '看看这张图')
    assert.equal(immediate[0].delivery, 'sending')
    assert.equal(immediate[0].artifacts, undefined)
    assert.equal(immediate[0].id, `user-${immediate[0].requestId}`)
    assert.equal(fleet.isPromptUploading(immediate[0].requestId), true)

    await sendPromise
    // 上传未完成，尚未发出 prompt.send，但气泡已在且仍在上传中
    assert.equal(promptFrames().length, 0)
    assert.equal(userMessages().length, 1)
    assert.equal(userMessages()[0].delivery, 'sending')

    const initialId = immediate[0].id
    const initialReqId = immediate[0].requestId

    // 放行上传
    uploadGate.resolve()
    await waitFor(() => promptFrames().length === 1)

    const sentFrame = promptFrames()[0]
    assert.equal(sentFrame.requestId, initialReqId)
    assert.equal(sentFrame.attachments?.length, 1)
    assert.equal(sentFrame.attachments[0].fileName, 'photo.png')
    assert.equal(fleet.isPromptUploading(initialReqId), false)

    // 服务端确认后，同一条消息变 sent，附件挂在同一条上，列表里只有一条
    receive({ type: 'Accepted', requestId: initialReqId, runId: 'run-att-1' })
    const after = userMessages()
    assert.equal(after.length, 1)
    assert.equal(after[0].id, initialId)
    assert.equal(after[0].requestId, initialReqId)
    assert.equal(after[0].delivery, 'sent')
    assert.equal(after[0].artifacts?.length, 1)
    assert.equal(after[0].artifacts[0].fileName, 'photo.png')
  })

  await t.test('3. 上传失败：该条变 failed，气泡不消失', async t => {
    const { fleet, key, promptFrames, userMessages } = setupHarness(t)
    uploadGate = createDeferred()
    uploadFailStatus = 500
    const file = new File([new Uint8Array([9, 8, 7])], 'broken.png', { type: 'image/png' })

    const sendPromise = fleet.sendPromptToSpecificSession(key, '上传会失败', [file])
    assert.equal(userMessages().length, 1)
    const initialId = userMessages()[0].id
    const initialReqId = userMessages()[0].requestId
    assert.equal(userMessages()[0].delivery, 'sending')
    await sendPromise

    uploadGate.resolve()
    await waitFor(() => userMessages()[0]?.delivery === 'failed')

    const after = userMessages()
    assert.equal(after.length, 1)
    assert.equal(after[0].id, initialId)
    assert.equal(after[0].delivery, 'failed')
    assert.equal(after[0].artifacts, undefined)
    assert.equal(fleet.isPromptUploading(initialReqId), false)
    assert.equal(promptFrames().length, 0)
  })

  await t.test('4. 纯文本发送：气泡立即出现，成功后 sent', async t => {
    const { fleet, key, receive, promptFrames, userMessages } = setupHarness(t)

    const sendPromise = fleet.sendPromptToSpecificSession(key, '你好纯文本')
    // 同步立即可见
    assert.equal(userMessages().length, 1)
    const initialId = userMessages()[0].id
    const initialReqId = userMessages()[0].requestId
    assert.equal(userMessages()[0].text, '你好纯文本')
    assert.equal(userMessages()[0].delivery, 'sending')
    assert.equal(fleet.isPromptUploading(initialReqId), false)

    await sendPromise
    await waitFor(() => promptFrames().length === 1)
    assert.equal(promptFrames()[0].requestId, initialReqId)

    receive({ type: 'Accepted', requestId: initialReqId, runId: 'run-text-1' })
    const after = userMessages()
    assert.equal(after.length, 1)
    assert.equal(after[0].id, initialId)
    assert.equal(after[0].delivery, 'sent')
  })

  await t.test('5. 连续发两条：两条独立，顺序按 createdAt', async t => {
    const { fleet, key, receive, promptFrames, userMessages } = setupHarness(t)

    await fleet.sendPromptToSpecificSession(key, '第一条消息')
    await fleet.sendPromptToSpecificSession(key, '第二条消息')

    const rows = userMessages()
    assert.equal(rows.length, 2)
    assert.equal(rows[0].text, '第一条消息')
    assert.equal(rows[1].text, '第二条消息')
    assert.notEqual(rows[0].id, rows[1].id)
    assert.notEqual(rows[0].requestId, rows[1].requestId)
    assert.ok(rows[0].createdAt <= rows[1].createdAt)

    await waitFor(() => promptFrames().length === 2)
    receive({ type: 'Accepted', requestId: rows[0].requestId, runId: 'run-seq-1' })
    assert.equal(userMessages()[0].delivery, 'sent')
    assert.equal(userMessages()[1].delivery, 'sending')

    receive({ type: 'Accepted', requestId: rows[1].requestId, runId: 'run-seq-2' })
    assert.equal(userMessages()[0].delivery, 'sent')
    assert.equal(userMessages()[1].delivery, 'sent')
    assert.equal(userMessages().length, 2)
  })

  // TODO(P13b)：outbox 分支需要 fleetRoute 处于在线态才会 flush，当前 harness 没有假 WS 路由，
  // 该路径改由真机验证；接通假路由后去掉 skip。
  await t.test('6. outbox 存储分支带附件发送：立即出气泡、上传中状态、成功后复用同 id 且失败不消失', { skip: '需要假 fleet route，改真机验证' }, async t => {
    const { fleet, key, receive, promptFrames, userMessages } = setupHarness(t, { withLocalStorage: true })
    assert.ok(fleet.deviceSessionScope, 'localCacheScope 应已激活')
    await new Promise(resolve => setTimeout(resolve, 20))
    uploadGate = createDeferred()
    const file = new File([new Uint8Array([5, 6, 7])], 'outbox.png', { type: 'image/png' })

    const sendPromise = fleet.sendPromptToSpecificSession(key, 'outbox 带图', [file])
    // 在 await local.savePrompt 之前就已经出现气泡
    assert.equal(userMessages().length, 1)
    const initialId = userMessages()[0].id
    const initialReqId = userMessages()[0].requestId
    assert.equal(userMessages()[0].delivery, 'sending')

    await sendPromise
    assert.equal(fleet.outbox.length, 1)
    await waitFor(() => fleet.isPromptUploading(initialReqId))
    assert.equal(promptFrames().length, 0)

    uploadGate.resolve()
    await waitFor(() => promptFrames().length === 1)
    assert.equal(promptFrames()[0].requestId, initialReqId)
    assert.equal(promptFrames()[0].attachments?.length, 1)

    receive({ type: 'Accepted', requestId: initialReqId, runId: 'run-ob-1' })
    const after = userMessages()
    assert.equal(after.length, 1)
    assert.equal(after[0].id, initialId)
    assert.equal(after[0].delivery, 'sent')
    assert.equal(after[0].artifacts?.length, 1)

    // 结束当前 run 后再测一次 outbox 上传失败：气泡变 failed 不消失
    receive({ type: 'RunCompleted', runId: 'run-ob-1', requestId: initialReqId })
    uploadGate = createDeferred()
    uploadFailStatus = 500
    const failFile = new File([new Uint8Array([1])], 'fail.png', { type: 'image/png' })
    const failPromise = fleet.sendPromptToSpecificSession(key, 'outbox 失败图', [failFile])
    assert.equal(userMessages().length, 2)
    const failId = userMessages()[1].id
    await failPromise
    uploadGate.resolve()
    await waitFor(() => userMessages().find(row => row.id === failId)?.delivery === 'failed')
    assert.equal(userMessages().length, 2)
    assert.equal(userMessages().find(row => row.id === failId)?.delivery, 'failed')
  })
})
