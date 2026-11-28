import type { DownloadRecord } from './downloadHistory'

export type DownloadType = 'image' | 'doc' | 'archive' | 'installer' | 'other'
export type DownloadFilterType = 'all' | DownloadType
export type DownloadTimeRange = 'all' | 'today' | '7d' | '30d'
export type DownloadSortBy = 'time_desc' | 'time_asc' | 'size_desc' | 'name_asc'

export interface DownloadFilterOptions {
  query?: string
  type?: DownloadFilterType
  range?: DownloadTimeRange
  sort?: DownloadSortBy
  now?: number
}

export interface DownloadSummary {
  count: number
  totalBytes: number
  byType: Record<DownloadType, number>
}

const IMAGE_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff', 'tif', 'heic', 'avif'
])
const DOC_EXTS = new Set([
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pdf', 'txt', 'md', 'csv', 'rtf', 'tsv', 'json', 'xml', 'yaml', 'yml', 'pages', 'numbers', 'key'
])
const ARCHIVE_EXTS = new Set([
  'zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz'
])
const INSTALLER_EXTS = new Set([
  'dmg', 'exe', 'pkg', 'msi', 'deb', 'rpm', 'appimage', 'apk', 'ipa', 'iso'
])

export function typeOf(name: string): DownloadType {
  const leaf = (name || '').split(/[/\\]/).pop() || ''
  const lower = leaf.toLowerCase().trim()
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tar.bz2') || lower.endsWith('.tar.xz')) {
    return 'archive'
  }
  const lastDot = lower.lastIndexOf('.')
  if (lastDot <= 0 || lastDot === lower.length - 1) {
    return 'other'
  }
  const ext = lower.slice(lastDot + 1)
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (DOC_EXTS.has(ext)) return 'doc'
  if (ARCHIVE_EXTS.has(ext)) return 'archive'
  if (INSTALLER_EXTS.has(ext)) return 'installer'
  return 'other'
}

export function formatBytesHuman(bytes: number): string {
  if (!bytes || bytes <= 0 || !Number.isFinite(bytes)) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024
    return `${kb < 10 ? kb.toFixed(1) : (kb % 1 === 0 ? kb.toFixed(0) : kb.toFixed(1))} KB`
  }
  if (bytes < 1024 * 1024 * 1024) {
    const mb = bytes / (1024 * 1024)
    return `${mb.toFixed(1)} MB`
  }
  const gb = bytes / (1024 * 1024 * 1024)
  return `${gb.toFixed(2)} GB`
}

export function summarize(records: { name: string; sizeBytes?: number }[]): DownloadSummary {
  const byType: Record<DownloadType, number> = {
    image: 0,
    doc: 0,
    archive: 0,
    installer: 0,
    other: 0,
  }
  let totalBytes = 0
  for (const record of records) {
    totalBytes += record.sizeBytes || 0
    const t = typeOf(record.name)
    byType[t] = (byType[t] || 0) + 1
  }
  return {
    count: records.length,
    totalBytes,
    byType,
  }
}

export function formatRecordTime(timestamp: number, now = Date.now()): string {
  const date = new Date(timestamp)
  const today = new Date(now)
  const isToday = date.getFullYear() === today.getFullYear()
    && date.getMonth() === today.getMonth()
    && date.getDate() === today.getDate()
  const yesterday = new Date(now - 86400000)
  const isYesterday = date.getFullYear() === yesterday.getFullYear()
    && date.getMonth() === yesterday.getMonth()
    && date.getDate() === yesterday.getDate()

  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  if (isToday) return `今天 ${hh}:${mm}`
  if (isYesterday) return `昨天 ${hh}:${mm}`

  const M = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  if (date.getFullYear() === today.getFullYear()) {
    return `${M}-${d} ${hh}:${mm}`
  }
  return `${date.getFullYear()}-${M}-${d}`
}

export function filterRecords<T extends Partial<DownloadRecord> & { name: string; at: number }>(
  records: T[],
  options: DownloadFilterOptions = {},
): T[] {
  const { query, type = 'all', range = 'all', sort = 'time_desc', now = Date.now() } = options

  const trimmedQuery = query?.trim().toLowerCase()

  const filtered = records.filter(record => {
    if (trimmedQuery) {
      const matchName = record.name.toLowerCase().includes(trimmedQuery)
      const matchSession = record.sessionKey ? record.sessionKey.toLowerCase().includes(trimmedQuery) : false
      const matchPath = record.displayPath ? record.displayPath.toLowerCase().includes(trimmedQuery) : false
      if (!matchName && !matchSession && !matchPath) return false
    }

    if (type && type !== 'all') {
      if (typeOf(record.name) !== type) return false
    }

    if (range && range !== 'all') {
      if (range === 'today') {
        const startOfToday = new Date(now).setHours(0, 0, 0, 0)
        if (record.at < startOfToday) return false
      } else if (range === '7d') {
        const threshold = now - 7 * 86400 * 1000
        if (record.at < threshold) return false
      } else if (range === '30d') {
        const threshold = now - 30 * 86400 * 1000
        if (record.at < threshold) return false
      }
    }

    return true
  })

  // "进行中的任务固定排在最前（其次按选择的排序）"
  const isProgress = (r: any) => Boolean(
    r.inProgress || r.phase === 'downloading' || r.status === 'downloading'
  )

  return [...filtered].sort((a, b) => {
    const aProg = isProgress(a) ? 1 : 0
    const bProg = isProgress(b) ? 1 : 0
    if (aProg !== bProg) {
      return bProg - aProg
    }

    switch (sort) {
      case 'time_asc':
        return a.at - b.at
      case 'size_desc':
        return (b.sizeBytes || 0) - (a.sizeBytes || 0)
      case 'name_asc':
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
      case 'time_desc':
      default:
        return b.at - a.at
    }
  })
}
