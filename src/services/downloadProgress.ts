export type DownloadPhase = 'downloading' | 'saving' | 'done' | 'failed'

export interface DownloadProgressState {
  phase: DownloadPhase
  percent: number | null
  loaded: number
  total: number | null
}

export function percentOf(loaded: number, total: number | null): number | null {
  if (total == null || total <= 0) return null
  return Math.min(100, Math.max(0, Math.floor((loaded / total) * 100)))
}

export function shouldReport(now: number, lastAt: number): boolean {
  return now - lastAt >= 100
}

function areStatesEqual(a: DownloadProgressState | undefined, b: DownloadProgressState | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.phase === b.phase
    && a.percent === b.percent
    && a.loaded === b.loaded
    && a.total === b.total
}

export type ProgressSubscriber = (state: DownloadProgressState | undefined) => void

export interface DownloadProgressStore {
  get(key?: string): DownloadProgressState | undefined
  set(state: DownloadProgressState): void
  set(key: string, state: DownloadProgressState): void
  clear(key?: string): void
  subscribe(subscriber: ProgressSubscriber): () => void
  subscribe(key: string, subscriber: ProgressSubscriber): () => void
}

export function createDownloadProgressStore(): DownloadProgressStore {
  const states = new Map<string, DownloadProgressState>()
  const subscribers = new Set<ProgressSubscriber>()
  const keyedSubscribers = new Map<string, Set<ProgressSubscriber>>()

  function get(key = 'default'): DownloadProgressState | undefined {
    return states.get(key)
  }

  function set(arg1: string | DownloadProgressState, arg2?: DownloadProgressState): void {
    const isKeyed = typeof arg1 === 'string'
    const key = isKeyed ? arg1 : 'default'
    const nextState = isKeyed ? arg2! : arg1
    const prevState = states.get(key)

    if (areStatesEqual(prevState, nextState)) {
      return
    }

    states.set(key, nextState)

    if (key === 'default') {
      for (const sub of subscribers) {
        sub(nextState)
      }
    }
    const keyed = keyedSubscribers.get(key)
    if (keyed) {
      for (const sub of keyed) {
        sub(nextState)
      }
    }
  }

  function clear(key = 'default'): void {
    if (!states.has(key)) return
    states.delete(key)

    if (key === 'default') {
      for (const sub of subscribers) {
        sub(undefined)
      }
    }
    const keyed = keyedSubscribers.get(key)
    if (keyed) {
      for (const sub of keyed) {
        sub(undefined)
      }
    }
  }

  function subscribe(arg1: string | ProgressSubscriber, arg2?: ProgressSubscriber): () => void {
    if (typeof arg1 === 'function') {
      subscribers.add(arg1)
      return () => {
        subscribers.delete(arg1)
      }
    }
    const key = arg1
    const subscriber = arg2!
    let setForKey = keyedSubscribers.get(key)
    if (!setForKey) {
      setForKey = new Set()
      keyedSubscribers.set(key, setForKey)
    }
    setForKey.add(subscriber)
    return () => {
      setForKey?.delete(subscriber)
      if (setForKey?.size === 0) {
        keyedSubscribers.delete(key)
      }
    }
  }

  return { get, set, clear, subscribe }
}

export const downloadProgressStore = createDownloadProgressStore()
