import test from 'node:test'
import assert from 'node:assert/strict'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { createPinia, disposePinia } from 'pinia'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import {
  applySystemNotice,
  applySystemNotices,
  classifySystemNotice,
  summarizeSystemNotice,
} from '../src/services/systemNotices.ts'
import { mapEpochSnapshotMessage } from '../src/services/epochSnapshot.ts'

const PROCESS = '[IMPORTANT: Background process proc_c68e9eebbd91 completed normally (exit code 0).\nCommand: cd /Users/zjy/Projects/Nexa-LumaDock && export VITE_SYNC_MODE=epoch ...'
const BATCH = '[IMPORTANT: 2 background processes completed. Treat these results as one batch and give one consolidated response.]'
const DELEGATION = '[ASYNC DELEGATION BATCH COMPLETE — deleg_0327ec68]\nA background fan-out unit you dispatched earlier — 4 subagent(s) — has finished.'

test('classifySystemNotice 识别三类通知', () => {
  assert.equal(classifySystemNotice(PROCESS)?.kind, 'process')
  assert.equal(classifySystemNotice(BATCH)?.kind, 'batch')
  assert.match(classifySystemNotice(BATCH)?.title ?? '', /2 个后台任务已完成|个后台任务已完成/)
  assert.equal(classifySystemNotice(DELEGATION)?.kind, 'delegation')
  assert.equal(classifySystemNotice(DELEGATION)?.title, '子代理批次已完成')
})

test('classifySystemNotice 不误判正常消息', () => {
  for (const text of [
    '你好',
    '[IMPORTANT] 这个要看一下',
    '看看这条 [IMPORTANT: Background process proc_x completed]',
    '  [IMPORTANT: Background process proc_x completed]',
    '[ASYNC] 普通内容',
    '',
  ]) {
    assert.equal(classifySystemNotice(text), null, `误判: ${text}`)
  }
  assert.equal(classifySystemNotice(null), null)
  assert.equal(classifySystemNotice(undefined), null)
})

test('applySystemNotice 把 user 通知转成 system 且保留正文', () => {
  const out = applySystemNotice({ role: 'user', text: PROCESS })
  assert.equal(out.role, 'system')
  assert.equal(out.text, PROCESS)
})

test('applySystemNotice 不动其它角色与普通文本', () => {
  assert.equal(applySystemNotice({ role: 'assistant', text: PROCESS }).role, 'assistant')
  assert.equal(applySystemNotice({ role: 'system', text: PROCESS }).role, 'system')
  assert.equal(applySystemNotice({ role: 'user', text: '正常消息' }).role, 'user')
})

test('applySystemNotices 批量处理', () => {
  const rows = applySystemNotices([
    { role: 'user', text: BATCH },
    { role: 'user', text: '正常消息' },
    { role: 'assistant', text: DELEGATION },
  ])
  assert.deepEqual(rows.map(r => r.role), ['system', 'user', 'assistant'])
})

test('epoch 快照映射把通知渲染为 system', () => {
  const mapped = mapEpochSnapshotMessage(
    { id: 'm1', role: 'user', text: PROCESS, createdAt: 1 },
    { session: { nodeId: 'n1', provider: 'hermes' }, fallbackId: 'f1', fallbackCreatedAt: 1 },
  )
  assert.equal(mapped.role, 'system')
  assert.equal(mapped.text, PROCESS)

  const normal = mapEpochSnapshotMessage(
    { id: 'm2', role: 'user', text: '正常用户消息', createdAt: 2 },
    { session: { nodeId: 'n1', provider: 'hermes' }, fallbackId: 'f2', fallbackCreatedAt: 2 },
  )
  assert.equal(normal.role, 'user')
})

