export type SyncMode = 'legacy' | 'epoch'

export interface SessionSync {
  open(sessionKey: string): Promise<void>
  resume(sessionKey: string): Promise<void>
  syncAll(): Promise<void>
}

const PAGE_SIZE = 500

function rpcResult(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid session replay response')
  }
  const result = value as Record<string, unknown>
  if (result.code === 'replay_incomplete') {
    throw new Error('replay_incomplete: fall back to legacy for this session')
  }
  if (typeof result.code === 'string' || result.ok === false) {
    throw new Error([result.code, result.error].filter(Boolean).join(': ') || 'Session replay RPC failed')
  }
  return result
}

function readSeq(value: unknown, min: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    throw new Error('Invalid or unsafe session replay sequence')
  }
  return value
}

export function createSessionSync(opts: {
  mode: SyncMode
  rpc: (method: string, params: unknown) => Promise<unknown>
  apply: (sessionKey: string, snapshot: unknown) => void
  append: (sessionKey: string, events: unknown[]) => void
}): SessionSync {
  const lastSeqBySession = new Map<string, { epoch: string; lastSeq: number } | undefined>()
  const pending = new Map<string, Promise<void>>()

  function run(sessionKey: string, task: () => Promise<void>): Promise<void> {
    if (opts.mode === 'legacy') return Promise.resolve()
    const previous = pending.get(sessionKey) ?? Promise.resolve()
    const current = previous.then(task, task).finally(() => {
      if (pending.get(sessionKey) === current) pending.delete(sessionKey)
    })
    pending.set(sessionKey, current)
    return current
  }

  async function readSnapshot(sessionKey: string): Promise<void> {
    const result = rpcResult(await opts.rpc('session.snapshot', { sessionKey }))
    if (typeof result.epoch !== 'string' || !result.epoch || !result.snapshot) {
      throw new Error('Invalid session snapshot response')
    }
    const lastSeq = readSeq(result.lastSeq, 0)
    opts.apply(sessionKey, result.snapshot)
    lastSeqBySession.set(sessionKey, { epoch: result.epoch, lastSeq })
  }

  async function readEvents(sessionKey: string): Promise<void> {
    const cursor = lastSeqBySession.get(sessionKey)
    if (!cursor) return readSnapshot(sessionKey)
    const { epoch } = cursor
    let { lastSeq } = cursor

    for (;;) {
      const page = rpcResult(await opts.rpc('session.events.since', { sessionKey, epoch, lastSeq, limit: PAGE_SIZE }))
      if (typeof page.epoch !== 'string' || !page.epoch) throw new Error('Invalid session replay epoch')
      if (page.epoch !== epoch || page.snapshotRequired === true) {
        lastSeqBySession.set(sessionKey, undefined)
        return readSnapshot(sessionKey)
      }
      if (!Array.isArray(page.events) || typeof page.hasMore !== 'boolean') {
        throw new Error('Invalid session replay page')
      }
      const ordered = page.events.map(event => ({ event, seq: readSeq(event?.seq, 1) }))
        .sort((a, b) => a.seq - b.seq)
      const events: unknown[] = []
      let nextSeq = lastSeq
      for (const { event, seq } of ordered) {
        if (seq <= nextSeq) continue
        events.push(event)
        nextSeq = seq
      }
      if (nextSeq === lastSeq && page.hasMore) throw new Error('Session replay page did not advance the cursor')
      if (events.length) {
        opts.append(sessionKey, events)
        lastSeq = nextSeq
        lastSeqBySession.set(sessionKey, { epoch, lastSeq })
      }
      if (!page.hasMore) return
    }
  }

  function resume(sessionKey: string): Promise<void> {
    return run(sessionKey, () => readEvents(sessionKey))
  }

  return {
    open: sessionKey => run(sessionKey, () => readSnapshot(sessionKey)),
    resume,
    async syncAll() {
      await Promise.all(Array.from(lastSeqBySession.keys(), resume))
    },
  }
}

export function readSyncMode(): SyncMode {
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('syncMode') === 'epoch') {
    return 'epoch'
  }
  try {
    if (localStorage.getItem('studiolo.syncMode') === 'epoch') return 'epoch'
    if (localStorage.getItem('studiolo.syncMode') === 'legacy') return 'legacy'
  } catch {
    // 存储不可用时继续往下走
  }
  // 构建期开关：打包测试版时用 VITE_SYNC_MODE=epoch，真机可验证；不设则仍是 legacy
  const baked = import.meta.env?.VITE_SYNC_MODE
  return baked === 'epoch' ? 'epoch' : 'legacy'
}
