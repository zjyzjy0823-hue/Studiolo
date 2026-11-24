import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import vue from '@vitejs/plugin-vue'
import { createPinia, disposePinia } from 'pinia'
import { createServer } from 'vite'
import { createSSRApp, nextTick } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { mapSessionProcesses, mapSessionSubagents, retainSessionProcesses } from '../src/services/sessionActivity.ts'

const server = await createServer({
  configFile: false,
  plugins: [vue()],
  server: { middlewareMode: true, ws: false, watch: null },
  optimizeDeps: { noDiscovery: true },
})
after(() => server.close())

const processRow = (id, status = 'running') => ({ session_id: id, status, command: 'printf hello' })
const delegation = { delegation_id: 'deleg-batch', goals: ['运行测试', '整理结果'], count: 2, status: 'running' }
const settle = () => new Promise(resolve => setImmediate(resolve))

async function fleetFixture(t, respond) {
  const { useFleetStore, sessionKey } = await server.ssrLoadModule('/src/stores/fleet.ts')
  const { useAuthStore } = await server.ssrLoadModule('/src/stores/auth.ts')
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => key === 'studiolo:access-token' ? 'test-token' : null,
    removeItem() {},
  } })
  t.after(() => {
    if (storage) Object.defineProperty(globalThis, 'localStorage', storage)
    else delete globalThis.localStorage
  })
  const pinia = createPinia()
  t.after(() => disposePinia(pinia))
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000 })
  const fleet = useFleetStore(pinia)
  const session = { nodeId: 'node/1', provider: 'hermes', sessionId: 'chat-session', title: '会话', cwd: '' }
  const key = sessionKey(session.nodeId, session.provider, session.sessionId)
  const calls = []
  fleet.sessionsByKey[key] = session
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const endpoint = url.split('/').at(-1)
    calls.push({ endpoint, url, options })
    return respond ? respond(endpoint, options) : Response.json({ [endpoint]: [] })
  })
  return { fleet, auth: useAuthStore(pinia), key, session, calls }
}

test('maps Core process records and tolerates fields missing on individual rows', () => {
  const result = mapSessionProcesses({ provider: 'hermes', processes: [
    {
      ...processRow('proc-1'), cwd: '/workspace', pid: 35741, uptime_seconds: 12, output_preview: 'hello',
      output_tail: 'hello\nworld', exit_code: 0, started_at: 1_795_613_000,
    },
    null,
    { session_id: 'proc-2', uptime_seconds: 'invalid' },
  ] })
  assert.deepEqual(result, { kind: 'ok', items: [
    {
      id: 'proc-1', command: 'printf hello', cwd: '/workspace', pid: 35741, status: 'running',
      uptimeSeconds: 12, outputPreview: 'hello', outputTail: 'hello\nworld', exitCode: 0, startedAt: 1_795_613_000_000,
    },
    {
      id: 'proc-2', command: '', cwd: '', pid: null, status: 'unknown',
      uptimeSeconds: null, outputPreview: '', outputTail: '', exitCode: null, startedAt: null,
    },
  ] })
})

test('maps subagents and delegation batches without counting linked children twice', () => {
  assert.deepEqual(mapSessionSubagents({
    provider: 'hermes',
    subagents: [
      { subagent_id: 'child', delegation_id: 'deleg-batch', goal: '运行测试' },
      { id: 'standalone', goals: [null, '检查日志'] },
    ],
    delegations: [delegation],
  }), {
    kind: 'ok',
    items: [
      { id: 'standalone', goals: ['检查日志'], count: 1, status: 'unknown' },
      { id: 'deleg-batch', goals: ['运行测试', '整理结果'], count: 2, status: 'running' },
    ],
  })
  assert.deepEqual(mapSessionSubagents({ subagents: [], delegations: [] }), { kind: 'ok', items: [] })
})

test('distinguishes unsupported, RPC errors and invalid list responses', () => {
  for (const map of [mapSessionProcesses, mapSessionSubagents]) {
    assert.deepEqual(map({ unsupported: true }), { kind: 'unsupported' })
    assert.deepEqual(map({ ok: false, code: 'node_offline', error: 'Target device node is offline' }),
      { kind: 'error', message: 'Target device node is offline' })
    assert.deepEqual(map({ provider: 'hermes' }), { kind: 'error', message: '暂不可用' })
  }
})

