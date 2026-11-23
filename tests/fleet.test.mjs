import test from 'node:test'
import assert from 'node:assert/strict'
import { createPinia, disposePinia } from 'pinia'
import { createServer } from 'vite'
import { effectScope, ref } from 'vue'

import {
  NONCE_BYTES,
  decodeBase64Url,
  decryptChunk,
  downloadAndDecryptBlob,
  encodeBase64Url,
  encryptAndUploadFile,
  encryptChunk,
  generateFileKey,
  sha256Hex,
} from '../src/services/blobTransfer.ts'
import { buildFleetWsUrl, normalizeCoreOrigin } from '../src/services/fleetUrl.ts'
import { useRecordedTokenUsage } from '../src/services/recordedTokenUsage.ts'
import {
  applyTokenUsageEvent,
  estimateTurnUsageFallback,
  formatTokenCount,
  hasRecordedTurnUsage,
  toSessionTokenSummary,
} from '../src/services/tokenUsage.ts'
import { isSafeMarkdownHref, parseMarkdownBlocks, parseMarkdownInlines } from '../src/services/markdownBlocks.ts'
import { highlightCode, inferLanguageFromPath } from '../src/services/syntaxHighlight.ts'
import { hasAnsiSequences, parseAnsiText } from '../src/services/ansiParser.ts'
import { parseMermaidDiagram } from '../src/services/diagramBuilder.ts'
import {
  computeHunkGaps,
  extractToolMiniDiff,
  parseDiffHunks,
  splitDiffPath,
  toSplitDiffRows,
} from '../src/services/diffHelpers.ts'
import { deleteCustomPrompt, loadCustomPrompts, saveCustomPrompt } from '../src/services/customPrompts.ts'
import { buildSessionHtmlReport } from '../src/services/htmlExport.ts'
import {
  buildThreadRenderItems,
  buildTurnRenderItems,
  extractHostMediaDirectives,
  snapToBlockEnd,
  splitTextByInlineMedia,
  stripHostMediaDirectives,
} from '../src/services/messageSegments.ts'
import { resolveSavedModelPref, saveAgentModelPref } from '../src/services/modelPrefs.ts'
import { findProjectPermission } from '../src/services/projectPermissions.ts'
import {
  appendMessagePart,
  branchFromUserMessage,
  buildDiffAnnotationsPrompt,
  buildForkContextSeed,
  buildSessionMarkdown,
  classifyToolKind,
  createPastedTextBlock,
  deriveOptimisticSessionTitle,
  describeToolCall,
  extractMessageParts,
  fuzzyMatchFileScore,
  groupMessageParts,
  isGenericSessionTitle,
  isQuotaOrModelError,
  mergeHistoryBoundaries,
  mergeToolCallUpdate,
  parseCodeBlockLang,
  readTurnTestResult,
  repliedUserMessageIds,
  sameTurnContent,
  searchSessionsAndMessages,
  sessionInboxProject,
  shouldConvertToPastedBlock,
  suggestCommitMessageFromDiff,
  systemEventLabel,
  switchMessageBranch,
} from '../src/services/chatHelpers.ts'

test('a delivery receipt advances only for the current user turn with actual reply content', () => {
  const messages = [
    { id: 'older-user', role: 'user', text: 'first' },
    { id: 'boundary', role: 'system', text: '' },
    { id: 'older-agent', role: 'assistant', text: 'legacy reply' },
    { id: 'sent-user', role: 'user', requestId: 'sent', delivery: 'sent', text: 'second' },
    { id: 'thinking', role: 'assistant', requestId: 'sent', text: '', thought: 'still working' },
    { id: 'tool-user', role: 'user', requestId: 'tools', delivery: 'sent', text: 'run tests' },
    { id: 'tool-agent', role: 'assistant', requestId: 'tools', text: '', toolCalls: [{ id: 'call-1', callId: 'call-1', name: 'shell', status: 'running' }] },
    { id: 'empty-thought-user', role: 'user', requestId: 'blank', delivery: 'sent', text: 'blank' },
    { id: 'blank-agent', role: 'assistant', requestId: 'blank', text: '', thought: '   ' },
    { id: 'replied-user', role: 'user', requestId: 'answered', delivery: 'sent', text: 'third' },
    { id: 'replied-agent', role: 'assistant', requestId: 'answered', text: 'reply' },
    { id: 'waiting-user', role: 'user', requestId: 'pending', delivery: 'sending', text: 'fourth' },
    { id: 'unrelated-agent', role: 'assistant', requestId: 'other', text: 'unrelated reply' },
    { id: 'unbound-agent', role: 'assistant', text: 'reply without a turn ID' },
  ]
  // 思考或工具调用即算 Agent 已响应；空白思考不算。
  assert.deepEqual([...repliedUserMessageIds(messages)], ['older-user', 'sent-user', 'tool-user', 'replied-user'])
})

test('工作记录按单步工具选用操作类别', () => {
  assert.equal(classifyToolKind({ name: 'browser_navigate' }), 'browser')
  assert.equal(classifyToolKind({ name: 'fileChange' }), 'edit')
  assert.equal(classifyToolKind({ name: 'shell' }), 'cmd')
  assert.equal(classifyToolKind({ name: 'read_file' }), 'read')
  assert.equal(classifyToolKind({ name: 'read_file', subagentSessionId: 'child' }), 'subagent')
  assert.equal(describeToolCall({ name: 'tool', title: 'terminal: npm run build' }).icon, 'terminal')
  assert.equal(describeToolCall({ name: 'tool', title: 'read_file: README.md' }).icon, 'file')
  assert.equal(describeToolCall({ name: 'tool', toolKind: 'edit', title: 'Update source' }).icon, 'pencil')
  assert.equal(describeToolCall({ name: 'tool', toolKind: 'search' }).icon, 'search')
  assert.equal(describeToolCall({ name: 'tool', toolKind: 'fetch' }).icon, 'link')
})

test('项目权限匹配最近的目录并保留各系统的路径规则', () => {
  const permissions = [
    { cwd: 'D:\\Projects', mode: 'deny' },
    { cwd: 'D:\\Projects\\Preview', mode: 'read' },
    { cwd: '/work/Preview', mode: 'deny' },
  ]
  assert.equal(findProjectPermission(permissions, 'd:/projects/PREVIEW/src')?.mode, 'read')
  assert.equal(findProjectPermission(permissions, 'd:/projects/Preview2')?.mode, 'deny')
  assert.equal(findProjectPermission(permissions, '/work/preview'), undefined)
  assert.equal(findProjectPermission(permissions, '/work/Preview')?.mode, 'deny')
})

test('工具图标区分命名空间工具、文件操作和单一用途的命令', () => {
  const examples = [
    [{ name: 'mcp__playwright__browser_navigate', toolKind: 'fetch' }, 'browser'],
    [{ name: 'mcp__playwright__browser_take_screenshot', toolKind: 'read' }, 'camera'],
    [{ name: 'WebSearch', toolKind: 'search' }, 'globeSearch'],
    [{ name: 'mcp__workspace__list_directory', toolKind: 'read' }, 'folder'],
    [{ name: 'tool', toolKind: 'move' }, 'move'],
    [{ name: 'tool', toolKind: 'delete' }, 'trash'],
    [{ name: 'functions.exec_command', input: { command: 'git status --short' } }, 'branch'],
    [{ name: 'terminal', input: { command: 'python -m pytest -q' } }, 'testTube'],
    [{ name: 'terminal', input: { command: 'git status && pytest -q' } }, 'terminal'],
    [{ name: 'todowrite', toolKind: 'edit' }, 'checklist'],
    [{ name: 'memory_search', toolKind: 'search' }, 'data'],
    [{ name: 'view_image', toolKind: 'read' }, 'image'],
    [{ name: 'inspect_trace' }, 'trace'],
    [{ name: 'mcp__calendar__get_events' }, 'plug'],
    [{ name: 'tool', title: 'config/file-write.json' }, 'wrench'],
  ]
  for (const [tool, icon] of examples) {
    assert.equal(describeToolCall(tool).icon, icon, tool.name)
  }
})

test('通用工具更新保留已有名称和类别', () => {
  const started = mergeToolCallUpdate([], { callId: 'acp', name: 'read_file', toolKind: 'read', title: 'Open notes' })
  const [finished] = mergeToolCallUpdate(started, { callId: 'acp', name: 'tool', toolKind: 'other', status: 'completed' })
  assert.equal(finished.name, 'read_file')
  assert.equal(finished.toolKind, 'read')
  assert.equal(finished.status, 'completed')
  assert.equal(describeToolCall(finished).icon, 'file')
})

test('收件箱按仓库标识合并不同机器的检出，并保留旧节点的项目文件夹', () => {
  const remote = { projectKey: 'git:shared', projectName: 'studiolo' }
  assert.deepEqual(sessionInboxProject({ ...remote, cwd: 'D:\\work\\first-copy' }),
    sessionInboxProject({ ...remote, cwd: '/home/dev/second-copy' }))
  assert.notEqual(sessionInboxProject({ ...remote, cwd: '/one/studiolo' }).key,
    sessionInboxProject({ ...remote, projectKey: 'git:different', cwd: '/two/studiolo' }).key)
  assert.deepEqual(sessionInboxProject({ cwd: 'D:\\src\\Studiolo\\.studiolo-worktrees\\run-12' }),
    { key: 'folder:studiolo', name: 'Studiolo' })
  assert.equal(sessionInboxProject({ cwd: '/srv/studiolo' }).key, 'folder:studiolo')
})

test('本轮测试统计从最后一次可识别的工具结果读取', () => {
  const pytest = { status: 'completed', input: { command: 'pytest -q' }, output: '=== 12 passed in 0.42s ===' }
  const unsuccessful = { ...pytest, status: 'error', output: '=== 2 failed, 8 passed in 1s ===' }
  assert.deepEqual(readTurnTestResult([pytest, unsuccessful]), { passed: 8, failed: 2, successful: false })
  assert.deepEqual(readTurnTestResult([{ ...pytest, output: 'On branch main\n12 passed in 0.42s' }]),
    { passed: 12, failed: 0, successful: true })
  assert.equal(readTurnTestResult([{ ...pytest, output: 'tests will run' }]), undefined)
  assert.equal(readTurnTestResult([{ ...pytest, input: { command: 'npm run build' } }]), undefined)
})

