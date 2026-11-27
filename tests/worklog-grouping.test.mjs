import test from 'node:test'
import assert from 'node:assert/strict'
import { groupThreadTurns } from '../src/services/messageSegments.ts'

test('1. 相邻 3 条 tool-only assistant → 1 个 ThreadRow，parts 合并，stepCount === 3，sourceIndex 指向第一条', () => {
  const messages = [
    {
      id: 'a1',
      role: 'assistant',
      nodeId: 'n1',
      provider: 'hermes',
      createdAt: 1000,
      text: '',
      parts: [{ type: 'tool', callId: 'c1' }],
      toolCalls: [{ callId: 'c1', name: 'read_file', status: 'completed' }],
    },
    {
      id: 'a2',
      role: 'assistant',
      nodeId: 'n1',
      provider: 'hermes',
      createdAt: 1010,
      text: '',
      parts: [{ type: 'tool', callId: 'c2' }],
      toolCalls: [{ callId: 'c2', name: 'write_file', status: 'completed' }],
    },
    {
      id: 'a3',
      role: 'assistant',
      nodeId: 'n1',
      provider: 'hermes',
      createdAt: 1020,
      text: '',
      parts: [{ type: 'tool', callId: 'c3' }],
      toolCalls: [{ callId: 'c3', name: 'run_command', status: 'completed' }],
    },
  ]
  const rows = groupThreadTurns(messages)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].sourceIndex, 0)
  assert.deepEqual(rows[0].memberIds, ['a1', 'a2', 'a3'])
  assert.equal(rows[0].stepCount, 3)
  assert.equal(rows[0].msg.parts.length, 3)
  assert.deepEqual(rows[0].msg.parts.map(p => p.callId), ['c1', 'c2', 'c3'])
  assert.equal(rows[0].msg.id, 'a1')
})

test('2. 中间夹 user → 2 个 row', () => {
  const messages = [
    {
      id: 'a1',
      role: 'assistant',
      nodeId: 'n1',
      provider: 'hermes',
      createdAt: 1000,
      text: '',
      parts: [{ type: 'tool', callId: 'c1' }],
    },
    {
      id: 'u1',
      role: 'user',
      nodeId: 'n1',
      provider: 'hermes',
      createdAt: 1010,
      text: 'continue',
    },
    {
      id: 'a2',
      role: 'assistant',
      nodeId: 'n1',
      provider: 'hermes',
      createdAt: 1020,
      text: '',
      parts: [{ type: 'tool', callId: 'c2' }],
    },
  ]
  const rows = groupThreadTurns(messages)
  assert.equal(rows.length, 3)
  assert.equal(rows[0].msg.id, 'a1')
  assert.equal(rows[0].sourceIndex, 0)
  assert.equal(rows[1].msg.id, 'u1')
  assert.equal(rows[1].sourceIndex, 1)
  assert.equal(rows[2].msg.id, 'a2')
  assert.equal(rows[2].sourceIndex, 2)
  const assistantRows = rows.filter(r => r.msg.role === 'assistant')
  assert.equal(assistantRows.length, 2, 'user 消息将 assistant 截断为两个独立 row')
})

test('3. 中间某条有 text → 断开，text 单独成行', () => {
  const messages = [
    {
      id: 'a1',
      role: 'assistant',
      nodeId: 'n1',
      provider: 'hermes',
      createdAt: 1000,
      text: '',
      parts: [{ type: 'tool', callId: 'c1' }],
    },
    {
      id: 'a2',
      role: 'assistant',
      nodeId: 'n1',
      provider: 'hermes',
      createdAt: 1010,
      text: '我查一下',
    },
    {
      id: 'a3',
      role: 'assistant',
      nodeId: 'n1',
      provider: 'hermes',
      createdAt: 1020,
      text: '',
      parts: [{ type: 'tool', callId: 'c2' }],
    },
  ]
  const rows = groupThreadTurns(messages)
  assert.equal(rows.length, 3)
  assert.equal(rows[0].sourceIndex, 0)
  assert.deepEqual(rows[0].memberIds, ['a1'])
  assert.equal(rows[1].sourceIndex, 1)
  assert.equal(rows[1].msg.text, '我查一下')
  assert.deepEqual(rows[1].memberIds, ['a2'])
  assert.equal(rows[2].sourceIndex, 2)
  assert.deepEqual(rows[2].memberIds, ['a3'])
})