test('keeps the running processes and at most five most recent ended processes', () => {
  const history = Array.from({ length: 8 }, (_, n) => ({
    ...processRow(`old-${n}`, 'completed'), started_at: `2026-11-24T00:00:0${n}Z`,
  }))
  const current = mapSessionProcesses({ processes: [...history, processRow('running-1'), processRow('running-2')] }).items
  const retained = retainSessionProcesses(current)
  assert.deepEqual(retained.map(item => item.id), ['running-1', 'running-2', 'old-7', 'old-6', 'old-5', 'old-4', 'old-3'])
  const changed = mapSessionProcesses({ processes: [
    { ...processRow('running-1', 'failed'), started_at: '2026-11-24T00:00:09Z' },
  ] }).items
  assert.deepEqual(retainSessionProcesses(changed, retained).map(item => item.id),
    ['running-1', 'old-7', 'old-6', 'old-5', 'old-4'])
})

test('five refresh triggers in two seconds send one authenticated POST per endpoint', async t => {
  const { fleet, key, calls } = await fleetFixture(t)
  await fleet.refreshSessionActivity(key)
  for (let attempt = 0; attempt < 4; attempt++) {
    t.mock.timers.tick(400)
    await fleet.refreshSessionActivity(key)
  }
  assert.deepEqual(calls.map(call => call.endpoint), ['processes', 'subagents'])
  for (const { endpoint, url, options } of calls) {
    assert.ok(url.endsWith(`/api/v1/fleet/nodes/node%2F1/session/${endpoint}`))
    assert.equal(options.method, 'POST')
    assert.equal(options.headers.Authorization, 'Bearer test-token')
    assert.deepEqual(JSON.parse(options.body), { session_id: 'chat-session', provider: 'hermes' })
  }
  t.mock.timers.tick(400)
  await settle()
  assert.equal(calls.length, 2)
})

test('a failed refresh preserves both last successful lists and the process uptime timestamp', async t => {
  let fail = false
  const { fleet, key } = await fleetFixture(t, async endpoint => {
    if (fail && endpoint === 'processes') throw new TypeError('failed to fetch')
    if (fail) return Response.json({ ok: false, error: 'offline' })
    return Response.json(endpoint === 'processes'
      ? { processes: [processRow('one'), processRow('two')] }
      : { subagents: [delegation] })
  })
  await fleet.refreshSessionActivity(key)
  const fetchedAt = fleet.activityFetchedAt[key]
  assert.equal(fetchedAt, 1_000)
  assert.equal(fleet.processesBySession[key].length, 2)
  assert.equal(fleet.subagentsBySession[key].length, 1)
  fail = true
  t.mock.timers.tick(2_000)
  await fleet.refreshSessionActivity(key)
  assert.deepEqual(fleet.processesBySession[key].map(item => item.id), ['one', 'two'])
  assert.equal(fleet.subagentsBySession[key][0].id, 'deleg-batch')
  assert.equal(fleet.activityFetchedAt[key], fetchedAt)
  assert.equal(fleet.activityUnavailableBySession[key].processes, false)
  assert.equal(fleet.activityUnavailableBySession[key].subagents, false)
  assert.equal(fleet.lastError, null)
})

test('opens a session despite an initial activity error and hides unsupported endpoints', async t => {
  const { fleet, key, calls } = await fleetFixture(t, endpoint => Response.json(endpoint === 'processes'
    ? { detail: 'Core unavailable' }
    : { unsupported: true }, { status: endpoint === 'processes' ? 503 : 200 }))
  fleet.diffBySession[key] = { files: [], isGitRepo: false }
  fleet.activateSession(key)
  await settle()
  assert.equal(calls.length, 2)
  assert.equal(fleet.currentSession.sessionId, 'chat-session')
  assert.equal(fleet.lastError, null)
  assert.equal(fleet.activityUnavailableBySession[key].processes, true)
  assert.equal(fleet.activityUnavailableBySession[key].subagents, false)
})

test('refreshes on tracked tool completions and on running transitions for inactive sessions', async t => {
  const { fleet, key, session, calls } = await fleetFixture(t)
  const send = update => fleet.handleWsEvent({ ...session, runId: 'run', ...update })
  send({ type: 'Accepted' })
  for (const [index, name] of ['read', 'terminal', 'delegate_task', 'process_manage'].entries()) {
    const callId = `tool-${index}`
    send({ type: 'ToolCall', callId, name })
    assert.equal(calls.length, Math.max(0, (index - 1) * 2))
    send({ type: 'ToolCallUpdate', callId, status: 'completed' })
    await settle()
    assert.equal(calls.length, index * 2)
    t.mock.timers.tick(2_000)
  }
  assert.equal(fleet.activeSessionKey, '')
  assert.equal(fleet.runningBySession[key], 'run')
  send({ type: 'Completed' })
  await settle()
  assert.equal(fleet.runningBySession[key], undefined)
  assert.equal(calls.length, 8)
})

