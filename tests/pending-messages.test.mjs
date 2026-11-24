import test from 'node:test'
import assert from 'node:assert/strict'
import { preservePendingMessages } from '../src/services/chatHelpers.ts'

const row = (over) => ({ id: 'x', role: 'user', text: 'hi', createdAt: 1, ...over })

test('刷新时保留仍在发送中的本地消息', () => {
  const pending = row({ id: 'user-req1', requestId: 'req1', text: '刚发的', delivery: 'sending', createdAt: 10 })
  const server = [row({ id: 's1', text: '旧消息', createdAt: 1 })]
  const out = preservePendingMessages([...server, pending], server)
  assert.equal(out.length, 2)
  assert.equal(out.at(-1)?.id, 'user-req1')
  assert.equal(out.at(-1)?.delivery, 'sending')
})

test('服务端已回显时不重复', () => {
  const pending = row({ id: 'user-req1', requestId: 'req1', text: '刚发的', delivery: 'sending', createdAt: 10 })
  const echoed = row({ id: 'srv-9', requestId: 'req1', text: '刚发的', createdAt: 10 })
  const out = preservePendingMessages([pending], [echoed])
  assert.equal(out.length, 1)
  assert.equal(out[0]?.id, 'srv-9')
})

test('没有 requestId 时按内容指纹去重', () => {
  const pending = row({ id: 'user-req2', text: '同一条内容', delivery: 'sending', createdAt: 10 })
  const echoed = row({ id: 'srv-10', text: '同一条内容', createdAt: 11 })
  const out = preservePendingMessages([pending], [echoed])
  assert.equal(out.length, 1)
})

test('发送失败的消息也要保留', () => {
  const failed = row({ id: 'user-req3', requestId: 'req3', text: '失败的', delivery: 'failed', createdAt: 12 })
  const out = preservePendingMessages([failed], [])
  assert.equal(out.length, 1)
  assert.equal(out[0]?.delivery, 'failed')
})

test('已发送的本地消息不参与保留', () => {
  const sent = row({ id: 'user-req4', requestId: 'req4', text: '已发送', delivery: 'sent', createdAt: 13 })
  const out = preservePendingMessages([sent], [])
  assert.equal(out.length, 0)
})

test('没有待发消息时原样返回', () => {
  const server = [row({ id: 's1', text: 'a', createdAt: 1 })]
  assert.equal(preservePendingMessages(server, server), server)
})
