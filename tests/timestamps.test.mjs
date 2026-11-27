import test from 'node:test'
import assert from 'node:assert/strict'
import { formatClockTime, mergeToolCallUpdate } from '../src/services/chatHelpers.ts'

test('1. 传入毫秒时间戳 → 命中 ^\\d{2}:\\d{2}:\\d{2}$ 且小时数正确', () => {
  const ts = new Date(2026, 10, 27, 9, 41, 3).getTime()
  const result = formatClockTime(ts)
  assert.match(result, /^\d{2}:\d{2}:\d{2}$/)
  assert.equal(result.startsWith('09:'), true)
  assert.equal(result, '09:41:03')
})

test('2. seconds: false → ^\\d{2}:\\d{2}$', () => {
  const ts = new Date(2026, 10, 27, 9, 41, 3).getTime()
  const result = formatClockTime(ts, { seconds: false })
  assert.match(result, /^\d{2}:\d{2}$/)
  assert.equal(result, '09:41')
})

test('3. 传入 undefined / 0 → 返回 \'\'', () => {
  assert.equal(formatClockTime(undefined), '')
  assert.equal(formatClockTime(0), '')
})

test('4. 不抛异常（负数时间戳、null）', () => {
  assert.doesNotThrow(() => formatClockTime(-1000))
  assert.doesNotThrow(() => formatClockTime(null))
  assert.equal(formatClockTime(null), '')
})

test('5. mergeToolCallUpdate: 新建补全 startedAt，更新保留原有 startedAt', () => {
  const t0 = 1700000000000
  // 新建工具调用，带 startedAt
  const tools1 = mergeToolCallUpdate([], { callId: 'c1', name: 'read_file', startedAt: t0 })
  assert.equal(tools1[0].startedAt, t0)

  // 更新 ToolCallUpdate 保留原有 startedAt
  const tools2 = mergeToolCallUpdate(tools1, { callId: 'c1', name: 'read_file', status: 'completed' })
  assert.equal(tools2[0].startedAt, t0)

  // 新建工具调用，不带 startedAt 则使用当前时间
  const before = Date.now()
  const tools3 = mergeToolCallUpdate([], { callId: 'c2', name: 'write_file' })
  const after = Date.now()
  assert.ok(typeof tools3[0].startedAt === 'number')
  assert.ok(tools3[0].startedAt >= before && tools3[0].startedAt <= after)
})
