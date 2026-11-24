import type { ChatMessage, ChatSession, FleetWsEvent, MessageMediaItem, MessagePart, ToolCallBadge } from '../types/fleet'
import { appendMessagePart } from './chatHelpers.ts'
import { classifySystemNotice } from './systemNotices.ts'

type HistoryMessage = NonNullable<FleetWsEvent['messages']>[number]
type SnapshotToolCall = Omit<ToolCallBadge, 'id' | 'status' | 'durationMs'> & {
  id?: string
  status?: string
  durationMs?: number | null
}

export type EpochSnapshotMessage = Omit<HistoryMessage, 'toolCalls'> & {
  turnId?: string | null
  durationMs?: number | null
  toolCalls?: SnapshotToolCall[] | null
}

type EpochMessageContent = Pick<ChatMessage, 'text' | 'thought' | 'parts'>

export function normalizeEpochMessageContent(message: Partial<EpochMessageContent>): Pick<ChatMessage, 'text' | 'thought'> {
  const parts = Array.isArray(message.parts) ? message.parts : []
  const read = (field: 'text' | 'thought') => {
    const value = message[field]
    if (typeof value === 'string' && value.trim()) return value
    return parts.flatMap(part => part?.type === field && typeof part.text === 'string' ? [part.text] : []).join('')
  }
  return { text: read('text'), thought: read('thought') || undefined }
}

export function hasEpochMessageContent(message: ChatMessage): boolean {
  return message.role !== 'assistant' || Boolean(
    message.text?.trim() || message.thought?.trim() || message.toolCalls?.length ||
    message.parts?.some(part => part.type !== 'tool' && part.text.trim()) ||
    message.media?.length || message.systemEvents?.length || message.error ||
    message.forms?.length || message.approvals?.length || message.artifacts?.length,
  )
}

export function mapEpochSnapshotMessage(message: EpochSnapshotMessage, context: {
  session: Pick<ChatSession, 'nodeId' | 'provider'>
  fallbackId: string
  fallbackCreatedAt: number
  liveRunId?: string
}): ChatMessage {
  const { session, fallbackId, fallbackCreatedAt, liveRunId } = context
  const { durationMs, thought, systemEvents } = message
  const runId = message.turnId ?? message.runId
  const role = message.role === 'user' || message.role === 'system' ? message.role : 'assistant'
  const notice = role === 'user' ? classifySystemNotice(message.text) : null
  const effectiveRole = notice ? 'system' as const : role
  const toolCalls = message.toolCalls?.map<ToolCallBadge>(({ durationMs, status, ...tool }, index) => ({
    ...tool,
    id: tool.callId || tool.id || `${fallbackId}-tool-${index}`,
    name: tool.name || 'tool',
    title: tool.title || tool.detail || tool.name,
    status: status === 'completed' ? 'success' : status === 'error' || status === 'failed' ? 'error' : 'running',
    ...(durationMs != null ? { durationMs } : {}),
  }))

  const parts = message.parts?.reduce<MessagePart[]>((acc, part) => {
    if ((part.type === 'text' || part.type === 'thought') && part.text) {
      return appendMessagePart(acc, { type: part.type, text: part.text })
    }
    const callId = part.callId || part.id
    return part.type === 'tool' && callId ? appendMessagePart(acc, { type: 'tool', callId }) : acc
  }, [])
  if (parts?.length) {
    const represented = new Set(parts.flatMap(part => part.type === 'tool' ? [part.callId] : []))
    for (const tool of toolCalls ?? []) {
      const callId = tool.callId || tool.id
      if (!represented.has(callId)) parts.push({ type: 'tool', callId })
    }
  }

  const mediaByUrl = new Map<string, MessageMediaItem>()
  for (const item of [...(message.media ?? []), ...(toolCalls?.flatMap(tool => tool.media ?? []) ?? [])]) {
    if (item?.url && !mediaByUrl.has(item.url)) mediaByUrl.set(item.url, item)
  }

  return {
    id: message.id || (runId ? `hist-${message.role}-${runId}` : fallbackId),
    role: effectiveRole,
    nodeId: session.nodeId,
    provider: session.provider,
    runId,
    requestId: message.requestId,
    text: message.text ?? '',
    epochSnapshot: true,
    ...(thought ? { thought } : {}),
    ...(systemEvents?.length ? { systemEvents } : {}),
    ...(toolCalls?.length ? { toolCalls } : {}),
    ...(parts?.length ? { parts } : {}),
    ...(mediaByUrl.size ? { media: [...mediaByUrl.values()] } : {}),
    ...(durationMs != null && durationMs > 0 && Number.isFinite(durationMs) ? { durationMs } : {}),
    streaming: Boolean(runId && effectiveRole === 'assistant' && runId === liveRunId),
    createdAt: message.createdAt ?? fallbackCreatedAt,
  }
}
