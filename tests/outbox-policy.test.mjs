import test from 'node:test'
import assert from 'node:assert/strict'
import {
  decideOutboxAction,
  planSteerOutcome,
  deliveryTimedOut,
  SEND_ACK_TIMEOUT_MS,
  STEER_ACK_TIMEOUT_MS,
} from '../src/services/outboxPolicy.ts'

test('decideOutboxAction: 11 条判定顺序逐条覆盖与优先级断言', async t => {
  const baseInput = {
    online: true,
    routeReady: true,
    nodeOnline: true,
    sessionRunning: true,
    provider: 'hermes',
    hasAttachments: false,
    steerPending: false,
    steerBlocked: false,
    busySendMode: 'auto',
    interruptPending: false,
  }

  // 1. !online -> wait('offline')
  await t.test('1. !online -> wait offline，且优先级高于 !sessionRunning (空闲+离线 -> wait offline)', () => {
    assert.deepEqual(decideOutboxAction({ ...baseInput, online: false }), {
      kind: 'wait',
      reason: 'offline',
    })
    // 边界：空闲 + 离线 → wait('offline') 优先于 send
    assert.deepEqual(decideOutboxAction({ ...baseInput, online: false, sessionRunning: false }), {
      kind: 'wait',
      reason: 'offline',
    })
  })

  // 2. !routeReady -> wait('no-route')
  await t.test('2. !routeReady -> wait no-route', () => {
    assert.deepEqual(decideOutboxAction({ ...baseInput, routeReady: false }), {
      kind: 'wait',
      reason: 'no-route',
    })
    // 优先级高于 !sessionRunning
    assert.deepEqual(decideOutboxAction({ ...baseInput, routeReady: false, sessionRunning: false }), {
      kind: 'wait',
      reason: 'no-route',
    })
  })

  // 3. !nodeOnline -> wait('node-offline')
  await t.test('3. !nodeOnline -> wait node-offline', () => {
    assert.deepEqual(decideOutboxAction({ ...baseInput, nodeOnline: false }), {
      kind: 'wait',
      reason: 'node-offline',
    })
    // 优先级高于 !sessionRunning
    assert.deepEqual(decideOutboxAction({ ...baseInput, nodeOnline: false, sessionRunning: false }), {
      kind: 'wait',
      reason: 'node-offline',
    })
  })

  // 4. !sessionRunning -> send (空闲时永远直接发)
  await t.test('4. !sessionRunning -> send（空闲时直接发，不进入插话或排队分支）', () => {
    assert.deepEqual(decideOutboxAction({ ...baseInput, sessionRunning: false }), {
      kind: 'send',
    })
    // 空闲时即便 busySendMode='queue' / 有附件 / 非 hermes 也直接发
    assert.deepEqual(decideOutboxAction({
      ...baseInput,
      sessionRunning: false,
      busySendMode: 'queue',
      hasAttachments: true,
      provider: 'codex',
    }), {
      kind: 'send',
    })
  })

  // 5. busySendMode === 'queue' -> queue('mode-queue')
  await t.test('5. busySendMode === queue -> queue mode-queue', () => {
    assert.deepEqual(decideOutboxAction({ ...baseInput, busySendMode: 'queue' }), {
      kind: 'queue',
      reason: 'mode-queue',
    })
  })

  // 6. busySendMode === 'interrupt' -> interruptPending ? wait('interrupting') : interrupt
  await t.test('6. busySendMode === interrupt -> interrupt / wait interrupting', () => {
    assert.deepEqual(decideOutboxAction({ ...baseInput, busySendMode: 'interrupt', interruptPending: false }), {
      kind: 'interrupt',
    })
    assert.deepEqual(decideOutboxAction({ ...baseInput, busySendMode: 'interrupt', interruptPending: true }), {
      kind: 'wait',
      reason: 'interrupting',
    })
  })

  // 7. hasAttachments -> queue('attachments')
  await t.test('7. hasAttachments -> queue attachments', () => {
    assert.deepEqual(decideOutboxAction({ ...baseInput, hasAttachments: true }), {
      kind: 'queue',
      reason: 'attachments',
    })
  })

  // 8. provider !== 'hermes' -> queue('steer-unsupported')
  await t.test('8. provider !== hermes -> queue steer-unsupported', () => {
    assert.deepEqual(decideOutboxAction({ ...baseInput, provider: 'codex' }), {
      kind: 'queue',
      reason: 'steer-unsupported',
    })
    assert.deepEqual(decideOutboxAction({ ...baseInput, provider: 'opencode' }), {
      kind: 'queue',
      reason: 'steer-unsupported',
    })
  })

  // 9. steerPending -> wait('steer-pending')
  await t.test('9. steerPending -> wait steer-pending', () => {
    assert.deepEqual(decideOutboxAction({ ...baseInput, steerPending: true }), {
      kind: 'wait',
      reason: 'steer-pending',
    })
  })

  // 10. steerBlocked -> queue('mode-queue')
  await t.test('10. steerBlocked -> queue mode-queue', () => {
    assert.deepEqual(decideOutboxAction({ ...baseInput, steerBlocked: true }), {
      kind: 'queue',
      reason: 'mode-queue',
    })
  })

  // 11. 否则 -> steer
  await t.test('11. 否则 -> steer', () => {
    assert.deepEqual(decideOutboxAction(baseInput), {
      kind: 'steer',
    })
  })
})

