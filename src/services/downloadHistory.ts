export type DownloadChannel = 'relay' | 'external'
export type DownloadStatus = 'saved' | 'handed_off'

export interface DownloadRecord {
  id: string
  name: string
  sizeBytes: number
  at: number
  channel: DownloadChannel
  status: DownloadStatus
  /** 外链下载才有；24 小时后自动失效 */
  url?: string
  expiresAt?: number
  sessionKey?: string
}

const STORAGE_KEY = 'studiolo.downloads.v1'
const MAX_RECORDS = 100

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function parse(raw: string | null): DownloadRecord[] {
  if (!raw) return []
  try {
    const data = JSON.parse(raw)
    if (!Array.isArray(data)) return []
    return data.filter((item): item is DownloadRecord => Boolean(item)
      && typeof item.id === 'string'
      && typeof item.name === 'string'
      && typeof item.sizeBytes === 'number'
      && typeof item.at === 'number'
      && (item.channel === 'relay' || item.channel === 'external')
      && (item.status === 'saved' || item.status === 'handed_off'))
  } catch {
    return []
  }
}

export function readDownloads(storage: StorageLike | null = defaultStorage()): DownloadRecord[] {
  if (!storage) return []
  return parse(storage.getItem(STORAGE_KEY))
}

function write(storage: StorageLike | null, records: DownloadRecord[]): DownloadRecord[] {
  const trimmed = records.slice(0, MAX_RECORDS)
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(trimmed))
  } catch {
    // 存不下（隐私模式/配额满）不应影响下载本身
  }
  return trimmed
}

export function addDownload(
  record: Omit<DownloadRecord, 'id' | 'at'> & { id?: string; at?: number },
  storage: StorageLike | null = defaultStorage(),
): DownloadRecord[] {
  const entry: DownloadRecord = {
    ...record,
    id: record.id || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    at: record.at ?? Date.now(),
  }
  const existing = readDownloads(storage).filter(item => item.id !== entry.id)
  return write(storage, [entry, ...existing])
}

export function removeDownload(id: string, storage: StorageLike | null = defaultStorage()): DownloadRecord[] {
  return write(storage, readDownloads(storage).filter(item => item.id !== id))
}

export function clearDownloads(storage: StorageLike | null = defaultStorage()): DownloadRecord[] {
  return write(storage, [])
}

/** 外链是否还能点开：没有链接或已过期都不能再打开。 */
export function isRecordOpenable(record: DownloadRecord, now = Date.now()): boolean {
  if (record.channel !== 'external' || !record.url) return false
  if (typeof record.expiresAt === 'number' && record.expiresAt * 1000 <= now) return false
  return true
}