test('4. 有 error / interrupted / 未决 approvals → 断开', () => {
  // 1) 有 error 消息必须断开
  const withError = [
    { id: 'a1', role: 'assistant', nodeId: 'n1', provider: 'hermes', createdAt: 1000, text: '', parts: [{ type: 'tool', callId: 'c1' }] },
    { id: 'a2', role: 'assistant', nodeId: 'n1', provider: 'hermes', createdAt: 1010, text: '', error: 'Command failed', parts: [{ type: 'tool', callId: 'c2' }] },
  ]
  const rowsError = groupThreadTurns(withError)
  assert.equal(rowsError.length, 2, '有 error 应断开')
  assert.equal(rowsError[0].sourceIndex, 0)
  assert.equal(rowsError[1].sourceIndex, 1)

  // 2) 有 interrupted 消息必须断开
  const withInterrupted = [
    { id: 'a1', role: 'assistant', nodeId: 'n1', provider: 'hermes', createdAt: 1000, text: '', parts: [{ type: 'tool', callId: 'c1' }] },
    { id: 'a2', role: 'assistant', nodeId: 'n1', provider: 'hermes', createdAt: 1010, text: '', interrupted: true, parts: [{ type: 'tool', callId: 'c2' }] },
  ]
  const rowsInterrupted = groupThreadTurns(withInterrupted)
  assert.equal(rowsInterrupted.length, 2, '有 interrupted 应断开')
  assert.equal(rowsInterrupted[0].sourceIndex, 0)
  assert.equal(rowsInterrupted[1].sourceIndex, 1)

  // 3) 有未决 approvals 消息必须断开
  const withApprovals = [
    { id: 'a1', role: 'assistant', nodeId: 'n1', provider: 'hermes', createdAt: 1000, text: '', parts: [{ type: 'tool', callId: 'c1' }] },
    { id: 'a2', role: 'assistant', nodeId: 'n1', provider: 'hermes', createdAt: 1010, text: '', approvals: [{ callId: 'c2', decision: 'pending' }], parts: [{ type: 'tool', callId: 'c2' }] },
  ]
  const rowsApprovals = groupThreadTurns(withApprovals)
  assert.equal(rowsApprovals.length, 2, '有未决 approvals 应断开')
  assert.equal(rowsApprovals[0].sourceIndex, 0)
  assert.equal(rowsApprovals[1].sourceIndex, 1)
})

test('5. 相邻无正文的助手消息即使 runId 不同也合并（legacy 会话 runId 是消息粒度的）', () => {
  const messages = [
    { id: 'a1', role: 'assistant', nodeId: 'n1', provider: 'hermes', createdAt: 1000, text: '', runId: 'run-alpha', parts: [{ type: 'tool', callId: 'c1' }] },
    { id: 'a2', role: 'assistant', nodeId: 'n1', provider: 'hermes', createdAt: 1010, text: '', runId: 'run-beta', parts: [{ type: 'tool', callId: 'c2' }] },
  ]
  const rows = groupThreadTurns(messages)
  assert.equal(rows.length, 1, '中间没有正文就不该拆卡')
  assert.equal(rows[0].sourceIndex, 0)
  assert.deepEqual(rows[0].memberIds, ['a1', 'a2'])
  assert.equal(rows[0].stepCount, 2)

  // 有正文的那条仍然必须断开
  const withText = [
    { id: 'b1', role: 'assistant', nodeId: 'n1', provider: 'hermes', createdAt: 1000, text: '', runId: 'r1', parts: [{ type: 'tool', callId: 'c1' }] },
    { id: 'b2', role: 'assistant', nodeId: 'n1', provider: 'hermes', createdAt: 1010, text: '中间有句话', runId: 'r2', parts: [{ type: 'tool', callId: 'c2' }] },
  ]
  const rowsText = groupThreadTurns(withText)
  assert.equal(rowsText.length, 2)
  assert.equal(rowsText[0].sourceIndex, 0)
  assert.equal(rowsText[1].sourceIndex, 1)
})