test('a tool finishing during the initial request queues a single refresh after the throttle window', async t => {
  const { fleet, key, session, calls } = await fleetFixture(t)
  const request = fleet.refreshSessionActivity(key)
  for (const callId of ['first', 'second']) {
    fleet.handleWsEvent({ ...session, type: 'ToolCallUpdate', name: 'terminal', callId, status: 'completed' })
  }
  await request
  t.mock.timers.tick(1_999)
  assert.equal(calls.length, 2)
  t.mock.timers.tick(1)
  await settle()
  assert.equal(calls.length, 4)
})

test('clears activity and ignores returning requests when session memory is reset', async t => {
  const releases = []
  const { fleet, key, calls } = await fleetFixture(t, endpoint =>
    new Promise(resolve => releases.push(() => resolve(Response.json({ [endpoint]: [processRow('stale')] })))))
  const request = fleet.refreshSessionActivity(key)
  fleet.clearSessionMemory()
  assert.equal(calls.length, 2)
  assert.ok(calls.every(call => call.options.signal.aborted))
  releases.forEach(resolve => resolve())
  await request
  await nextTick()
  assert.deepEqual(fleet.processesBySession, {})
  assert.deepEqual(fleet.subagentsBySession, {})
  assert.deepEqual(fleet.activityFetchedAt, {})
})

test('switching the auth scope never refreshes the old active or running session on the new route', async t => {
  const { auth, fleet, key, calls } = await fleetFixture(t)
  fleet.activeSessionKey = key
  await nextTick()
  await settle()
  assert.equal(calls.length, 2)
  fleet.runningBySession[key] = 'run'
  t.mock.timers.tick(2_000)
  auth.token = 'other-token'
  await nextTick()
  await settle()
  assert.equal(calls.length, 2)
  assert.equal(fleet.currentSession, null)
  assert.deepEqual(fleet.processesBySession, {})
})

test('Vue activity bar renders no button at zero and omits each zero-count group', async () => {
  const { default: Bar } = await server.ssrLoadModule('/src/components/chat/SessionActivityBar.vue')
  const render = props => renderToString(createSSRApp(Bar, props))
  assert.doesNotMatch(await render({ processCount: 0, subagentCount: 0 }), /<button|后台任务|子代理/)
  const processes = await render({ processCount: 2, subagentCount: 0 })
  assert.match(processes, /<button[^>]+aria-haspopup="dialog"/)
  assert.match(processes, /2 个后台任务/)
  assert.doesNotMatch(processes, /子代理/)
  const subagents = await render({ processCount: 0, subagentCount: 1 })
  assert.match(subagents, /1 个子代理/)
  assert.doesNotMatch(subagents, /后台任务/)
})

test('Vue activity drawer renders the empty state, truncated details and escaped process output', async () => {
  const { default: Drawer } = await server.ssrLoadModule('/src/components/chat/SessionActivityDrawer.vue')
  const render = props => renderToString(createSSRApp(Drawer, props))
  assert.match(await render({ processes: [], subagents: [] }), /当前没有后台任务/)
  const chars = '🧪'.repeat(60)
  const { items: processes } = mapSessionProcesses({ processes: [
    { ...processRow('p', 'completed'), command: chars + 'truncated', pid: 123, uptime_seconds: 65, output_tail: '<script>test</script>' },
  ] })
  const { items: subagents } = mapSessionSubagents({
    subagents: [{ ...delegation, goals: [chars + 'truncated', '第二个目标'] }],
  })
  const html = await render({ processes, subagents })
  assert.match(html, /class="is-ended"/)
  assert.match(html, /<details\b/)
  assert.match(html, /PID 123/)
  assert.match(html, /已运行 1 分 5 秒/)
  assert.match(html, /&lt;script&gt;test&lt;\/script&gt;/)
  assert.equal(html.split(chars + '…').length, 3)
  assert.doesNotMatch(html, /truncated|第二个目标/)
})
