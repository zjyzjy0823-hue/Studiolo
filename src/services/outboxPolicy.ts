export type BusySendMode = 'auto' | 'queue' | 'interrupt'

export type OutboxWaitReason =
  | 'offline' | 'no-route' | 'node-offline' | 'steer-pending' | 'interrupting'

export type OutboxDecision =
  | { kind: 'send' }
  | { kind: 'steer' }
  | { kind: 'queue'; reason: 'mode-queue' | 'attachments' | 'steer-unsupported' }
  | { kind: 'interrupt' }
  | { kind: 'wait'; reason: OutboxWaitReason }

export interface OutboxPolicyInput {
  online: boolean
  routeReady: boolean
  nodeOnline: boolean
  sessionRunning: boolean
  provider: string
  hasAttachments: boolean
  steerPending: boolean
  steerBlocked: boolean   // 本回合已经试过一次插话（防止死循环）
  busySendMode: BusySendMode
  interruptPending: boolean
}

export function decideOutboxAction(input: OutboxPolicyInput): OutboxDecision {
  if (!input.online) {
    return { kind: 'wait', reason: 'offline' }
  }
  if (!input.routeReady) {
    return { kind: 'wait', reason: 'no-route' }
  }
  if (!input.nodeOnline) {
    return { kind: 'wait', reason: 'node-offline' }
  }
  if (!input.sessionRunning) {
    return { kind: 'send' }
  }
  if (input.busySendMode === 'queue') {
    return { kind: 'queue', reason: 'mode-queue' }
  }
  if (input.busySendMode === 'interrupt') {
    return input.interruptPending
      ? { kind: 'wait', reason: 'interrupting' }
      : { kind: 'interrupt' }
  }
  if (input.hasAttachments) {
    return { kind: 'queue', reason: 'attachments' }
  }
  if (input.provider !== 'hermes') {
    return { kind: 'queue', reason: 'steer-unsupported' }
  }
  if (input.steerPending) {
    return { kind: 'wait', reason: 'steer-pending' }
  }
  if (input.steerBlocked) {
    return { kind: 'queue', reason: 'mode-queue' }
  }
  return { kind: 'steer' }
}

export type SteerPlan =
  | { kind: 'accepted' }
  | { kind: 'resend' }                                  // idle：回合已结束，立刻正常发送
  | { kind: 'queue' }                                   // unsupported：退回排队
  | { kind: 'retry-later' }                             // 本地根本没发出（socket 不可用 / 同会话已有插话在途）：清标记，等下次 flush
  | { kind: 'unconfirmed'; message: string }            // 其余：可能已排队，禁止自动重发

export function planSteerOutcome(accepted: boolean, code?: string | null): SteerPlan {
  if (accepted) {
    return { kind: 'accepted' }
  }
  if (code === 'idle') {
    return { kind: 'resend' }
  }
  if (code === 'unsupported') {
    return { kind: 'queue' }
  }
  if (code === 'not_sent' || code === 'pending') {
    return { kind: 'retry-later' }
  }
  return {
    kind: 'unconfirmed',
    message: '插话未确认：上游可能已排队，未自动重发。',
  }
}

export const SEND_ACK_TIMEOUT_MS = 30_000
export const STEER_ACK_TIMEOUT_MS = 15_000

export function deliveryTimedOut(startedAt: number, now: number, timeoutMs: number): boolean {
  return now - startedAt >= timeoutMs
}