test('工作记录跟随最新流式事件，早先步骤收到更新时保留时间轴位置', () => {
  const shell = { id: 'shell', name: 'shell', status: 'running', input: { command: 'npm run build' } }
  const message = {
    id: 'progress', role: 'assistant', text: '已准备构建。', streaming: true, toolCalls: [shell],
    parts: [
      { type: 'tool', callId: 'shell' },
      { type: 'text', text: '已准备构建。' },
      { type: 'thought', text: '正在检查构建输出。' },
    ],
  }
  const logsFor = (liveProgress, streaming = true) =>
    buildThreadRenderItems({ ...message, liveProgress, streaming }).filter(item => item.type === 'work-log')
  assert.deepEqual(logsFor({ type: 'thought' }).map(log => log.progress), [undefined, { type: 'thought' }])
  const runningLogs = logsFor({ type: 'tool', callId: 'shell' })
  assert.equal(describeToolCall(runningLogs[0].progress.tool).label, '正在运行命令 · npm run build')
  assert.equal(runningLogs[1].progress, undefined)
  assert.deepEqual(logsFor({ type: 'text' }).at(-1).progress, { type: 'text' })
  assert.ok(logsFor({ type: 'tool', callId: 'shell' }, false).every(log => !log.progress))
})

test('会话快照保留历史、去重压缩事件，并将快照分界线留在后续消息之前', () => {
  const oldest = { id: 'old', role: 'user', text: '历史问题' }
  const reply = { id: 'live-reply', role: 'assistant', text: '完成' }
  const compact = { id: 'compact', role: 'system', systemEvents: [{ kind: 'compacted', at: 10, detail: { retainedTurns: 2 } }] }
  const reconnect = { id: 'reconnect', role: 'system', systemEvents: [{ kind: 'reconnected', at: 20, detail: {} }] }
  const snapReply = { ...reply, id: 'snapshot-reply' }
  const next = { id: 'next', role: 'user', text: '接着做' }
  assert.deepEqual(mergeHistoryBoundaries(
    [oldest, reply, compact, reconnect], [snapReply, compact, next],
  ), [oldest, snapReply, compact, reconnect, next])
  assert.deepEqual(mergeHistoryBoundaries([reconnect], [next]), [next, reconnect])
  assert.equal(systemEventLabel(compact.systemEvents[0]), '上下文已压缩 · 保留最近 2 轮')
})

test('重连快照按会话恢复跟随意图', async t => {
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true },
  })
  t.after(() => server.close())
  const { useFleetStore, sessionKey } = await server.ssrLoadModule('/src/stores/fleet.ts')
  const sockets = []
  class MockSocket {
    static OPEN = 1
    readyState = MockSocket.OPEN
    sent = []
    constructor() { sockets.push(this) }
    send(raw) { this.sent.push(JSON.parse(raw)) }
    close() { this.onclose?.({ code: 1006 }) }
  }
  const originalSocket = globalThis.WebSocket
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  globalThis.WebSocket = MockSocket
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: key => key === 'studiolo:access-token' ? 'test-token' : null, removeItem() {} },
  })
  t.after(() => {
    globalThis.WebSocket = originalSocket
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage)
    else delete globalThis.localStorage
  })

  function reconnect(t, followBefore) {
    const pinia = createPinia()
    const fleet = useFleetStore(pinia)
    t.after(() => {
      fleet.disconnectSocket()
      disposePinia(pinia)
    })
    const session = { nodeId: 'node', provider: 'codex', sessionId: 'session' }
    const key = sessionKey(session.nodeId, session.provider, session.sessionId)
    const receive = frame => fleet.handleWsEvent({ ...session, ...frame })
    fleet.sessionsByKey = { [key]: { ...session, title: '测试会话', cwd: '' } }
    fleet.activeSessionKey = key
    fleet.connectSocket()
    receive({ type: 'FleetSnapshot', nodes: [] })
    fleet.reportFollowIntent(key, followBefore)
    sockets.at(-1).close()
    assert.equal(fleet.wsState, 'reconnecting')
    assert.equal(fleet.snapshotRestorePending(key), true)
    fleet.connectSocket()
    receive({ type: 'FleetSnapshot', nodes: [] })
    const requests = type => sockets.at(-1).sent.filter(frame => frame.type === type)
    const completeHistory = (requestId, messages = [], fields = {}) => {
      receive({ type: 'SessionHistory', requestId, messages, ...fields })
    }
    const replay = ({ snapshotRequired = true } = {}) => receive({
      type: 'SessionStreamReplay', snapshotRequired, events: [], requestId: requests('session.subscribe').at(-1).requestId,
    })
    const requestSnapshot = () => {
      const [ordinary] = requests('session.history')
      replay()
      assert.equal(requests('session.history').length, 2)
      completeHistory(ordinary.requestId)
      assert.equal(fleet.snapshotRestoreVersion(key), 0)
      const [, snapshot] = requests('session.history')
      assert.notEqual(snapshot.requestId, ordinary.requestId)
      return snapshot.requestId
    }
    return { fleet, key, completeHistory, replay, requestSnapshot, requests }
  }

  await t.test('跟随中的会话只在对应的最新页提交后发布一次信号', t => {
    const { fleet, key, completeHistory, replay, requestSnapshot, requests } = reconnect(t, true)
    const requestId = requestSnapshot()
    completeHistory('older', [{ id: 'old', role: 'user', text: '旧消息' }], { beforeCursor: 'cursor' })
    assert.equal(fleet.snapshotRestoreVersion(key), 0)
    completeHistory(requestId, [{ id: 'latest', role: 'assistant', text: '快照回复' }])
    assert.ok(fleet.messagesBySession[key].some(message => message.id === 'latest'))
    assert.equal(fleet.snapshotRestoreVersion(key), 1)
    assert.equal(fleet.snapshotRestorePending(key), false)
    completeHistory(requestId)
    assert.equal(fleet.snapshotRestoreVersion(key), 1)

    fleet.nodes = [{ id: 'node', status: 'online', adapters: [] }]
    const interruptedRequest = fleet.loadSessionHistory(key, true)
    fleet.handleWsEvent({ type: 'NodePresence', nodeId: 'node', status: 'offline' })
    assert.equal(fleet.wsState, 'online')
    assert.equal(fleet.snapshotRestorePending(key), true)
    fleet.handleWsEvent({ type: 'NodePresence', nodeId: 'node', status: 'online' })
    replay()
    const nodeSnapshot = requests('session.history').at(-1).requestId
    assert.notEqual(nodeSnapshot, interruptedRequest)
    completeHistory(interruptedRequest)
    assert.equal(fleet.snapshotRestoreVersion(key), 0)
    completeHistory(nodeSnapshot)
    assert.equal(fleet.snapshotRestoreVersion(key), 2)
  })

  await t.test('重连前已上翻的会话在快照分支解除等待，不发布信号', t => {
    const { fleet, key, completeHistory, requestSnapshot } = reconnect(t, false)
    const requestId = requestSnapshot()
    assert.equal(fleet.snapshotRestorePending(key), false)
    completeHistory(requestId)
    assert.equal(fleet.snapshotRestoreVersion(key), 0)
  })

  await t.test('取消后的空快照不发布信号，连续重连以本次请求为准', t => {
    const { fleet, key, completeHistory, replay, requestSnapshot, requests } = reconnect(t, true)
    const requestId = requestSnapshot()
    fleet.cancelSnapshotFollow(key)
    assert.equal(fleet.snapshotRestorePending(key), false)
    completeHistory(requestId)
    assert.equal(fleet.snapshotRestoreVersion(key), 0)

    sockets.at(-1).close()
    assert.equal(fleet.snapshotRestorePending(key), true)
    fleet.connectSocket()
    fleet.handleWsEvent({ type: 'FleetSnapshot', nodes: [] })
    replay()
    const [nextSnapshot] = requests('session.history')
    completeHistory(requestId)
    assert.equal(fleet.snapshotRestoreVersion(key), 0)
    completeHistory(nextSnapshot.requestId)
    assert.equal(fleet.snapshotRestoreVersion(key), 1)
    assert.equal(fleet.snapshotRestorePending(key), false)

    sockets.at(-1).close()
    fleet.connectSocket()
    fleet.handleWsEvent({ type: 'FleetSnapshot', nodes: [] })
    replay({ snapshotRequired: false })
    assert.equal(fleet.snapshotRestorePending(key), false)
    assert.equal(fleet.snapshotRestoreVersion(key), 0)
  })
})