test('planSteerOutcome: 覆盖 accepted / idle / unsupported / not_redirected / 空 code 等情况', () => {
  // 1. accepted -> accepted
  assert.deepEqual(planSteerOutcome(true), { kind: 'accepted' })
  assert.deepEqual(planSteerOutcome(true, 'idle'), { kind: 'accepted' })

  // 2. code === 'idle' -> resend
  assert.deepEqual(planSteerOutcome(false, 'idle'), { kind: 'resend' })

  // 3. code === 'unsupported' -> queue
  assert.deepEqual(planSteerOutcome(false, 'unsupported'), { kind: 'queue' })

  // 3b. 本地根本没发出（socket 不可用 / 同会话已有插话在途）-> retry-later，不算未确认
  assert.deepEqual(planSteerOutcome(false, 'not_sent'), { kind: 'retry-later' })
  assert.deepEqual(planSteerOutcome(false, 'pending'), { kind: 'retry-later' })

  // 4. code === 'not_redirected' -> unconfirmed
  assert.deepEqual(planSteerOutcome(false, 'not_redirected'), {
    kind: 'unconfirmed',
    message: '插话未确认：上游可能已排队，未自动重发。',
  })

  // 5. 空 code (undefined / null / '') / failed / 超时
  assert.deepEqual(planSteerOutcome(false, undefined), {
    kind: 'unconfirmed',
    message: '插话未确认：上游可能已排队，未自动重发。',
  })
  assert.deepEqual(planSteerOutcome(false, null), {
    kind: 'unconfirmed',
    message: '插话未确认：上游可能已排队，未自动重发。',
  })
  assert.deepEqual(planSteerOutcome(false, ''), {
    kind: 'unconfirmed',
    message: '插话未确认：上游可能已排队，未自动重发。',
  })
  assert.deepEqual(planSteerOutcome(false, 'failed'), {
    kind: 'unconfirmed',
    message: '插话未确认：上游可能已排队，未自动重发。',
  })
  assert.deepEqual(planSteerOutcome(false, 'timeout'), {
    kind: 'unconfirmed',
    message: '插话未确认：上游可能已排队，未自动重发。',
  })
})

test('deliveryTimedOut: 边界判定（差 1ms、相等、超 1ms）', () => {
  const startedAt = 10_000
  const timeoutMs = 30_000

  // 未超时：差 1ms
  assert.equal(deliveryTimedOut(startedAt, startedAt + timeoutMs - 1, timeoutMs), false)
  // 边界：正好相等
  assert.equal(deliveryTimedOut(startedAt, startedAt + timeoutMs, timeoutMs), true)
  // 超时：超 1ms
  assert.equal(deliveryTimedOut(startedAt, startedAt + timeoutMs + 1, timeoutMs), true)

  // 常量验证
  assert.equal(SEND_ACK_TIMEOUT_MS, 30_000)
  assert.equal(STEER_ACK_TIMEOUT_MS, 15_000)
})