test('6. streaming 的最后一条 → 合并且 msg.streaming === true', () => {
  const messages = [
    { id: 'a1', role: 'assistant', nodeId: 'n1', provider: 'hermes', createdAt: 1000, text: '', streaming: false, parts: [{ type: 'tool', callId: 'c1' }] },
    { id: 'a2', role: 'assistant', nodeId: 'n1', provider: 'hermes', createdAt: 1010, text: '', streaming: true, parts: [{ type: 'tool', callId: 'c2' }] },
  ]
  const rows = groupThreadTurns(messages)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].sourceIndex, 0)
  assert.deepEqual(rows[0].memberIds, ['a1', 'a2'])
  assert.strictEqual(rows[0].msg.streaming, true)
})

test('7. durationMs 求和正确；单条时 stepCount 等于其工具数', () => {
  // 合并组：durationMs 求和（忽略 NaN/非有限值）
  const merged = [
    { id: 'a1', role: 'assistant', nodeId: 'n1', provider: 'hermes', createdAt: 1000, text: '', durationMs: 120, parts: [{ type: 'tool', callId: 'c1' }] },
    { id: 'a2', role: 'assistant', nodeId: 'n1', provider: 'hermes', createdAt: 1010, text: '', durationMs: 380, parts: [{ type: 'tool', callId: 'c2' }] },
    { id: 'a3', role: 'assistant', nodeId: 'n1', provider: 'hermes', createdAt: 1020, text: '', durationMs: NaN, parts: [{ type: 'tool', callId: 'c3' }] },
  ]
  const mergedRows = groupThreadTurns(merged)
  assert.equal(mergedRows.length, 1)
  assert.equal(mergedRows[0].msg.durationMs, 500)
  assert.equal(mergedRows[0].stepCount, 3)

  // 单条消息：stepCount 等于其工具数
  const single = [
    {
      id: 's1',
      role: 'assistant',
      nodeId: 'n1',
      provider: 'hermes',
      createdAt: 1000,
      text: '',
      durationMs: 250,
      toolCalls: [
        { callId: 'c1', name: 'read_file', status: 'completed' },
        { callId: 'c2', name: 'write_file', status: 'completed' },
      ],
    },
  ]
  const singleRows = groupThreadTurns(single)
  assert.equal(singleRows.length, 1)
  assert.equal(singleRows[0].msg.durationMs, 250)
  assert.equal(singleRows[0].stepCount, 2)
  assert.deepEqual(singleRows[0].memberIds, ['s1'])
})

test('8. sourceIndex 在合并后仍指向 effectiveMessages 的正确下标（用 5 条消息造数据断言）', () => {
  const messages = [
    { id: 'm0', role: 'user', nodeId: 'n1', provider: 'hermes', createdAt: 1000, text: '帮我修复 bug' },
    { id: 'm1', role: 'assistant', nodeId: 'n1', provider: 'hermes', createdAt: 1010, text: '', parts: [{ type: 'tool', callId: 'c1' }] },
    { id: 'm2', role: 'assistant', nodeId: 'n1', provider: 'hermes', createdAt: 1020, text: '', parts: [{ type: 'tool', callId: 'c2' }] },
    { id: 'm3', role: 'assistant', nodeId: 'n1', provider: 'hermes', createdAt: 1030, text: '', parts: [{ type: 'tool', callId: 'c3' }] },
    { id: 'm4', role: 'assistant', nodeId: 'n1', provider: 'hermes', createdAt: 1040, text: '修复完成，请检查。' },
  ]
  const rows = groupThreadTurns(messages)
  assert.equal(rows.length, 3, '5 条消息合并后应产生 3 个 row')

  // Row 0: user 消息
  assert.equal(rows[0].sourceIndex, 0)
  assert.equal(rows[0].msg.id, 'm0')
  assert.deepEqual(rows[0].memberIds, ['m0'])

  // Row 1: 合并的 assistant 工具步（m1, m2, m3）
  assert.equal(rows[1].sourceIndex, 1, '合并组的 sourceIndex 必须指向 anchor (m1)')
  assert.equal(rows[1].msg.id, 'm1')
  assert.deepEqual(rows[1].memberIds, ['m1', 'm2', 'm3'])
  assert.equal(rows[1].stepCount, 3)

  // Row 2: assistant 最终正文回复
  assert.equal(rows[2].sourceIndex, 4, '后续普通消息的 sourceIndex 必须指向其在 effectiveMessages 中的原始下标 4')
  assert.equal(rows[2].msg.id, 'm4')
  assert.deepEqual(rows[2].memberIds, ['m4'])
})
