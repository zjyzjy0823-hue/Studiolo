import type { ProcessItem, SubagentItem } from '../types/fleet'

export type SessionActivityResult<T> =
  | { kind: 'ok'; items: T[] }
  | { kind: 'unsupported' }
  | { kind: 'error'; message: string }

const unavailable = '暂不可用'

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function timestamp(value: unknown): number | null {
  const text = string(value).trim()
  const numeric = number(value) ?? (text && Number.isFinite(Number(text)) ? Number(text) : null)
  if (numeric !== null) return numeric < 1e12 ? numeric * 1000 : numeric
  const millis = Date.parse(text)
  return Number.isFinite(millis) ? millis : null
}

function readLists(payload: unknown, field: 'processes' | 'subagents') {
  const body = record(payload)
  if (body?.unsupported === true) return { kind: 'unsupported' } as const
  const rows = body?.[field]
  if (body?.ok === false || body?.error || !Array.isArray(rows)) {
    return {
      kind: 'error',
      message: string(body?.error) || string(record(body?.error)?.message) || string(body?.message) || unavailable,
    } as const
  }
  const related = body?.delegations
  return {
    kind: 'ok',
    rows: rows as unknown[],
    delegations: Array.isArray(related) ? related as unknown[] : [],
  } as const
}

export function mapSessionProcesses(payload: unknown): SessionActivityResult<ProcessItem> {
  const result = readLists(payload, 'processes')
  if (result.kind !== 'ok') return result
  const items = result.rows.flatMap((value, index) => {
    const row = record(value)
    if (!row) return []
    const pid = number(row.pid)
    const uptime = number(row.uptime_seconds)
    return [{
      id: string(row.session_id) || string(row.id) || (pid === null ? `row-${index}` : `pid-${pid}`),
      command: string(row.command),
      cwd: string(row.cwd),
      pid,
      status: string(row.status) || 'unknown',
      uptimeSeconds: uptime === null ? null : Math.max(0, uptime),
      outputPreview: string(row.output_preview),
      outputTail: string(row.output_tail),
      exitCode: number(row.exit_code),
      startedAt: timestamp(row.started_at),
    }]
  })
  return { kind: 'ok', items }
}

export function mapSessionSubagents(payload: unknown): SessionActivityResult<SubagentItem> {
  const result = readLists(payload, 'subagents')
  if (result.kind !== 'ok') return result
  const batches = new Set(result.delegations.map(value => {
    const row = record(value)
    return string(row?.delegation_id) || string(row?.id)
  }).filter(Boolean))
  const items = new Map<string, SubagentItem>()
  for (const [index, value] of [...result.rows, ...result.delegations].entries()) {
    const row = record(value)
    if (!row) continue
    const delegationId = string(row.delegation_id)
    const id = string(row.id) || string(row.subagent_id) || delegationId || `row-${index}`
    if (index < result.rows.length && id !== delegationId && batches.has(delegationId)) continue
    const previous = items.get(id)
    const goals = Array.isArray(row.goals) ? row.goals.filter((goal): goal is string => typeof goal === 'string' && !!goal.trim()) : []
    items.set(id, {
      id,
      goals: goals.length ? goals : previous?.goals ?? [string(row.goal)].filter(Boolean),
      count: Math.max(0, Math.floor(number(row.count) ?? previous?.count ?? 1)),
      status: string(row.status) || previous?.status || 'unknown',
    })
  }
  return { kind: 'ok', items: [...items.values()] }
}

export function retainSessionProcesses(items: ProcessItem[], previous: ProcessItem[] = []): ProcessItem[] {
  const current = new Map(items.map(item => [item.id, item]))
  const running = [...current.values()].filter(item => item.status === 'running')
  const history = [
    ...[...current.values()].filter(item => item.status !== 'running'),
    ...previous.filter(item => item.status !== 'running' && !current.has(item.id)),
  ]
    .sort((a, b) => (b.startedAt ?? -Infinity) - (a.startedAt ?? -Infinity))
    .slice(0, 5)
  return [...running, ...history]
}
