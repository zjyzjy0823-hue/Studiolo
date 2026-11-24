import { redactSessionTitleCredentials } from './chatHelpers.ts'
import { normalizeEpochMessageContent } from './epochSnapshot.ts'
import type { SyncMode } from './sessionSync'
import type { ChatMessage, ToolCallBadge } from '../types/fleet'

type CachedToolCall = Pick<ToolCallBadge, 'id' | 'name' | 'title' | 'toolKind' | 'status' | 'durationMs'>
type CacheableMessage = Pick<ChatMessage, 'id' | 'role' | 'text' | 'thought' | 'toolCalls' | 'durationMs' | 'createdAt' | 'streaming'>

export interface CachedMessage extends Omit<CacheableMessage, 'createdAt' | 'streaming' | 'toolCalls'> {
  at: number
  streaming: false
  toolCalls?: CachedToolCall[]
}

export interface MessageCacheRecord {
  updatedAt: number
  messages: CachedMessage[]
  lastSeq: number
  epoch: string | null
}

const MAX_MESSAGES = 300
const MAX_SESSIONS = 30
const STORE = 'sessions'
const CACHE_KEY = 'studiolo.messageCache.v1'
const SWITCH_KEY = 'studiolo.localCache'
type LocalStorage = Pick<Storage, 'getItem' | 'setItem'>