test('客户端续传状态机按 SPEC 恢复并释放请求', async t => {
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true },
  })
  t.after(() => server.close())
  const { useFleetStore, sessionKey } = await server.ssrLoadModule('/src/stores/fleet.ts')
  const sockets = []
  class MockSocket {
    static OPEN = 1
    readyState = MockSocket.OPEN
    sent = []
    constructor() { sockets.push(this) }
    send(raw) { this.sent.push(JSON.parse(raw)) }
    close() { this.readyState = 3; this.onclose?.({ code: 1006 }) }
  }
  const originalSocket = globalThis.WebSocket
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  globalThis.WebSocket = MockSocket
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: key => key === 'studiolo:access-token' ? 'test-token' : null, removeItem() {} },
  })
  t.after(() => {
    globalThis.WebSocket = originalSocket
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage)
    else delete globalThis.localStorage
  })

  function fixture(t) {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const pinia = createPinia()
    const fleet = useFleetStore(pinia)
    t.after(() => { fleet.disconnectSocket(); disposePinia(pinia) })
    const session = { nodeId: 'node', provider: 'codex', sessionId: 'resync' }
    const key = sessionKey(session.nodeId, session.provider, session.sessionId)
    const receive = frame => fleet.handleWsEvent({ ...session, ...frame })
    fleet.sessionsByKey = { [key]: { ...session, title: '测试续传', cwd: '' } }
    fleet.activeSessionKey = key
    fleet.connectSocket()
    receive({ type: 'FleetSnapshot', nodes: [] })
    const requests = type => sockets.at(-1).sent.filter(frame => frame.type === type)
    const history = (messages = [], fields = {}) => receive({
      type: 'SessionHistory', requestId: requests('session.history').at(-1)?.requestId, messages, ...fields,
    })
    const replay = (events = [], fields = {}) => receive({
      type: 'SessionStreamReplay', requestId: requests('session.subscribe').at(-1)?.requestId,
      streamId: 'stream', incremental: true, active: false, lastSeq: 0, events, ...fields,
    })
    history()
    replay()
    sockets.at(-1).sent.length = 0
    const event = (sequence, fields = {}) => ({
      type: 'TextDelta', streamId: 'stream', sequence, runId: 'run', requestId: 'run',
      text: String(sequence), ...fields,
    })
    const state = () => fleet.streamStateBySession.get(key)
    const text = () => (fleet.messagesBySession[key] ?? []).filter(row => row.role === 'assistant').map(row => row.text)
    const clean = () => {
      assert.equal(fleet.pendingStreamResync.size, 0)
      assert.deepEqual(fleet.pendingHistoryPages, {})
      assert.equal(state().timer, undefined)
      assert.equal(state().snapshotTimer, undefined)
      assert.equal(state().snapshot, undefined)
    }
    return { fleet, key, receive, requests, history, replay, event, state, text, clean,
      socket: () => sockets.at(-1) }
  }

  await t.test('丢帧 1,2,4,5：缓冲当前及后续帧，replay 后集合一致且只应用一次', t => {
    const f = fixture(t)
    const events = [f.event(1, { type: 'Accepted' }), f.event(2, { text: 'A' }),
      f.event(3, { text: 'B' }), f.event(4, { text: 'C' }), f.event(5, { type: 'Completed' })]
    for (const index of [0, 1, 3, 4, 3]) f.receive(events[index])
    assert.deepEqual(f.text(), ['A'])
    assert.deepEqual(f.state().buffer.map(frame => frame.sequence), [4, 5])
    assert.equal(f.requests('session.subscribe').length, 1)
    assert.equal(f.requests('session.subscribe')[0].afterSequence, 2)
    assert.equal(f.requests('session.subscribe')[0].streamId, 'stream')
    f.replay(events.slice(2), { lastSeq: 5 })
    assert.deepEqual(f.text(), ['ABC'])
    assert.equal(f.fleet.lastSeqBySession[f.key], 5)
    assert.equal(f.state().phase, 'live')
    assert.equal(f.state().buffer.length, 0)
    assert.equal(f.fleet.currentIsStreaming, false)
    f.receive(events[3])
    assert.deepEqual(f.text(), ['ABC'])
    f.clean()
  })

  await t.test('乱序 3,1,2,4：等待 replay，按 sequence 冲刷，不乱序渲染', t => {
    const f = fixture(t)
    for (const sequence of [3, 1, 2, 4]) f.receive(f.event(sequence))
    assert.deepEqual(f.text(), [])
    assert.equal(f.fleet.lastSeqBySession[f.key], 0)
    assert.equal(f.requests('session.subscribe')[0].afterSequence, 0)
    f.replay([], { active: true, runId: 'run', lastSeq: 0 })
    assert.deepEqual(f.text(), ['1234'])
    assert.equal(f.fleet.lastSeqBySession[f.key], 4)
    assert.equal(f.state().phase, 'live')
    f.clean()
  })

  await t.test('冲刷后仍有缺口：只提交连续部分，剩余帧继续缓冲并续订', t => {
    const f = fixture(t)
    f.receive(f.event(3))
    f.receive(f.event(5))
    f.replay([f.event(1), f.event(2)], { lastSeq: 2, active: true, runId: 'run' })
    assert.deepEqual(f.text(), ['123'])
    assert.equal(f.fleet.lastSeqBySession[f.key], 3)
    assert.equal(f.state().phase, 'gap')
    assert.deepEqual(f.state().buffer.map(frame => frame.sequence), [5])
    assert.equal(f.requests('session.subscribe').length, 2)
    assert.equal(f.requests('session.subscribe').at(-1).afterSequence, 3)
    f.replay([f.event(4)], { lastSeq: 4, active: true, runId: 'run' })
    assert.deepEqual(f.text(), ['12345'])
    assert.equal(f.state().phase, 'live')
    f.clean()
  })

  await t.test('中途断开保留缺口缓冲，重连 replay 与实时尾部最终一致', t => {
    const f = fixture(t)
    f.receive(f.event(1, { type: 'Accepted' }))
    f.receive(f.event(2, { text: 'A' }))
    f.receive(f.event(4, { text: 'C' }))
    f.socket().close()
    assert.equal(f.fleet.currentIsStreaming, false)
    assert.equal(f.fleet.pendingStreamResync.size, 0)
    assert.deepEqual(f.state().buffer.map(frame => frame.sequence), [4])
    f.fleet.connectSocket()
    f.receive({ type: 'FleetSnapshot', nodes: [] })
    f.receive(f.event(5, { type: 'Completed' }))
    f.replay([f.event(3, { text: 'B' })], { lastSeq: 3, active: true, runId: 'run' })
    assert.deepEqual(f.text(), ['ABC'])
    assert.equal(f.fleet.currentIsStreaming, false)
    assert.equal(f.state().phase, 'live')
    f.clean()
  })

  await t.test('subscribe 超时两次，按 0.5s / 1s 退避，第三次成功；迟到响应无效', t => {
    const f = fixture(t)
    f.receive(f.event(2))
    const first = f.requests('session.subscribe')[0].requestId
    t.mock.timers.tick(4999)
    assert.equal(f.requests('session.subscribe').length, 1)
    t.mock.timers.tick(1)
    assert.equal(f.fleet.pendingStreamResync.size, 0)
    t.mock.timers.tick(499)
    assert.equal(f.requests('session.subscribe').length, 1)
    t.mock.timers.tick(1)
    assert.equal(f.requests('session.subscribe').length, 2)
    t.mock.timers.tick(5000)
    t.mock.timers.tick(999)
    assert.equal(f.requests('session.subscribe').length, 2)
    t.mock.timers.tick(1)
    assert.equal(f.requests('session.subscribe').length, 3)
    f.replay([f.event(1)], { lastSeq: 1, requestId: first })
    assert.deepEqual(f.text(), [])
    f.replay([f.event(1)], { lastSeq: 1, active: true, runId: 'run' })
    assert.deepEqual(f.text(), ['12'])
    assert.equal(f.state().retries, 0)
    assert.equal(f.state().phase, 'live')
    t.mock.timers.tick(20000)
    assert.equal(f.requests('session.subscribe').length, 3)
    f.clean()
  })

  await t.test('永不完成的 subscribe / snapshot：有限重试后超时退出运行态和 resyncing', t => {
    const f = fixture(t)
    f.receive(f.event(1, { type: 'Accepted' }))
    f.receive(f.event(3))
    for (const ms of [5000, 500, 5000, 1000, 5000]) t.mock.timers.tick(ms)
    assert.equal(f.requests('session.subscribe').length, 3)
    assert.equal(f.requests('session.history').length, 1)
    assert.equal(f.state().phase, 'resyncing')
    assert.equal(f.fleet.pendingStreamResync.size, 0)
    t.mock.timers.tick(9999)
    assert.equal(Object.keys(f.fleet.pendingHistoryPages).length, 1)
    t.mock.timers.tick(1)
    assert.equal(f.fleet.historyStateBySession[f.key].state, 'error')
    assert.notEqual(f.state().phase, 'resyncing')
    assert.equal(f.fleet.runningBySession[f.key], undefined)
    assert.equal(f.fleet.currentIsStreaming, false)
    assert.equal(f.fleet.snapshotRestorePending(f.key), false)
    f.clean()
    f.fleet.subscribeSession(f.key)
    f.replay([f.event(2)], { lastSeq: 2, active: false })
    assert.deepEqual(f.text(), ['23'])
    f.clean()
  })

  await t.test('subscribe 永不响应但空快照成功：运行态按未知清理，不保留假 running', t => {
    const f = fixture(t)
    f.receive(f.event(1, { type: 'Accepted' }))
    f.receive(f.event(3))
    for (const ms of [5000, 500, 5000, 1000, 5000]) t.mock.timers.tick(ms)
    f.history([])
    assert.deepEqual(f.text(), [])
    assert.equal(f.fleet.currentIsStreaming, false)
    assert.equal(f.fleet.runningBySession[f.key], undefined)
    assert.equal(f.state().phase, 'live')
    t.mock.timers.tick(30000)
    f.clean()
  })

  await t.test('持续溢出和连续 cursorExpired 不能延长快照恢复的 10s 上限', t => {
    const f = fixture(t)
    for (let seq = 2; seq <= 1002; seq++) f.receive(f.event(seq))
    const first = f.requests('session.history').at(-1).requestId
    t.mock.timers.tick(9000)
    for (let seq = 1003; seq <= 2004; seq++) f.receive(f.event(seq))
    assert.equal(f.state().buffer.length, 1000)
    assert.notEqual(f.requests('session.history').at(-1).requestId, first)
    f.history([], { cursorExpired: true })
    assert.equal(f.state().phase, 'resyncing')
    t.mock.timers.tick(1000)
    assert.equal(f.fleet.historyStateBySession[f.key].state, 'error')
    assert.notEqual(f.state().phase, 'resyncing')
    assert.equal(f.fleet.currentIsStreaming, false)
    f.clean()
  })

  await t.test('快照抢占后的迟到 Error 不终止新 run；发送失败不泄漏请求', t => {
    const f = fixture(t)
    const old = f.fleet.loadSessionHistory(f.key, true)
    f.fleet.subscribeSession(f.key)
    f.replay([], { snapshotRequired: true, lastSeq: 1, active: true, runId: 'run' })
    f.receive({ type: 'Failed', requestId: old, message: 'late history failure' })
    assert.equal(f.fleet.runningBySession[f.key], 'run')
    assert.equal(f.state().phase, 'resyncing')
    f.history([{ role: 'assistant', runId: 'run', text: 'live' }])
    assert.equal(f.fleet.currentIsStreaming, true)
    f.clean()
    f.socket().send = () => { throw new Error('socket closed during send') }
    assert.equal(f.fleet.subscribeSession(f.key), false)
    assert.equal(f.fleet.currentIsStreaming, false)
    assert.equal(f.fleet.historyStateBySession[f.key].state, 'error')
    f.clean()
  })

  await t.test('快照抢占挂起的旧 history；迟到旧页、重复 replay 均不影响快照', t => {
    const f = fixture(t)
    f.receive(f.event(1, { type: 'Accepted' }))
    const oldId = f.fleet.loadSessionHistory(f.key, true)
    f.fleet.subscribeSession(f.key)
    f.replay([], { snapshotRequired: true, lastSeq: 4, active: false })
    const snapshotId = f.requests('session.history').at(-1).requestId
    assert.equal(f.requests('session.history').length, 2)
    assert.notEqual(snapshotId, oldId)
    assert.equal(f.fleet.pendingHistoryPages[f.key], snapshotId)
    assert.equal(f.fleet.lastSeqBySession[f.key], 1)
    f.history([{ id: 'stale', role: 'assistant', text: 'stale' }], { requestId: oldId })
    assert.equal(f.fleet.pendingHistoryPages[f.key], snapshotId)
    f.replay([], { snapshotRequired: true, lastSeq: 500 })
    assert.equal(f.requests('session.history').length, 2)
    f.receive(f.event(5, { text: 'tail' }))
    f.history([{ id: 'snapshot', role: 'assistant', text: 'full' }])
    assert.deepEqual(f.text(), ['full', 'tail'])
    assert.equal(f.fleet.lastSeqBySession[f.key], 5)
    assert.equal(f.state().phase, 'live')
    f.clean()
  })

  await t.test('1000 帧上限：溢出放弃增量发快照，提交前不推进 cursor', t => {
    const f = fixture(t)
    for (let seq = 2; seq <= 1002; seq++) f.receive(f.event(seq))
    assert.equal(f.state().buffer.length, 1000)
    assert.equal(f.requests('session.subscribe').length, 1)
    assert.equal(f.requests('session.history').length, 1)
    assert.match(f.fleet.dumpAuditLog(), /BufferOverflow/)
    assert.equal(f.fleet.lastSeqBySession[f.key], 0)
    f.history([{ id: 'all', role: 'assistant', text: Array.from({ length: 1002 }, (_, i) => String(i + 1)).join('') }])
    assert.deepEqual(f.text(), [Array.from({ length: 1002 }, (_, i) => String(i + 1)).join('')])
    assert.equal(f.fleet.lastSeqBySession[f.key], 1002)
    assert.equal(f.state().buffer.length, 0)
    assert.equal(f.state().phase, 'live')
    f.clean()
  })

  await t.test('history 最新页和旧分页都有 10s 超时，可重试，迟到页不覆盖', t => {
    const f = fixture(t)
    const oldId = f.fleet.loadSessionHistory(f.key, true)
    t.mock.timers.tick(10000)
    assert.equal(f.fleet.historyStateBySession[f.key].state, 'error')
    f.clean()
    const newId = f.fleet.loadSessionHistory(f.key, true)
    assert.notEqual(oldId, newId)
    f.history([{ id: 'bad', role: 'user', text: 'late' }], { requestId: oldId })
    assert.equal(f.fleet.pendingHistoryPages[f.key], newId)
    f.history([{ id: 'new', role: 'user', text: 'new' }], { historyCursor: 'older-cursor' })
    assert.deepEqual(f.fleet.messagesBySession[f.key].map(row => row.id), ['new'])
    assert.equal(f.fleet.requestOlderHistory(f.key), true)
    assert.equal(f.requests('session.history').at(-1).beforeCursor, 'older-cursor')
    t.mock.timers.tick(10000)
    assert.equal(f.fleet.historyStateBySession[f.key].state, 'error')
    assert.equal(f.fleet.requestOlderHistory(f.key), true)
    f.history([{ id: 'older', role: 'user', text: 'older' }], { beforeCursor: 'older-cursor' })
    assert.deepEqual(f.fleet.messagesBySession[f.key].map(row => row.id), ['older', 'new'])
    f.clean()
  })

  await t.test('非 snapshotRequired replay 的 active/runId 也对账；UI 只看 streaming', t => {
    const f = fixture(t)
    f.fleet.runningBySession[f.key] = 'metadata-only'
    assert.equal(f.fleet.currentIsStreaming, false)
    f.receive(f.event(1, { type: 'Accepted' }))
    assert.equal(f.fleet.currentIsStreaming, true)
    f.fleet.subscribeSession(f.key)
    f.replay([], { lastSeq: 1, active: false })
    assert.equal(f.fleet.runningBySession[f.key], undefined)
    assert.equal(f.fleet.currentIsStreaming, false)
    f.fleet.subscribeSession(f.key)
    f.replay([], { lastSeq: 1, active: true, runId: 'different-run' })
    assert.equal(f.fleet.runningBySession[f.key], 'different-run')
    assert.equal(f.fleet.currentIsStreaming, false)
    assert.ok(f.fleet.messagesBySession[f.key].every(message => !message.streaming))
    f.clean()
  })

  await t.test('快照后仅当前 active run 的消息 streaming；stream 更换不降 session 水位', t => {
    const f = fixture(t)
    f.receive(f.event(1, { type: 'Accepted' }))
    f.fleet.subscribeSession(f.key)
    f.replay([], { snapshotRequired: true, lastSeq: 10, active: true, runId: 'next' })
    f.history([{ id: 'old-run', role: 'assistant', runId: 'run', text: 'old' },
      { id: 'new-run', role: 'assistant', runId: 'next', text: 'new' }])
    assert.deepEqual(f.fleet.messagesBySession[f.key].filter(message => message.streaming).map(message => message.runId), ['next'])
    assert.equal(f.fleet.lastSeqBySession[f.key], 10)
    f.receive(f.event(1, { streamId: 'replacement', text: 'generation' }))
    f.replay([], { streamId: 'replacement', snapshotRequired: true, lastSeq: 1, active: false })
    f.history([{ id: 'replaced', role: 'assistant', text: 'generation' }])
    assert.equal(f.fleet.lastSeqBySession[f.key], 10)
    f.receive(f.event(2, { streamId: 'replacement', text: '2' }))
    assert.deepEqual(f.text(), ['generation', '2'])
    f.fleet.subscribeSession(f.key)
    assert.equal(f.requests('session.subscribe').at(-1).afterSequence, 2)
    f.replay([], { streamId: 'replacement', lastSeq: 2 })
    assert.equal(f.fleet.lastSeqBySession[f.key], 10)
    f.clean()
  })

  await t.test('Web 事件应用抛异常：审计可见、不推进 cursor，只触发一次 resync', t => {
    const f = fixture(t)
    f.receive(f.event(1, { type: 'Accepted' }))
    // The native channel can also deliver objects with failing getters; Web uses a throwing state accessor.
    const messages = f.fleet.messagesBySession[f.key]
    messages[0].parts = { map() { throw new Error('injected apply failure') } }
    const frame = f.event(2, { text: 'broken' })
    f.socket().onmessage({ data: JSON.stringify({ nodeId: 'node', provider: 'codex', sessionId: 'resync', ...frame }) })
    assert.equal(f.fleet.lastSeqBySession[f.key], 1)
    assert.match(f.fleet.dumpAuditLog(), /seq=2.*ApplyError.*injected apply failure/)
    assert.equal(f.requests('session.history').length, 1)
    f.receive(f.event(3))
    assert.equal(f.requests('session.history').length, 1)
    messages[0].parts = []
    f.history([{ id: 'fixed', role: 'assistant', runId: 'run', text: 'recovered' }])
    assert.deepEqual(f.text(), ['recovered3'])
    assert.equal(f.fleet.lastSeqBySession[f.key], 3)
    f.clean()
  })

  await t.test('快照应用异常不提交 lastSeq；结束为错误态，可重新订阅恢复', t => {
    const f = fixture(t)
    f.receive(f.event(1, { type: 'Accepted' }))
    f.fleet.subscribeSession(f.key)
    f.replay([], { snapshotRequired: true, lastSeq: 50 })
    f.history([{ role: 'assistant', text: 'bad', parts: [null] }])
    assert.equal(f.fleet.lastSeqBySession[f.key], 1)
    assert.equal(f.fleet.historyStateBySession[f.key].state, 'error')
    assert.notEqual(f.state().phase, 'resyncing')
    assert.match(f.fleet.dumpAuditLog(), /ApplyError/)
    assert.equal(f.requests('session.history').length, 1)
    f.clean()
    f.fleet.subscribeSession(f.key)
    f.replay([], { snapshotRequired: true, lastSeq: 50 })
    f.history([{ id: 'fixed', role: 'assistant', text: 'fixed' }])
    assert.equal(f.fleet.lastSeqBySession[f.key], 50)
    assert.equal(f.state().phase, 'live')
    f.clean()
  })

  await t.test('普通 history 超时不会取消 subscribe 的独立重试', t => {
    const f = fixture(t)
    f.fleet.loadSessionHistory(f.key, true)
    f.receive(f.event(2))
    for (const ms of [5000, 500, 4500]) t.mock.timers.tick(ms)
    assert.deepEqual(f.fleet.pendingHistoryPages, {})
    assert.equal(f.fleet.pendingStreamResync.size, 1)
    t.mock.timers.tick(500)
    t.mock.timers.tick(1000)
    assert.equal(f.requests('session.subscribe').length, 3)
    f.replay([f.event(1)], { lastSeq: 1, active: true, runId: 'run' })
    assert.deepEqual(f.text(), ['12'])
    f.clean()
  })

  await t.test('快照 cursorExpired 重新发最新页并保持快照对账，空快照也清理旧 streaming', t => {
    const f = fixture(t)
    f.receive(f.event(1, { type: 'Accepted' }))
    f.fleet.subscribeSession(f.key)
    f.replay([], { snapshotRequired: true, lastSeq: 20, active: false })
    const expiredId = f.requests('session.history').at(-1).requestId
    f.history([], { cursorExpired: true })
    assert.equal(f.requests('session.history').length, 2)
    assert.notEqual(f.requests('session.history').at(-1).requestId, expiredId)
    assert.equal(f.fleet.lastSeqBySession[f.key], 1)
    f.history([])
    assert.equal(f.fleet.lastSeqBySession[f.key], 20)
    assert.equal(f.fleet.currentIsStreaming, false)
    assert.deepEqual(f.text(), [])
    assert.equal(f.state().phase, 'live')
    f.clean()
  })

  await t.test('失败响应、节点掉线、删除和主动断开均释放 pending 及 timer', t => {
    const f = fixture(t)
    f.receive(f.event(2))
    f.receive({ type: 'Error', requestId: f.requests('session.subscribe').at(-1).requestId, message: 'retry' })
    assert.equal(f.fleet.pendingStreamResync.size, 0)
    t.mock.timers.tick(500)
    f.replay([], { snapshotRequired: true, lastSeq: 2 })
    f.receive({ type: 'Failed', requestId: f.requests('session.history').at(-1).requestId, message: 'history failed' })
    assert.equal(f.fleet.historyStateBySession[f.key].state, 'error')
    f.clean()
    f.fleet.nodes = [{ id: 'node', status: 'online', adapters: [] }]
    f.fleet.subscribeSession(f.key)
    f.fleet.loadSessionHistory(f.key, true)
    f.receive({ type: 'NodePresence', nodeId: 'node', status: 'offline' })
    f.clean()
    f.receive({ type: 'NodePresence', nodeId: 'node', status: 'online' })
    assert.equal(f.fleet.pendingStreamResync.size, 1)
    f.receive({ type: 'SessionDeleted' })
    assert.equal(f.fleet.streamStateBySession.has(f.key), false)
    assert.equal(f.fleet.pendingStreamResync.size, 0)
    assert.deepEqual(f.fleet.pendingHistoryPages, {})
    f.fleet.disconnectSocket()
    t.mock.timers.tick(30000)
    assert.equal(f.fleet.wsState, 'disconnected')
    assert.equal(f.fleet.pendingStreamResync.size, 0)
    assert.deepEqual(f.fleet.pendingHistoryPages, {})
  })
  await t.test('Native Tauri 入口应用异常同样进入诊断并 resync，后续 channel 帧继续处理', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const previousWindow = globalThis.window
    const previousIsTauri = globalThis.isTauri
    const sent = []
    let channel
    globalThis.isTauri = true
    globalThis.window = {
      addEventListener() {},
      removeEventListener() {},
      localStorage: globalThis.localStorage,
      sessionStorage: { removeItem() {} },
      __TAURI_INTERNALS__: {
        transformCallback() { return 1 },
        unregisterCallback() {},
        async invoke(command, args) {
          if (command === 'desktop_platform') return 'macos'
          if (command === 'fleet_connect') channel = args.events
          if (command === 'fleet_send') sent.push(args.frame)
        },
      },
    }
    const { initializeDesktopPlatform } = await server.ssrLoadModule('/src/desktop/platform.ts')
    await initializeDesktopPlatform()
    const pinia = createPinia()
    let fleet
    t.after(async () => {
      fleet?.disconnectSocket()
      disposePinia(pinia)
      if (previousWindow === undefined) delete globalThis.window
      else globalThis.window = previousWindow
      if (previousIsTauri === undefined) delete globalThis.isTauri
      else globalThis.isTauri = previousIsTauri
      await initializeDesktopPlatform()
    })
    fleet = useFleetStore(pinia)
    const session = { nodeId: 'native-node', provider: 'codex', sessionId: 'native-session' }
    const key = sessionKey(session.nodeId, session.provider, session.sessionId)
    fleet.sessionsByKey = { [key]: { ...session, title: 'native', cwd: '' } }
    fleet.activeSessionKey = key
    fleet.connectSocket()
    assert.ok(channel)
    const receive = frame => channel.onmessage({ event: 'frame', frame: { ...session, ...frame } })
    receive({ type: 'FleetSnapshot', nodes: [] })
    receive({ type: 'SessionHistory', requestId: sent.find(frame => frame.type === 'session.history').requestId, messages: [] })
    receive({ type: 'SessionStreamReplay', requestId: sent.find(frame => frame.type === 'session.subscribe').requestId,
      events: [], streamId: 'native-stream', lastSeq: 0, active: false, incremental: true })
    receive({ type: 'Accepted', runId: 'run', requestId: 'run', streamId: 'native-stream', sequence: 1 })
    const frame = { ...session, type: 'TextDelta', streamId: 'native-stream', sequence: 2, runId: 'run', requestId: 'run' }
    Object.defineProperty(frame, 'text', { get() { throw new Error('native injected failure') } })
    channel.onmessage({ event: 'frame', frame })
    assert.equal(fleet.lastSeqBySession[key], 1)
    assert.match(fleet.dumpAuditLog(), /seq=2.*ApplyError.*native injected failure/)
    assert.equal(sent.filter(frame => frame.type === 'session.history').length, 2)
    receive({ type: 'TextDelta', streamId: 'native-stream', sequence: 3, runId: 'run', requestId: 'run', text: 'C' })
    receive({ type: 'SessionHistory', requestId: sent.filter(frame => frame.type === 'session.history').at(-1).requestId,
      messages: [{ id: 'recovered', role: 'assistant', runId: 'run', text: 'AB' }] })
    assert.deepEqual(fleet.messagesBySession[key].filter(message => message.role === 'assistant').map(message => message.text), ['ABC'])
    assert.equal(fleet.lastSeqBySession[key], 3)
    assert.equal(fleet.pendingStreamResync.size, 0)
    assert.deepEqual(fleet.pendingHistoryPages, {})
    assert.equal(fleet.streamStateBySession.get(key).phase, 'live')
    channel.onmessage({ event: 'reconnecting' })
    assert.equal(fleet.currentIsStreaming, false)
    assert.equal(fleet.pendingStreamResync.size, 0)
    assert.deepEqual(fleet.pendingHistoryPages, {})
  })

})

