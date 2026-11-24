/**
 * Hermes 把后台任务/子代理完成通知写成 user 角色的消息，客户端若直接渲染就会变成
 * “用户自己说的话”。这里按文本开头把它们归类为系统通知，交给现有的 system 渲染。
 *
 * 只锚定开头（^），避免把正常对话里以 [ 开头的内容误判。
 */

export type SystemNoticeKind = 'process' | 'delegation' | 'batch'

const PROCESS_NOTICE = /^\[IMPORTANT: Background process [A-Za-z0-9_]+\s+(?:completed|failed|exited)/
const BATCH_NOTICE = /^\[IMPORTANT: (\d+) background process(?:es)?\s+(?:completed|failed|exited)/
const DELEGATION_NOTICE = /^\[ASYNC DELEGATION BATCH COMPLETE — [A-Za-z0-9_]+\]/

export interface SystemNotice {
  kind: SystemNoticeKind
  title: string
}

/** 命中返回通知描述，否则返回 null。 */
export function classifySystemNotice(text?: string | null): SystemNotice | null {
  if (typeof text !== 'string' || !text.startsWith('[IMPORTANT:') && !text.startsWith('[ASYNC DELEGATION')) {
    return null
  }
  if (DELEGATION_NOTICE.test(text)) return { kind: 'delegation', title: '子代理批次已完成' }
  const batch = BATCH_NOTICE.exec(text)
  if (batch) {
    const count = Number(batch[1])
    return { kind: 'batch', title: Number.isFinite(count) && count > 1 ? `${count} 个后台任务已完成` : '后台任务已完成' }
  }
  if (PROCESS_NOTICE.test(text)) return { kind: 'process', title: '后台任务已完成' }
  return null
}

/**
 * 把「其实是系统通知」的 user 消息转成 system 消息（正文保留，用户仍可展开看细节）。
 * 非 user 或未命中时原样返回。
 */
export function applySystemNotice<T extends { role: string; text?: string }>(message: T): T {
  if (message.role !== 'user') return message
  const notice = classifySystemNotice(message.text)
  if (!notice) return message
  return { ...message, role: 'system' }
}

export function applySystemNotices<T extends { role: string; text?: string }>(messages: readonly T[]): T[] {
  return messages.map(applySystemNotice)
}
