import assert from 'node:assert/strict'
import test from 'node:test'
import { createPinia, disposePinia } from 'pinia'
import { createServer } from 'vite'

async function createFleetFixture(t, { syncMode = 'legacy' } = {}) {
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true },
  })
  t.after(() => server.close())
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: key => ({ 'studiolo:access-token': 'token', 'studiolo.syncMode': syncMode })[key] ?? null,
      setItem() {},
      removeItem() {},
    },
  })
  t.after(() => {
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage)
    else delete globalThis.localStorage
  })
  const { useFleetStore, sessionKey } = await server.ssrLoadModule('/src/stores/fleet.ts')
  const pinia = createPinia()
  const fleet = useFleetStore(pinia)
  t.after(() => {
    fleet.disconnectSocket()
    disposePinia(pinia)
  })
  return { fleet, sessionKey }
}

test('turn end settles running tools in the ended session only and preserves terminal statuses, text, and streaming', async t => {
  const { fleet, sessionKey } = await createFleetFixture(t)
  const sessionA = { nodeId: 'node', provider: 'codex', sessionId: 'sess-a', title: 'A', cwd: '' }
  const sessionB = { nodeId: 'node', provider: 'codex', sessionId: 'sess-b', title: 'B', cwd: '' }
  const keyA = sessionKey(sessionA.nodeId, sessionA.provider, sessionA.sessionId)
  const keyB = sessionKey(sessionB.nodeId, sessionB.provider, sessionB.sessionId)
  fleet.sessionsByKey = { [keyA]: sessionA, [keyB]: sessionB }

  // 1) Completed settles all running tools in session A (including earlier messages) without affecting session B.
  fleet.runningBySession = { [keyA]: 'run-a', [keyB]: 'run-b' }
  fleet.messagesBySession = {
    [keyA]: [
      {
        id: 'a-prev',
        role: 'assistant',
        nodeId: 'node',
        provider: 'codex',
        text: '先前文本',
        streaming: true,
        createdAt: 1,
        toolCalls: [
          { id: 't-prev-run', name: 'shell', status: 'running' },
          { id: 't-prev-err', name: 'write', status: 'error' },
        ],
      },
      {
        id: 'a-cur',
        role: 'assistant',
        runId: 'run-a',
        nodeId: 'node',
        provider: 'codex',
        text: '当前文本',
        streaming: true,
        createdAt: 2,
        toolCalls: [
          { id: 't-cur-run', name: 'bash', status: 'running' },
          { id: 't-cur-done', name: 'read', status: 'completed' },
        ],
      },
    ],
    [keyB]: [
      {
        id: 'b-cur',
        role: 'assistant',
        runId: 'run-b',
        nodeId: 'node',
        provider: 'codex',
        text: '会话 B 文本',
        streaming: true,
        createdAt: 3,
        toolCalls: [{ id: 't-b-run', name: 'shell', status: 'running' }],
      },
    ],
  }

  fleet.handleWsEvent({ ...sessionA, type: 'Completed', runId: 'run-a' })

  assert.deepEqual(
    fleet.messagesBySession[keyA][0].toolCalls.map(tool => [tool.id, tool.status]),
    [['t-prev-run', 'completed'], ['t-prev-err', 'error']],
  )
  assert.equal(fleet.messagesBySession[keyA][0].text, '先前文本')
  assert.equal(fleet.messagesBySession[keyA][0].streaming, false)
  assert.deepEqual(
    fleet.messagesBySession[keyA][1].toolCalls.map(tool => [tool.id, tool.status]),
    [['t-cur-run', 'completed'], ['t-cur-done', 'completed']],
  )
  assert.equal(fleet.messagesBySession[keyA][1].text, '当前文本')
  assert.equal(fleet.messagesBySession[keyA][1].streaming, false)
  // Session B must remain untouched.
  assert.equal(fleet.messagesBySession[keyB][0].toolCalls[0].status, 'running')
  assert.equal(fleet.messagesBySession[keyB][0].streaming, true)
  assert.equal(fleet.messagesBySession[keyB][0].text, '会话 B 文本')

  // 2) Failed on an active run settles running tools in session A to completed without touching session B.
  fleet.runningBySession = { [keyA]: 'run-a2', [keyB]: 'run-b' }
  fleet.messagesBySession = {
    ...fleet.messagesBySession,
    [keyA]: [{
      id: 'a-fail',
      role: 'assistant',
      runId: 'run-a2',
      nodeId: 'node',
      provider: 'codex',
      text: '失败前正文',
      streaming: true,
      createdAt: 4,
      toolCalls: [
        { id: 't-fail-run', name: 'shell', status: 'running' },
        { id: 't-fail-err', name: 'write', status: 'error' },
      ],
    }],
  }
  fleet.handleWsEvent({ ...sessionA, type: 'Failed', runId: 'run-a2', message: 'boom' })
  assert.deepEqual(
    fleet.messagesBySession[keyA][0].toolCalls.map(tool => [tool.id, tool.status]),
    [['t-fail-run', 'completed'], ['t-fail-err', 'error']],
  )
  assert.equal(fleet.messagesBySession[keyA][0].text, '失败前正文')
  assert.equal(fleet.messagesBySession[keyB][0].toolCalls[0].status, 'running')

  // 3) running true -> false settles running tools without altering streaming flag or text content.
  fleet.runningBySession = { [keyA]: 'run-a3', [keyB]: 'run-b' }
  fleet.messagesBySession = {
    ...fleet.messagesBySession,
    [keyA]: [
      {
        id: 'a-stream',
        role: 'assistant',
        runId: 'run-a3',
        nodeId: 'node',
        provider: 'codex',
        text: '保持流式正文',
        streaming: true,
        createdAt: 5,
        toolCalls: [{ id: 't-watch-run', name: 'shell', status: 'running' }],
      },
      {
        id: 'a-idle',
        role: 'assistant',
        nodeId: 'node',
        provider: 'codex',
        text: '非流式正文',
        streaming: false,
        createdAt: 6,
        toolCalls: [{ id: 't-watch-idle', name: 'read', status: 'running' }],
      },
    ],
  }
  delete fleet.runningBySession[keyA]
  assert.equal(fleet.messagesBySession[keyA][0].toolCalls[0].status, 'completed')
  assert.equal(fleet.messagesBySession[keyA][0].streaming, true)
  assert.equal(fleet.messagesBySession[keyA][0].text, '保持流式正文')
  assert.equal(fleet.messagesBySession[keyA][1].toolCalls[0].status, 'completed')
  assert.equal(fleet.messagesBySession[keyA][1].streaming, false)
  assert.equal(fleet.messagesBySession[keyA][1].text, '非流式正文')
  assert.equal(fleet.messagesBySession[keyB][0].toolCalls[0].status, 'running')
})