test('首页实测用量按代理轮次去重并隔离本机记录', t => {
  const data = {
    getItem(key) { return this[key] ?? null },
    setItem(key, value) { Object.defineProperty(this, key, { value, enumerable: true, configurable: true, writable: true }) },
    removeItem(key) { delete this[key] },
  }
  for (const key of ['getItem', 'setItem', 'removeItem']) Object.defineProperty(data, key, { enumerable: false })
  t.mock.method(Date, 'now', () => 1_790_000_000_000)
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: data })
  t.after(() => {
    if (storage) Object.defineProperty(globalThis, 'localStorage', storage)
    else delete globalThis.localStorage
  })

  const account = ref('account-1')
  const firstScope = effectScope()
  t.after(() => firstScope.stop())
  const usage = firstScope.run(() => useRecordedTokenUsage(account))
  const session = 'node::adapter::session'
  usage.record(session, { runId: 'estimated', source: 'estimated', inputTokens: 100 })
  usage.record(session, { runId: 'cumulative-only', source: 'exact', scope: 'cumulative', inputTokens: 1000 })
  assert.equal(usage.entries.value.size, 0)

  const measured = { runId: 'run', requestId: 'request', source: 'exact' }
  usage.record(session, { ...measured, messageId: 'first', inputTokens: 100, cachedInputTokens: 75, outputTokens: 20 }, 3)
  usage.record(session, { ...measured, messageId: 'second', inputTokens: 30, outputTokens: 8 }, 4)
  usage.record(session, { ...measured, messageId: 'first', inputTokens: 10 }, 2)
  assert.equal(usage.entries.value.size, 1)
  assert.equal([...usage.entries.value.values()][0].total, 158)

  usage.record(session, { ...measured, scope: 'cumulative', totalTokens: 1000, lastInputTokens: 140, lastCachedInputTokens: 80, lastOutputTokens: 20, lastTotalTokens: 165 }, 5)
  const totals = { recordedAt: Date.now(), total: 165, cached: 80, otherInput: 60, output: 20, other: 5 }
  assert.deepEqual([...usage.entries.value.values()], [totals])

  firstScope.stop()
  const reopenedScope = effectScope()
  t.after(() => reopenedScope.stop())
  const reopened = reopenedScope.run(() => useRecordedTokenUsage(account))
  assert.deepEqual([...reopened.entries.value.values()], [totals])
  account.value = 'account-2'
  assert.equal(reopened.entries.value.size, 0)
  account.value = 'account-1'
  assert.deepEqual([...reopened.entries.value.values()], [totals])
})