test('summarizeSystemNotice 提取 exit code 与失败状态', () => {
  const ok = summarizeSystemNotice(PROCESS)
  assert.ok(ok)
  assert.equal(ok.kind, 'process')
  assert.equal(ok.title, '后台任务已完成')
  assert.equal(ok.failed, false)
  assert.equal(ok.detail, 'exit 0 · proc_c68e9eebbd91')

  const failedExit = summarizeSystemNotice(
    '[IMPORTANT: Background process proc_bad999 exited abnormally (exit code 1).\nCommand: npm test]',
  )
  assert.ok(failedExit)
  assert.equal(failedExit.failed, true)
  assert.equal(failedExit.detail, 'exit 1 · proc_bad999')

  const noExitBatch = summarizeSystemNotice(BATCH)
  assert.ok(noExitBatch)
  assert.equal(noExitBatch.kind, 'batch')
  assert.equal(noExitBatch.failed, false)
  assert.equal(noExitBatch.detail, undefined)

  const noExitDeleg = summarizeSystemNotice(DELEGATION)
  assert.ok(noExitDeleg)
  assert.equal(noExitDeleg.kind, 'delegation')
  assert.equal(noExitDeleg.failed, false)
  assert.equal(noExitDeleg.detail, 'deleg_0327ec68')

  const failedHeaderNoExit = summarizeSystemNotice(
    '[IMPORTANT: Background process proc_err01 failed to start.]',
  )
  assert.ok(failedHeaderNoExit)
  assert.equal(failedHeaderNoExit.failed, true)
  assert.equal(failedHeaderNoExit.detail, 'proc_err01')
})

test('summarizeSystemNotice 截断命令到 60 字符并正确提取 proc_/deleg_', () => {
  const shortCmd = 'echo hello'
  const shortNotice = `[IMPORTANT: Background process proc_short1 completed normally (exit code 0).\nCommand: ${shortCmd}\nOutput: ignored]`
  const shortSummary = summarizeSystemNotice(shortNotice)
  assert.equal(shortSummary?.command, shortCmd)
  assert.equal(shortSummary?.detail, 'exit 0 · proc_short1')

  const exact60 = 'a'.repeat(60)
  const exactNotice = `[IMPORTANT: Background process proc_exact60 completed normally (exit code 0).\nCommand: ${exact60}\nSecond line]`
  assert.equal(summarizeSystemNotice(exactNotice)?.command, exact60)

  const longCmd = `${'x'.repeat(60)}TAIL_SHOULD_TRUNCATE`
  const longNotice = `[IMPORTANT: Background process proc_long99 completed normally (exit code 0).\nCommand: ${longCmd}\nSecond line]`
  const longSummary = summarizeSystemNotice(longNotice)
  assert.equal(longSummary?.command, `${'x'.repeat(60)}…`)

  const delegSummary = summarizeSystemNotice(DELEGATION)
  assert.equal(delegSummary?.detail, 'deleg_0327ec68')
  assert.equal(delegSummary?.command, undefined)
})

test('summarizeSystemNotice 非通知文本返回 null', () => {
  for (const text of [
    '普通消息',
    '[IMPORTANT] 不是后台通知',
    '看看这条 [IMPORTANT: Background process proc_x completed (exit code 1)]',
    '',
    null,
    undefined,
  ]) {
    assert.equal(summarizeSystemNotice(text), null)
  }
})