test('epoch snapshot server completed status overrides local running tool', async t => {
  const { fleet, sessionKey } = await createFleetFixture(t, { syncMode: 'epoch' })
  const session = { nodeId: 'node', provider: 'hermes', sessionId: 'snap-1', title: '快照测试', cwd: '' }
  const key = sessionKey(session.nodeId, session.provider, session.sessionId)
  fleet.sessionsByKey = { [key]: session }
  fleet.wsState = 'online'
  fleet.messagesBySession = {
    [key]: [{
      id: 'm-1',
      role: 'assistant',
      runId: 'turn-1',
      nodeId: 'node',
      provider: 'hermes',
      text: '本地正文',
      streaming: false,
      createdAt: 10,
      toolCalls: [{ id: 'call-1', callId: 'call-1', name: 'bash', status: 'running' }],
    }],
  }

  t.mock.method(globalThis, 'fetch', async () => Response.json({
    epoch: 'epoch-1',
    lastSeq: 5,
    snapshot: {
      lastSeq: 5,
      running: false,
      messages: [{
        id: 'm-1',
        role: 'assistant',
        turnId: 'turn-1',
        text: '服务端正文',
        toolCalls: [{ callId: 'call-1', name: 'bash', status: 'completed', durationMs: 42 }],
      }],
    },
  }))

  assert.equal(fleet.subscribeSession(key), true)
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(fleet.messagesBySession[key].length, 1)
  assert.equal(fleet.messagesBySession[key][0].text, '服务端正文')
  assert.equal(fleet.messagesBySession[key][0].toolCalls[0].status, 'success')
  assert.notEqual(fleet.messagesBySession[key][0].toolCalls[0].status, 'running')
})
