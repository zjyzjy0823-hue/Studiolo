import test from 'node:test'
import assert from 'node:assert/strict'
import { applySystemNotice, applySystemNotices, classifySystemNotice } from '../src/services/systemNotices.ts'
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