test('AES-256-GCM 分块加解密、Base64URL 编解码与防篡改校验', async () => {
  const key = generateFileKey()
  assert.equal(key.byteLength, 32)
  const keyB64 = encodeBase64Url(key)
  assert.deepEqual(decodeBase64Url(keyB64), key)

  const plaintext = new TextEncoder().encode('Studiolo 跨设备文件总线 · 测试正文 #01')
  const aadContext = 'blob-aad-context-1'
  const cipher = await encryptChunk(key, aadContext, 0, plaintext)
  assert.equal(cipher.byteLength, NONCE_BYTES + plaintext.byteLength + 16)

  const decrypted = await decryptChunk(key, aadContext, 0, cipher)
  assert.deepEqual(decrypted, plaintext)

  // 篡改密文或分块序号 AAD 必须抛出解密校验异常
  const tampered = cipher.slice()
  tampered[tampered.byteLength - 1] ^= 0xff
  await assert.rejects(() => decryptChunk(key, aadContext, 0, tampered))
  await assert.rejects(() => decryptChunk(key, aadContext, 1, cipher))
})

test('WebSocket URL 构造绝不携带 token 查询参数', () => {
  assert.equal(buildFleetWsUrl('https://studiolo.example.com/', ''), 'wss://studiolo.example.com/ws/fleet/client')
  assert.equal(buildFleetWsUrl('http://127.0.0.1:48197', ''), 'ws://127.0.0.1:48197/ws/fleet/client')
  assert.equal(buildFleetWsUrl('', 'https://app.studiolo.org'), 'wss://app.studiolo.org/ws/fleet/client')
  assert.equal(buildFleetWsUrl('https://core.local').includes('token='), false)
})

test('Core 地址仅接受 HTTPS 或可用于开发的 HTTP 回环地址', () => {
  assert.equal(normalizeCoreOrigin(' https://Core.example:8443/ '), 'https://core.example:8443')
  assert.equal(normalizeCoreOrigin('http://127.0.0.1:28000/'), 'http://127.0.0.1:28000')
  assert.throws(() => normalizeCoreOrigin('http://core.example'))
  assert.throws(() => normalizeCoreOrigin('https://core.example/api'))
  assert.throws(() => normalizeCoreOrigin('https://user@core.example'))
  assert.throws(() => normalizeCoreOrigin('https://core.example/?token=example'))
})