test('AgentChatThread SSR 渲染：系统通知默认折叠且原文不在 DOM，展开后出现，普通 system 不受影响', async t => {
  const server = await createServer({
    configFile: false,
    plugins: [vue()],
    server: { middlewareMode: true, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true },
  })
  t.after(() => server.close())

  const { useFleetStore, sessionKey } = await server.ssrLoadModule('/src/stores/fleet.ts')
  const { default: AgentChatThread } = await server.ssrLoadModule('/src/components/chat/AgentChatThread.vue')

  const storeMap = new Map()
  const storage = {
    getItem: k => (storeMap.has(k) ? storeMap.get(k) : null),
    setItem: (k, v) => { storeMap.set(k, String(v)) },
    removeItem: k => { storeMap.delete(k) },
    clear: () => { storeMap.clear() },
  }
  const prevStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
  t.after(() => {
    if (prevStorage) Object.defineProperty(globalThis, 'localStorage', prevStorage)
    else delete globalThis.localStorage
  })

  const pinia = createPinia()
  const fleet = useFleetStore(pinia)
  t.after(() => disposePinia(pinia))

  const session = { nodeId: 'node1', provider: 'hermes', sessionId: 'sess-notices', title: '通知测试', cwd: '' }
  const key = sessionKey(session.nodeId, session.provider, session.sessionId)
  const procRaw = '[IMPORTANT: Background process proc_c68e9eebbd91 completed normally (exit code 0).\nCommand: cd /Users/zjy/Projects/Nexa-LumaDock && export VITE_SYNC_MODE=epoch && npm run build\nOutput: PROC_RAW_TAIL_MARKER_ONLY_WHEN_EXPANDED]'
  const failedRaw = '[IMPORTANT: Background process proc_fail42 exited abnormally (exit code 1).\nCommand: npm test\nError: FAIL_RAW_TAIL_MARKER]'
  const delegRaw = '[ASYNC DELEGATION BATCH COMPLETE — deleg_0327ec68]\nA background fan-out unit you dispatched earlier — 4 subagent(s) — has finished. DELEG_RAW_MARKER'
  const plainSystemText = '普通系统提示：会话已重新连接'

  fleet.sessionsByKey = { [key]: session }
  fleet.messagesBySession = {
    [key]: [
      { id: 'm-proc', role: 'system', nodeId: 'node1', provider: 'hermes', text: procRaw, createdAt: 1 },
      { id: 'm-fail', role: 'system', nodeId: 'node1', provider: 'hermes', text: failedRaw, createdAt: 2 },
      { id: 'm-deleg', role: 'system', nodeId: 'node1', provider: 'hermes', text: delegRaw, createdAt: 3 },
      { id: 'm-plain', role: 'system', nodeId: 'node1', provider: 'hermes', text: plainSystemText, createdAt: 4 },
    ],
  }

  const collapsedHtml = await renderToString(
    createSSRApp(AgentChatThread, { mobile: true, sessionKey: key }).use(pinia),
  )

  // 折叠行默认存在
  assert.match(collapsedHtml, /class="sys-notice-collapsible"/)
  assert.match(collapsedHtml, /🔧/)
  assert.match(collapsedHtml, /🤖/)
  assert.match(collapsedHtml, /后台任务已完成/)
  assert.match(collapsedHtml, /exit 0 · proc_c68e9eebbd91/)
  // class 顺序不构成契约：只要同时含两者即可
    assert.match(collapsedHtml, /class="[^"]*\bsys-notice-collapsible\b[^"]*"/)
    assert.match(collapsedHtml, /class="[^"]*\bis-failed\b[^"]*"/)
  assert.match(collapsedHtml, /class="sys-notice-fail-badge"[^>]*>失败</)
  assert.match(collapsedHtml, /exit 1 · proc_fail42/)
  assert.match(collapsedHtml, /子代理批次已完成/)
  assert.match(collapsedHtml, /deleg_0327ec68/)

  // 完整原文默认不在 DOM 里
  assert.doesNotMatch(collapsedHtml, /sys-notice-raw/)
  assert.doesNotMatch(collapsedHtml, /PROC_RAW_TAIL_MARKER_ONLY_WHEN_EXPANDED/)
  assert.doesNotMatch(collapsedHtml, /FAIL_RAW_TAIL_MARKER/)
  assert.doesNotMatch(collapsedHtml, /DELEG_RAW_MARKER/)

  // 普通 system 消息保持原样（使用 .sys-notice，而非折叠行）
  assert.match(collapsedHtml, /data-msg-id="m-plain"[^>]*class="sys-notice"/)
  assert.match(collapsedHtml, /普通系统提示：会话已重新连接/)

  // 展开 m-proc 后，其完整原文出现在 DOM 里，其它未展开条目仍保持收起
  let toggled = false
  const expandedApp = createSSRApp(AgentChatThread, { mobile: true, sessionKey: key }).use(pinia)
  expandedApp.mixin({
    created() {
      const toggle = this.$?.exposed?.toggleSystemNotice
      if (typeof toggle === 'function') {
        toggle('m-proc')
        toggled = true
      }
    },
  })
  const expandedHtml = await renderToString(expandedApp)
  assert.equal(toggled, true)
  // class 顺序不构成契约：只要同时含两者即可
    assert.match(expandedHtml, /class="[^"]*\bsys-notice-collapsible\b[^"]*"/)
    assert.match(expandedHtml, /class="[^"]*\bis-expanded\b[^"]*"/)
  assert.match(expandedHtml, /aria-expanded="true"/)
  assert.match(expandedHtml, /<pre class="sys-notice-raw"[^>]*>[\s\S]*PROC_RAW_TAIL_MARKER_ONLY_WHEN_EXPANDED/)
  assert.doesNotMatch(expandedHtml, /FAIL_RAW_TAIL_MARKER/)
  assert.doesNotMatch(expandedHtml, /DELEG_RAW_MARKER/)
})