function cleanText(value: string): string {
  const plain = value.replace(/\b(?:data:[^\s"'<>()[\],]*,|blob:)[^\s"'<>()[\]]*/gi, '[附件已隐藏]')
  return redactSessionTitleCredentials(plain)
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/g, '[密钥已隐藏]')
    .replace(/\b(?:Bearer\s+[\w+./=-]+|Basic\s+[\w+/]{12,}={0,2})/gi, '[密钥已隐藏]')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, '[密钥已隐藏]')
    .replace(/((?:\b[\w-]*(?:token|secret|password|api[_-]?key|keyb64|authorization)|密钥)["'`]?\s*[:=：]\s*)["'`]?[\w+./=-]+["'`]?/gi, '$1[密钥已隐藏]')
    .replace(/(?:\bbase64["'`]?\s*[:=]\s*["'`]?[A-Za-z0-9+/_=-]+|[A-Za-z0-9+/_-]{48,}={0,2}|[A-Za-z0-9+/_-]{7,}={1,2}(?![\w=]))/gi, '[编码内容已隐藏]')
}

function optionalText(value: string | undefined): string | undefined {
  return typeof value === 'string' ? cleanText(value) : undefined
}

function cacheTool(call: ToolCallBadge): CachedToolCall {
  const { status } = call
  return {
    id: cleanText(call.id), name: cleanText(call.name), title: optionalText(call.title),
    toolKind: optionalText(call.toolKind),
    // Persisted running status is not evidence of current tool activity.
    status: status === 'running'
      ? 'completed'
      : status === 'completed' || status === 'success' || status === 'error'
        ? status
        : undefined,
    durationMs: Number.isFinite(call.durationMs) ? call.durationMs : undefined,
  }
}

function cacheMessage(message: CacheableMessage): CachedMessage {
  return {
    id: cleanText(message.id), role: message.role, text: message.streaming ? '' : cleanText(message.text),
    thought: message.streaming ? undefined : optionalText(message.thought),
    toolCalls: message.streaming ? undefined : message.toolCalls?.map(cacheTool),
    durationMs: Number.isFinite(message.durationMs) ? message.durationMs : undefined,
    at: Number.isFinite(message.createdAt) ? message.createdAt : 0, streaming: false,
  }
}

function decodeRecord(value: unknown, mode: SyncMode): MessageCacheRecord | undefined {
  const row = value as Partial<MessageCacheRecord> | null | undefined
  if (!row || !Number.isFinite(row.updatedAt) || !Number.isSafeInteger(row.lastSeq) ||
    !(row.epoch === null || typeof row.epoch === 'string') || !Array.isArray(row.messages)) return
  return {
    updatedAt: row.updatedAt!, lastSeq: row.lastSeq!, epoch: row.epoch,
    messages: row.messages.slice(-MAX_MESSAGES).filter(message =>
      message && typeof message.id === 'string' && (mode === 'epoch' || typeof message.text === 'string') && Number.isFinite(message.at) &&
      (message.role === 'user' || message.role === 'assistant' || message.role === 'system'),
    ).map(message => cacheMessage({
      ...message, createdAt: message.at,
      ...(mode === 'epoch' ? normalizeEpochMessageContent(message) : {}),
    })),
  }
}

export function createMessageCache(options: {
  indexedDB?: () => IDBFactory | undefined
  localStorage?: () => LocalStorage | undefined
} = {}) {
  const getIndexedDB = options.indexedDB ?? (() => globalThis.indexedDB)
  const getLocalStorage = options.localStorage ?? (() => globalThis.localStorage)
  let database: Promise<IDBDatabase> | undefined
  let lastUpdatedAt = 0
  let writes = Promise.resolve()

  function enabled(): boolean {
    try { return getLocalStorage()?.getItem(SWITCH_KEY) !== 'off' } catch { return true }
  }

  function openDatabase(): Promise<IDBDatabase> {
    database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = getIndexedDB()?.open(CACHE_KEY, 1)
      if (!request) {
        reject(new Error('IndexedDB unavailable'))
        return
      }
      let expired = false
      const fail = () => {
        expired = true
        clearTimeout(timer)
        reject(new Error('Message cache unavailable'))
      }
      const timer = setTimeout(fail, 200)
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE).createIndex('updatedAt', 'updatedAt')
      }
      request.onsuccess = () => {
        const db = request.result
        if (expired) {
          db.close()
          return
        }
        clearTimeout(timer)
        db.onversionchange = () => { db.close(); database = undefined }
        resolve(db)
      }
      request.onerror = request.onblocked = fail
    })
    return database
  }

  async function readIndexedDB(key: string): Promise<unknown> {
    const db = await openDatabase()
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE)
      const request = transaction.objectStore(STORE).get(key)
      request.onsuccess = () => resolve(request.result)
      transaction.onabort = () => reject(transaction.error)
    })
  }

  async function changeIndexedDB(key: string, value?: MessageCacheRecord): Promise<void> {
    const db = await openDatabase()
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite')
      const store = transaction.objectStore(STORE)
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(transaction.error)
      if (!value) {
        store.delete(key)
        return
      }
      store.put(value, key)
      const keys = store.index('updatedAt').getAllKeys()
      keys.onsuccess = () => {
        for (const oldKey of keys.result.slice(0, -MAX_SESSIONS)) store.delete(oldKey)
      }
    })
  }

  function localRecords(storage: LocalStorage): Map<string, MessageCacheRecord> {
    return new Map(Object.entries(JSON.parse(storage.getItem(CACHE_KEY) ?? '{}')))
  }

  function changeLocalStorage(key: string, value?: MessageCacheRecord) {
    const storage = getLocalStorage()
    if (!storage) return
    let records: Map<string, MessageCacheRecord>
    try { records = localRecords(storage) } catch { records = new Map() }
    if (value) {
      records.set(key, value)
      const ordered = [...records].sort(([, a], [, b]) => (a?.updatedAt ?? 0) - (b?.updatedAt ?? 0))
      for (const [oldKey] of ordered.slice(0, -MAX_SESSIONS)) records.delete(oldKey)
    } else if (!records.delete(key)) {
      return
    }
    storage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(records)))
  }

  // A stalled browser database must not delay opening a session indefinitely.
  async function tryIndexedDB<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Message cache timed out')), 250)
      })])
    } finally {
      clearTimeout(timer)
    }
  }

  function keyFor(scope: string, sessionKey: string): string {
    return JSON.stringify([scope, sessionKey])
  }

  return {
    enabled,
    async read(scope: string, sessionKey: string, mode: SyncMode = 'legacy'): Promise<MessageCacheRecord | undefined> {
      if (!enabled()) return
      const key = keyFor(scope, sessionKey)
      try {
        return decodeRecord(await tryIndexedDB(readIndexedDB(key)), mode)
      } catch {
        try {
          const storage = getLocalStorage()
          return storage ? decodeRecord(localRecords(storage).get(key), mode) : undefined
        } catch { return undefined }
      }
    },
    write(scope: string, sessionKey: string, messages: readonly CacheableMessage[], lastSeq: number, epoch: string | null): Promise<void> {
      if (!enabled()) return Promise.resolve()
      return writes = writes.then(async () => {
        if (!enabled()) return
        const key = keyFor(scope, sessionKey)
        lastUpdatedAt = Math.max(Date.now(), lastUpdatedAt + 1)
        const value: MessageCacheRecord = {
          updatedAt: lastUpdatedAt, messages: messages.slice(-MAX_MESSAGES).map(cacheMessage), lastSeq, epoch,
        }
        try { await changeIndexedDB(key, value) }
        catch { changeLocalStorage(key, value) }
      }).catch(() => {})
    },
    remove(scope: string, sessionKey: string): Promise<void> {
      return writes = writes.then(async () => {
        const key = keyFor(scope, sessionKey)
        try { changeLocalStorage(key) } catch { /* Best effort in both stores. */ }
        try { await changeIndexedDB(key) } catch { /* The browser may have disabled IndexedDB. */ }
      })
    },
  }
}

export const messageCache = createMessageCache()