test('浏览器端加密上传 + LAN 不可达自动降级 Core 下载解密端到端闭环', async () => {
  const originalFetch = globalThis.fetch
  const storedChunks = new Map()
  let initPayloadSeen = null
  const lanDownloadRequests = []
  const coreDownloadRequests = []

  globalThis.fetch = async (url, options = {}) => {
    const u = String(url)
    if (u.endsWith('/api/v1/fleet/artifacts/init')) {
      initPayloadSeen = JSON.parse(options.body)
      return new Response(
        JSON.stringify({
          blob: {
            id: 'blob-demo-1',
            workspaceId: 'ws-1',
            uploaderKind: 'user',
            uploaderId: '1',
            purpose: 'fleet_artifact',
            digest: initPayloadSeen.digest,
            ciphertextSize: initPayloadSeen.ciphertextSize,
            chunkSize: initPayloadSeen.chunkSize,
            chunkCount: initPayloadSeen.chunkCount,
            storageRole: 'core',
            storageLocation: '',
            manifest: initPayloadSeen.manifest,
            committedAt: null,
            expiresAt: null,
            createdAt: new Date().toISOString(),
          },
          endpoints: [
            { kind: 'core', url: '/api/v1/fleet/artifacts/blob-demo-1', priority: 90, label: 'Core' },
          ],
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      )
    }
    if (u.includes('/chunks/') && options.method === 'PUT') {
      const idx = Number(u.split('/chunks/')[1])
      const bytes = new Uint8Array(options.body)
      const digest = await sha256Hex(bytes)
      assert.equal(digest, options.headers['X-Chunk-Sha256'])
      storedChunks.set(idx, bytes)
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    if (u.endsWith('/commit')) {
      return new Response(JSON.stringify({ id: 'blob-demo-1' }), { status: 200 })
    }
    if (u.endsWith('/endpoints')) {
      return new Response(
        JSON.stringify({
          blob: {
            id: 'blob-demo-1',
            chunkCount: storedChunks.size,
          },
          endpoints: [
            { kind: 'lan', url: 'http://192.168.199.99:49100/artifacts/blob-demo-1', priority: 10, label: 'LAN' },
            { kind: 'core', url: '/api/v1/fleet/artifacts/blob-demo-1', priority: 90, label: 'Core' },
          ],
        }),
        { status: 200 },
      )
    }
    if (u.startsWith('http://192.168.199.99')) {
      lanDownloadRequests.push(options.headers)
      throw new Error('ECONNREFUSED simulated LAN unreachable')
    }
    if (u.includes('/api/v1/fleet/artifacts/blob-demo-1/chunks/')) {
      coreDownloadRequests.push({ url: u, headers: options.headers })
      const idx = Number(u.split('/chunks/')[1])
      return new Response(storedChunks.get(idx), { status: 200 })
    }
    throw new Error(`Unexpected fetch: ${u}`)
  }

  try {
    const raw = new Uint8Array(9000)
    for (let i = 0; i < raw.length; i += 1) raw[i] = i % 251
    const file = new File([raw], 'report.tar.gz', { type: 'application/gzip' })

    const ref = await encryptAndUploadFile({
      file,
      token: 'jwt-test',
      apiBaseUrl: 'http://127.0.0.1:48197',
      chunkSize: 4096,
    })

    assert.equal(ref.chunkCount, 3)
    assert.ok(ref.keyB64)
    // 核实提交给后端初始化接口的 JSON 绝不包含密钥明文
    assert.equal(JSON.stringify(initPayloadSeen).includes(ref.keyB64), false)

    const result = await downloadAndDecryptBlob({
      artifact: { ...ref, directToken: 'transfer-test' },
      token: 'jwt-test',
      apiBaseUrl: 'http://127.0.0.1:48197',
    })
    assert.equal(result.transport, 'core')
    assert.equal(result.fileName, 'report.tar.gz')
    assert.deepEqual(lanDownloadRequests, [{ 'X-Transfer-Token': 'transfer-test' }])
    assert.equal(coreDownloadRequests.length, 3)
    for (const request of coreDownloadRequests) {
      assert.equal(new URL(request.url).origin, 'http://127.0.0.1:48197')
      assert.deepEqual(request.headers, { Authorization: 'Bearer jwt-test' })
    }
    const outBytes = new Uint8Array(await result.blob.arrayBuffer())
    assert.deepEqual(outBytes, raw)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Token 用量累加支持按轮次幂等更新、累计快照防重以及无遥测回退估算', () => {
  // 1. 按 messageId / turn 幂等更新（OpenCode SSE 多次推送同一消息不重复累加）
  let turnState = applyTokenUsageEvent(undefined, {
    runId: 'run-1',
    messageId: 'msg-1',
    scope: 'turn',
    inputTokens: 500,
    cachedInputTokens: 200,
    outputTokens: 60,
    reasoningTokens: 10,
    totalTokens: 560,
    source: 'exact',
  })
  turnState = applyTokenUsageEvent(turnState, {
    runId: 'run-1',
    messageId: 'msg-1',
    scope: 'turn',
    inputTokens: 500,
    cachedInputTokens: 200,
    outputTokens: 120,
    reasoningTokens: 25,
    totalTokens: 620,
    source: 'exact',
  })
  turnState = applyTokenUsageEvent(turnState, {
    runId: 'run-2',
    messageId: 'msg-2',
    scope: 'turn',
    inputTokens: 640,
    cachedInputTokens: 450,
    outputTokens: 180,
    totalTokens: 820,
    contextWindow: 128000,
    source: 'exact',
  })
  const turnSummary = toSessionTokenSummary(turnState)
  assert.ok(turnSummary)
  assert.equal(turnSummary.turns, 2)
  assert.equal(turnSummary.totalTokens, 1440)
  assert.equal(turnSummary.totalCachedTokens, 650)
  assert.equal(turnSummary.lastTurnTokens, 820)
  assert.equal(turnSummary.contextWindow, 128000)
  assert.equal(turnSummary.source, 'exact')
  assert.equal(hasRecordedTurnUsage(turnState, ['run-1']), true)
  assert.equal(hasRecordedTurnUsage(turnState, ['run-2']), true)

  // 2. Codex cumulative 快照：同一会话多次更新不叠加，仅按最近一轮算上下文占用，并防止 Completed 重复回退
  let codexState = applyTokenUsageEvent(undefined, {
    runId: 'turn-1',
    scope: 'cumulative',
    inputTokens: 900,
    cachedInputTokens: 300,
    outputTokens: 200,
    totalTokens: 1100,
    lastInputTokens: 900,
    lastOutputTokens: 200,
    lastTotalTokens: 1100,
    contextWindow: 200000,
    source: 'exact',
  })
  codexState = applyTokenUsageEvent(codexState, {
    runId: 'turn-2',
    scope: 'cumulative',
    inputTokens: 2100,
    cachedInputTokens: 1200,
    outputTokens: 420,
    totalTokens: 2520,
    lastInputTokens: 1200,
    lastOutputTokens: 220,
    lastTotalTokens: 1420,
    contextWindow: 200000,
    source: 'exact',
  })
  assert.equal(hasRecordedTurnUsage(codexState, ['turn-2']), true)
  const codexSummary = toSessionTokenSummary(codexState)
  assert.ok(codexSummary)
  assert.equal(codexSummary.turns, 2)
  assert.equal(codexSummary.totalTokens, 2520)
  assert.equal(codexSummary.lastTurnTokens, 1420)

  // 3. 回退估算与紧凑格式化
  const est = estimateTurnUsageFallback('请检查项目状态', '先扫描 git', '当前工作区干净。', { runId: 'run-est' })
  const estState = applyTokenUsageEvent(undefined, est)
  const estSummary = toSessionTokenSummary(estState)
  assert.ok(estSummary && estSummary.totalTokens > 0)
  assert.equal(estSummary.source, 'estimated')
  assert.equal(formatTokenCount(850), '850')
  assert.equal(formatTokenCount(1420), '1.4k')
  assert.equal(formatTokenCount(128000), '128k')
  assert.equal(formatTokenCount(1_250_000), '1.3M')
})

test('Markdown 块级与行内 AST 解析支持代码围栏、表格及危险协议过滤', () => {
  assert.equal(isSafeMarkdownHref('https://studiolo.local/docs'), 'https://studiolo.local/docs')
  assert.equal(isSafeMarkdownHref('mailto:dev@studiolo.local'), 'mailto:dev@studiolo.local')
  assert.equal(isSafeMarkdownHref('javascript:alert(1)'), null)
  assert.equal(isSafeMarkdownHref('data:text/html,<script>1</script>'), null)

  const inlines = parseMarkdownInlines('点击 [恶意](javascript:alert(1)) 与 [官网](https://example.com) 及 `npm run build`')
  assert.equal(inlines.some(t => t.type === 'link' && t.href.startsWith('javascript:')), false)
  assert.equal(inlines.some(t => t.type === 'link' && t.href === 'https://example.com/' && t.text === '官网'), true)
  assert.equal(inlines.some(t => t.type === 'code' && t.text === 'npm run build'), true)

  const md = [
    '## 状态总结',
    '',
    '> 仅驻留内存',
    '',
    '| 指标 | 值 |',
    '| --- | --- |',
    '| 用例 | **100%** |',
    '',
    '```ts',
    'const ok = true',
  ].join('\n')

  const blocks = parseMarkdownBlocks(md)
  assert.equal(blocks[0].type, 'heading')
  assert.equal(blocks[1].type, 'blockquote')
  assert.equal(blocks[2].type, 'table')
  if (blocks[2].type === 'table') {
    assert.equal(blocks[2].headers.length, 2)
    assert.equal(blocks[2].rows[0][1][0].type, 'bold')
  }
  assert.equal(blocks[3].type, 'code')
  if (blocks[3].type === 'code') {
    assert.equal(blocks[3].lang, 'ts')
    assert.equal(blocks[3].streamingOpen, true)
    assert.equal(blocks[3].code, 'const ok = true')
  }
})

test('工具调用增量合并、对话编辑分叉切换、跨消息搜索与 Markdown 导出', () => {
  // 1. ToolCallUpdate 按 callId 原地合并增量输出与完成时长
  let tools = mergeToolCallUpdate(undefined, {
    callId: 'tc-1',
    name: 'shell',
    title: 'pytest -q',
    status: 'running',
    input: { command: 'pytest -q' },
  })
  assert.equal(tools.length, 1)
  assert.equal(tools[0].status, 'running')

  tools = mergeToolCallUpdate(tools, {
    callId: 'tc-1',
    name: 'shell',
    status: 'running',
    deltaOutput: 'line 1\n',
  })
  tools = mergeToolCallUpdate(tools, {
    callId: 'tc-1',
    name: 'shell',
    status: 'completed',
    deltaOutput: 'line 2\n',
    durationMs: 42,
  })
  assert.equal(tools.length, 1)
  assert.equal(tools[0].status, 'completed')
  assert.equal(tools[0].output, 'line 1\nline 2\n')
  assert.equal(tools[0].durationMs, 42)
  assert.deepEqual(tools[0].input, { command: 'pytest -q' })

  // 2. 用户编辑重发形成分支并可无损切回原分支
  const baseMsgs = [
    { id: 'u-1', role: 'user', nodeId: 'n1', provider: 'mock', text: '第一问', createdAt: 1 },
    { id: 'a-1', role: 'assistant', nodeId: 'n1', provider: 'mock', text: '第一答', createdAt: 2 },
  ]
  const branched = branchFromUserMessage(baseMsgs, 0, '改问角度 B', 3)
  assert.equal(branched.length, 1)
  assert.equal(branched[0].text, '改问角度 B')
  assert.equal(branched[0].activeBranchIndex, 1)
  assert.equal(branched[0].branches?.length, 2)

  const branchBWithReply = [
    ...branched,
    { id: 'a-2', role: 'assistant', nodeId: 'n1', provider: 'mock', text: '角度 B 回复', createdAt: 4 },
  ]
  const restoredA = switchMessageBranch(branchBWithReply, 0, 0)
  assert.equal(restoredA[0].text, '第一问')
  assert.equal(restoredA[1].text, '第一答')
  const restoredB = switchMessageBranch(restoredA, 0, 1)
  assert.equal(restoredB[0].text, '改问角度 B')
  assert.equal(restoredB[1].text, '角度 B 回复')

  // 3. 跨会话标题/正文搜寻 + Markdown 导出
  const sess = { sessionId: 's1', nodeId: 'n1', provider: 'mock', title: '重构认证模块', cwd: '/repo' }
  const hits = searchSessionsAndMessages(
    [{ key: 'n1::mock::s1', session: sess, nodeName: 'Mac-Mini' }],
    { 'n1::mock::s1': branchBWithReply },
    '角度 B',
  )
  assert.equal(hits.get('n1::mock::s1')?.matchedIn, 'message')
  assert.ok(hits.get('n1::mock::s1')?.snippet?.includes('角度 B'))

  const md = buildSessionMarkdown(sess, [
    baseMsgs[0],
    { ...baseMsgs[1], thought: '核对鉴权边界', toolCalls: tools, diffSummary: { filesChanged: 1, additions: 3, deletions: 1 } },
  ], 'Mac-Mini')
  assert.ok(md.includes('# 重构认证模块'))
  assert.ok(md.includes('核对鉴权边界'))
  assert.ok(md.includes('Tool** `shell` [OK] (42ms)'))
  assert.ok(md.includes('+3 / -1'))
})

test('有序消息时间轴 parts、语法高亮、ANSI 解析与 Mermaid 矢量布局生成', () => {
  // 1. 有序时间轴 parts 归并与回退兼容
  let parts = appendMessagePart(undefined, { type: 'thought', text: '先检查 ' })
  parts = appendMessagePart(parts, { type: 'thought', text: '日志' })
  parts = appendMessagePart(parts, { type: 'tool', callId: 'c1' })
  parts = appendMessagePart(parts, { type: 'tool', callId: 'c1' })
  parts = appendMessagePart(parts, { type: 'text', text: '第一段总结 ' })
  parts = appendMessagePart(parts, { type: 'thought', text: '继续验证' })
  parts = appendMessagePart(parts, { type: 'text', text: '最终结论' })

  assert.deepEqual(
    parts.map(p => p.type),
    ['thought', 'tool', 'text', 'thought', 'text'],
  )
  assert.equal(parts[0].type === 'thought' && parts[0].text, '先检查 日志')
  assert.equal(parts[2].type === 'text' && parts[2].text, '第一段总结 ')

  const legacyFallback = extractMessageParts({ thought: 't', text: 'hi', toolCalls: [{ id: 't1', callId: 't1', name: 'read' }] })
  assert.deepEqual(legacyFallback.map(p => p.type), ['thought', 'tool', 'text'])

  // 2. 零依赖语法高亮（支持跨行块注释与后缀推断）
  assert.equal(inferLanguageFromPath('src/components/App.vue'), 'vue')
  const hl = highlightCode('/* multi\nline */\nexport const count = 42', 'ts')
  assert.equal(hl[0][0].kind, 'comment')
  assert.equal(hl[1][0].kind, 'comment')
  assert.equal(hl[2][0].kind, 'keyword')
  assert.ok(hl[2].some(s => s.kind === 'number' && s.text === '42'))

  // 3. ANSI 终端颜色解析
  const rawAnsi = '\u001b[1;32mPASS\u001b[0m \u001b[31mERR\u001b[0m'
  assert.equal(hasAnsiSequences(rawAnsi), true)
  const spans = parseAnsiText(rawAnsi)
  assert.equal(spans[0].text, 'PASS')
  assert.equal(spans[0].bold, true)
  assert.equal(spans[0].fg, '#16a34a')
  assert.equal(spans[2].text, 'ERR')
  assert.equal(spans[2].fg, '#dc2626')

  // 4. Mermaid 流程图与时序图安全 SVG 模型解析（含单行链式语法）
  const flow = parseMermaidDiagram('flowchart LR\nA[Read] --> B[Analyze] -->|ok| C(Done)')
  assert.ok(flow && flow.kind === 'flowchart')
  assert.equal(flow.nodes.length, 3)
  assert.deepEqual(flow.nodes.map(n => n.label), ['Read', 'Analyze', 'Done'])
  assert.equal(flow.edges.length, 2)
  assert.equal(flow.edges[1].label, 'ok')

  const seq = parseMermaidDiagram('sequenceDiagram\nClient->>Server: prompt')
  assert.ok(seq && seq.kind === 'sequence')
  assert.equal(seq.lifelines?.length, 2)
  assert.equal(seq.messages?.[0].label, 'prompt')

  assert.equal(parseMermaidDiagram('pie title Pets\n"Dogs": 30'), null)
})

test('按 Agent 保存模型与思考强度偏好并支持新对话自动延续及重置', () => {
  const mem = new Map()
  const storage = {
    getItem: k => mem.get(k) ?? null,
    setItem: (k, v) => { mem.set(k, v) },
  }

  assert.equal(resolveSavedModelPref('node-1', 'opencode', storage), null)

  saveAgentModelPref(
    { nodeId: 'node-1', provider: 'opencode', model: 'opencode-go/deepseek-v4.1-flash', effort: 'high', now: 1000 },
    storage,
  )
  assert.deepEqual(resolveSavedModelPref('node-1', 'opencode', storage), {
    model: 'opencode-go/deepseek-v4.1-flash',
    effort: 'high',
    updatedAt: 1000,
  })
  // 同 Agent 新节点（或新建其他对话）可按 provider 兜底复用上一次模型
  assert.equal(resolveSavedModelPref('node-2', 'opencode', storage)?.model, 'opencode-go/deepseek-v4.1-flash')
  // 不同 Agent 互不串台
  assert.equal(resolveSavedModelPref('node-1', 'codex', storage), null)

  // 选择不同节点上的同 Agent 新模型后，新节点优先采用精确节点偏好
  saveAgentModelPref(
    { nodeId: 'node-2', provider: 'opencode', model: 'opencode/gpt-5', now: 2000 },
    storage,
  )
  assert.equal(resolveSavedModelPref('node-1', 'opencode', storage)?.model, 'opencode-go/deepseek-v4.1-flash')
  assert.equal(resolveSavedModelPref('node-2', 'opencode', storage)?.model, 'opencode/gpt-5')

  // 切回“节点默认模型”（空字符串）应清除保存偏好
  saveAgentModelPref({ nodeId: 'node-2', provider: 'opencode', model: '' }, storage)
  assert.equal(resolveSavedModelPref('node-2', 'opencode', storage), null)
})

test('Split Diff 拆分对齐、工具局部 Diff 提取、自定义模板管理与 XSS 安全 HTML 导出', () => {
  // 1. Diff Hunk & Split 对齐
  const patch = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,3 +1,3 @@',
    ' const a = 1',
    '-const b = 2',
    '+const b = 3',
    ' export { a, b }',
  ].join('\n')
  const hunks = parseDiffHunks(patch)
  assert.equal(hunks.length, 1)
  const rows = toSplitDiffRows(hunks[0])
  assert.equal(rows[1].leftKind, 'del')
  assert.equal(rows[1].leftText, 'const b = 2')
  assert.equal(rows[1].rightKind, 'add')
  assert.equal(rows[1].rightText, 'const b = 3')

  // 2. 工具卡片局部 Diff 提取
  const mini = extractToolMiniDiff('edit', { filePath: 'src/a.ts', oldString: 'old()', newString: 'new()' })
  assert.ok(mini && mini.filePath === 'src/a.ts')
  assert.equal(mini.lines[0].kind, 'del')
  assert.equal(mini.lines[1].kind, 'add')

  // 3. 自定义斜杠模板 CRUD
  const mem = new Map()
  const storage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => { mem.set(k, v) } }
  const saved = saveCustomPrompt({ trigger: 'audit', title: '安全审计', template: '审计 {{file}}' }, storage)
  assert.equal(saved.length, 1)
  assert.equal(saved[0].trigger, '/audit')
  assert.equal(loadCustomPrompts(storage).length, 1)
  assert.equal(deleteCustomPrompt(saved[0].id, storage).length, 0)

  // 4. HTML 报告导出严格转义恶意脚本
  const html = buildSessionHtmlReport(
    { sessionId: 's1', nodeId: 'n1', provider: 'mock', title: '<script>alert(1)</script>', cwd: '/repo' },
    [{ id: 'm1', role: 'assistant', nodeId: 'n1', provider: 'mock', text: '<img src=x onerror=alert(1)>', createdAt: 1 }],
    'Mac-Mini',
  )
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
  assert.equal(html.includes('<img src=x onerror='), false)

  // 5. 路径语言徽章拆分与 Hunk 上下文间隙计算
  const meta = splitDiffPath('agent-node/agent_node/daemon.py')
  assert.equal(meta.fileName, 'daemon.py')
  assert.equal(meta.dirName, 'agent-node/agent_node')
  assert.equal(meta.badge, 'PY')

  const multiPatch = [
    '@@ -18,4 +18,5 @@',
    ' from a import b',
    '+from c import d',
    ' e()',
    '@@ -28,3 +29,4 @@',
    ' f()',
    '+g()',
    ' h()',
  ].join('\n')
  const mh = parseDiffHunks(multiPatch)
  const gaps = computeHunkGaps(mh, 40)
  assert.equal(gaps.beforeFirst?.startNewLine, 1)
  assert.equal(gaps.beforeFirst?.endNewLine, 17)
  assert.equal(gaps.between[0]?.startNewLine, 23)
  assert.equal(gaps.between[0]?.endNewLine, 28)
  assert.equal(gaps.between[0]?.oldDelta, -1)
  assert.equal(gaps.afterLast?.startNewLine, 33)
  assert.equal(gaps.afterLast?.endNewLine, 40)
})

test('Work Run 连续工具聚合、真分叉上下文种子、批量 Diff 批注打包与大段粘贴收纳', () => {
  // 1. 连续多步工具调用自动聚合成 tool-group，单步保持 tool
  const grouped = groupMessageParts({
    text: '修改完成',
    toolCalls: [
      { id: 'c1', callId: 'c1', name: 'read_file', status: 'completed', durationMs: 120 },
      { id: 'c2', callId: 'c2', name: 'grep_search', status: 'completed', durationMs: 80 },
      { id: 'c3', callId: 'c3', name: 'edit_file', status: 'completed', durationMs: 200 },
      { id: 'c4', callId: 'c4', name: 'run_bash', status: 'completed', durationMs: 500 },
    ],
    parts: [
      { type: 'thought', text: '先查代码' },
      { type: 'tool', callId: 'c1' },
      { type: 'tool', callId: 'c2' },
      { type: 'tool', callId: 'c3' },
      { type: 'text', text: '准备验证' },
      { type: 'tool', callId: 'c4' },
      { type: 'text', text: '修改完成' },
    ],
  })
  assert.equal(grouped[0].type, 'thought')
  assert.equal(grouped[1].type, 'tool-group')
  if (grouped[1].type === 'tool-group') {
    assert.equal(grouped[1].tools.length, 3)
    assert.equal(grouped[1].totalDurationMs, 400)
    assert.ok(grouped[1].summaryLabel.includes('读取 1'))
    assert.ok(grouped[1].summaryLabel.includes('检索 1'))
    assert.ok(grouped[1].summaryLabel.includes('修改 1'))
  }
  assert.equal(grouped[2].type, 'text')
  assert.equal(grouped[3].type, 'tool')
  assert.equal(grouped[4].type, 'text')

  // 2. 真分叉上下文种子保留结构化问答与工具摘要
  const seed = buildForkContextSeed(
    [
      { id: 'u1', role: 'user', nodeId: 'n1', provider: 'codex', text: '帮我重构登录流程', createdAt: 1 },
      {
        id: 'a1',
        role: 'assistant',
        nodeId: 'n1',
        provider: 'codex',
        text: '已拆分 authService 并补充测试',
        toolCalls: [{ id: 't1', name: 'edit_file', status: 'completed' }],
        createdAt: 2,
      },
    ],
    '登录重构',
  )
  assert.ok(seed.includes('继承自「登录重构」'))
  assert.ok(seed.includes('帮我重构登录流程'))
  assert.ok(seed.includes('edit_file'))

  // 3. Diff 批量行内批注仅打包未解决项并按文件与行号排序
  const batchPrompt = buildDiffAnnotationsPrompt([
    { id: '1', filePath: 'src/b.ts', lineNo: 20, codeSnippet: 'return x', comment: '需要判空', resolved: false, createdAt: 1 },
    { id: '2', filePath: 'src/a.ts', lineNo: 12, codeSnippet: 'foo()', comment: '已修复', resolved: true, createdAt: 2 },
    { id: '3', filePath: 'src/b.ts', lineNo: 5, codeSnippet: 'let x', comment: '改成 const', resolved: false, createdAt: 3 },
  ])
  assert.ok(batchPrompt.includes('2 条代码评审批注'))
  assert.ok(batchPrompt.includes('### @src/b.ts'))
  assert.equal(batchPrompt.includes('src/a.ts'), false)
  assert.ok(batchPrompt.indexOf('L5') < batchPrompt.indexOf('L20'))

  // 4. 大段粘贴文本判断与芯片摘要
  assert.equal(shouldConvertToPastedBlock('短文本'), false)
  const bigLines = Array.from({ length: 35 }, (_, i) => `log line ${i + 1}`).join('\n')
  assert.equal(shouldConvertToPastedBlock(bigLines), true)
  const block = createPastedTextBlock(bigLines, 'p1')
  assert.equal(block.lineCount, 35)
  assert.equal(block.title, 'log line 1')
})

test('模糊文件匹配、配额异常识别、代码块路径解析、Commit 建议与乐观会话命名', () => {
  // 1. 子序列模糊匹配打分（越小越靠前，未命中返回 null；文件名驼峰命中优于跨目录散落命中）
  const sExact = fuzzyMatchFileScore('act', 'src/components/chat/AgentChatThread.vue')
  const sOther = fuzzyMatchFileScore('act', 'src/alpha/core/target.ts')
  assert.ok(sExact !== null && sOther !== null)
  assert.ok(sExact < sOther)
  assert.equal(fuzzyMatchFileScore('xyz', 'src/main.ts'), null)

  // 2. 配额/模型错误启发式识别
  assert.equal(isQuotaOrModelError('429 Too Many Requests: quota exceeded'), true)
  assert.equal(isQuotaOrModelError('Model not found: claude-opus-9'), true)
  assert.equal(isQuotaOrModelError('TypeError: cannot read properties of undefined'), false)

  // 3. 代码围栏 lang:path 解析
  assert.deepEqual(parseCodeBlockLang('ts:src/stores/fleet.ts'), { lang: 'ts', filePath: 'src/stores/fleet.ts' })
  assert.deepEqual(parseCodeBlockLang('python'), { lang: 'python' })
  assert.deepEqual(parseCodeBlockLang('ts:https://example.com/a.ts'), { lang: 'ts:https://example.com/a.ts' })

  // 4. Conventional Commit 启发式建议
  assert.equal(suggestCommitMessageFromDiff([{ path: 'tests/fleet.test.mjs', status: 'modified', additions: 10, deletions: 2 }]), 'test: 更新 fleet.test.mjs')
  assert.equal(
    suggestCommitMessageFromDiff([
      { path: 'src/pages/ChatPage.vue', status: 'modified', additions: 5, deletions: 1 },
      { path: 'src/stores/fleet.ts', status: 'modified', additions: 8, deletions: 2 },
    ]),
    'feat: 更新 ChatPage.vue、fleet.ts 等 2 个文件',
  )

  // 5. 乐观会话命名与默认占位标题识别
  assert.equal(isGenericSessionTitle('新会话'), true)
  assert.equal(isGenericSessionTitle('New session'), true)
  assert.equal(isGenericSessionTitle('opencode · ses_1234'), true)
  assert.equal(isGenericSessionTitle('修复 Diff 抽屉快捷键'), false)
  assert.equal(deriveOptimisticSessionTitle('[Plan Mode]\n修复滚动抖动问题'), '修复滚动抖动问题')
  assert.equal(deriveOptimisticSessionTitle('这是一个超过二十二个字符长度限制用于验证自动截断省略号效果的测试问题').endsWith('…'), true)
})

test('工作记录折叠思考与连续工具，保留旧历史与穿插正文的顺序', () => {
  const read = { id: 'read', name: 'read_file', status: 'completed' }
  const search = { id: 'search', name: 'search_files', status: 'running' }
  const run = { id: 'run', name: 'shell', status: 'error', output: 'assertion failed' }
  const items = buildThreadRenderItems({
    id: 'm-work', role: 'assistant', text: '正在排查。请看结果。', toolCalls: [read, search, run],
    parts: [
      { type: 'thought', text: '先查文件' }, { type: 'tool', callId: 'read' }, { type: 'tool', callId: 'search' },
      { type: 'text', text: '正在排查。' }, { type: 'tool', callId: 'run' }, { type: 'text', text: '请看结果。' },
    ],
  })
  assert.deepEqual(items.map(item => item.type), ['work-log', 'text', 'work-log', 'text'])
  assert.deepEqual(items[0].steps.map(step => step.type === 'tool' ? step.tool.status : step.text), ['先查文件', 'completed', 'running'])
  assert.equal(items[2].steps[0].tool.output, 'assertion failed')

  const old = buildThreadRenderItems({ id: 'old', role: 'assistant', text: '', thought: '旧思考', toolCalls: [run] })
  assert.deepEqual(old.map(item => item.type), ['work-log'])
  assert.equal(old[0].isLast, true)
  assert.deepEqual(old[0].steps.map(step => step.type), ['thought', 'tool'])
})

test('leaves literal media labels in prose while extracting later attachments once', () => {
  const intro = 'Use MEDIA: as a label'
  const middle = 'Second @image: example'
  const reply = `${intro}\nMEDIA:/tmp/chart.png\n${middle}\n@file:/tmp/report.pdf`

  assert.deepEqual(extractHostMediaDirectives(reply), [
    { match: 'MEDIA:/tmp/chart.png', path: '/tmp/chart.png', offset: intro.length },
    { match: '@file:/tmp/report.pdf', path: '/tmp/report.pdf', offset: `${intro}\n\n${middle}`.length },
  ])
  assert.deepEqual(splitTextByInlineMedia(reply, []).segments.map(segment =>
    segment.type === 'text' ? segment.text : segment.attachment.fileName,
  ), [intro, 'chart.png', middle, 'report.pdf'])
})

test('hermes-mobile 风格正文内联媒体分段：MEDIA 指令、路径引用穿插与代码围栏闭合保护', () => {
  // 1. MEDIA:<path> 指令提取与剥离
  const rawWithDirective = '第一段说明文字\nMEDIA:/tmp/chart.png\n第二段结论分析'
  const directives = extractHostMediaDirectives(rawWithDirective)
  assert.equal(directives.length, 1)
  assert.equal(directives[0].path, '/tmp/chart.png')
  const stripped = stripHostMediaDirectives(rawWithDirective)
  assert.equal(stripped.includes('MEDIA:'), false)

  // 2. snapToBlockEnd 遇到未闭合 ``` 代码围栏时自动延后到闭合围栏之后
  const fenced = '前文\n```ts\nconst p = "/tmp/a.png"\nconst x = 1\n```\n后文段落'
  const insideIdx = fenced.indexOf('/tmp/a.png')
  const snapped = snapToBlockEnd(fenced, insideIdx)
  const closingFenceEnd = fenced.indexOf('```\n后文') + 3
  assert.equal(snapped, closingFenceEnd)

  // 3. 正文中段提及本地文件路径时，图片直接穿插在提及段落之后、后续段落之前
  const article = [
    '图已发出（见上）。',
    '',
    '**图片信息**',
    '- **主题**：海岸灯塔',
    '- **本地文件**：`C:\\Users\\yuans\\AppData\\Local\\Temp\\opencode\\web-photo.jpg`',
    '',
    '**过程说明**',
    '1. 先用 WebSearch 搜索图片源；',
    '2. 调用 Read 读取并展示。',
  ].join('\n')

  const items = buildTurnRenderItems({
    id: 'm-inline-1',
    role: 'assistant',
    text: article,
    toolCalls: [
      {
        id: 'tc-read',
        callId: 'tc-read',
        name: 'read',
        status: 'completed',
        input: { filePath: 'C:\\Users\\yuans\\AppData\\Local\\Temp\\opencode\\web-photo.jpg' },
      },
    ],
    media: [
      {
        id: 'med-1',
        url: 'data:image/jpeg;base64,/9j/4AAQ',
        fileName: 'Image 1 (JPEG, 40 KB)',
        mime: 'image/jpeg',
      },
    ],
  })

  // 渲染序列应当是：tool(read) -> text(上半篇，含本地文件行) -> media(web-photo.jpg) -> text(下半篇，过程说明)
  const types = items.map(i => i.type)
  assert.deepEqual(types, ['tool', 'text', 'media', 'text'])
  assert.equal(items[1].type === 'text' && items[1].text.includes('**图片信息**'), true)
  assert.equal(items[2].type === 'media' && items[2].attachment.fileName, 'web-photo.jpg')
  assert.equal(items[3].type === 'text' && items[3].text.startsWith('**过程说明**'), true)

  // 4. splitTextByInlineMedia 对无偏移量附件保持末尾追加
  const { segments } = splitTextByInlineMedia(
    '普通正文段落',
    [{ id: 'att-tail', fileName: 'report.pdf', mime: 'application/pdf' }],
    { allowTrailingUnmatched: true },
  )
  assert.equal(segments.length, 2)
  assert.equal(segments[0].type, 'text')
  assert.equal(segments[1].type, 'media')
})

test('历史消息内容指纹匹配角色、正文与工具调用顺序', async t => {
  const toolCalls = [
    { id: 'local-read', callId: 'read', name: 'read_file' },
    { id: 'local-shell', callId: 'shell', name: 'shell' },
  ]
  const local = { role: 'assistant', text: '已完成', thought: '本地思考', toolCalls }
  const remote = {
    ...local,
    toolCalls: toolCalls.map(call => ({ ...call, id: call.callId })),
  }
  const cases = [
    ['角色、正文和工具调用顺序相同', local, remote, true],
    ['正文只差首尾空白', local, { ...remote, text: '  已完成\n' }, true],
    ['正文不同', local, { ...remote, text: '尚未完成' }, false],
    ['工具调用数量不同', local, { ...remote, toolCalls: remote.toolCalls.slice(0, 1) }, false],
    ['工具调用顺序不同', local, { ...remote, toolCalls: [...remote.toolCalls].reverse() }, false],
    ['角色不同', local, { ...remote, role: 'user' }, false],
    ['思考内容不同', local, { ...remote, thought: '回放思考' }, true],
    ['两边正文和工具调用均为空', { role: 'assistant', text: '' }, { role: 'assistant', text: '', toolCalls: [] }, true],
  ]
  for (const [name, left, right, expected] of cases) {
    await t.test(name, () => assert.equal(sameTurnContent(left, right), expected))
  }
})
