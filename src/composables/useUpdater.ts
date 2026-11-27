import { ref, type Ref } from 'vue'
import { isTauri } from '@tauri-apps/api/core'
import { check as tauriCheck, type DownloadEvent } from '@tauri-apps/plugin-updater'
import { relaunch as tauriRelaunch } from '@tauri-apps/plugin-process'

export type UpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'up-to-date'
  | 'error'

export interface CheckOptions {
  silent?: boolean
  force?: boolean
}

export interface UpdateBackendResult {
  version: string
  currentVersion?: string
  date?: string
  body?: string
  rawJson?: Record<string, unknown>
  downloadAndInstall(onEvent?: (progress: DownloadEvent) => void): Promise<void>
}

export interface UpdaterBackend {
  isTauri(): boolean
  check(): Promise<UpdateBackendResult | null>
  relaunch(): Promise<void>
}

export interface UseUpdaterReturn {
  state: Ref<UpdateState>
  version: Ref<string | null>
  notes: Ref<string>
  percent: Ref<number>
  error: Ref<string | null>
  contentLength: Ref<number | null>
  check(options?: CheckOptions): Promise<void>
  install(): Promise<void>
  restart(): Promise<void>
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

const CACHE_TTL_MS = 10 * 60 * 1000 // 10 minutes cache

const defaultBackend: UpdaterBackend = {
  isTauri: () => {
    try {
      return isTauri()
    } catch {
      return false
    }
  },
  check: async () => {
    return (await tauriCheck()) as UpdateBackendResult | null
  },
  relaunch: async () => {
    await tauriRelaunch()
  },
}

export function createUpdater(customBackend?: UpdaterBackend): UseUpdaterReturn {
  const backend = customBackend ?? defaultBackend
  const state = ref<UpdateState>('idle')
  const version = ref<string | null>(null)
  const notes = ref<string>('')
  const percent = ref<number>(0)
  const error = ref<string | null>(null)
  const contentLength = ref<number | null>(null)

  let lastCheckedAt = 0
  let currentUpdate: UpdateBackendResult | null = null
  let inFlightCheck: Promise<void> | null = null

  async function check(options: CheckOptions = {}): Promise<void> {
    const { silent = false, force = false } = options

    if (!backend.isTauri()) {
      return
    }

    if (state.value === 'downloading') {
      return
    }

    if (inFlightCheck) {
      return inFlightCheck
    }

    const now = Date.now()
    if (!force && lastCheckedAt > 0 && (now - lastCheckedAt < CACHE_TTL_MS)) {
      if (state.value === 'available' || state.value === 'up-to-date') {
        return
      }
    }

    state.value = 'checking'
    error.value = null

    const checkPromise = (async () => {
      try {
        const update = await backend.check()
        lastCheckedAt = Date.now()

        if (update) {
          currentUpdate = update
          version.value = update.version
          notes.value = update.body || ''
          contentLength.value = null

          if (update.rawJson && typeof update.rawJson === 'object') {
            const raw = update.rawJson as Record<string, unknown>
            if (typeof raw.size === 'number') {
              contentLength.value = raw.size
            } else if (raw.platforms && typeof raw.platforms === 'object') {
              const platforms = raw.platforms as Record<string, Record<string, unknown>>
              for (const key of Object.keys(platforms)) {
                const targetObj = platforms[key]
                if (targetObj && typeof targetObj.size === 'number') {
                  contentLength.value = targetObj.size
                  break
                }
              }
            }
          }
          state.value = 'available'
        } else {
          currentUpdate = null
          state.value = 'up-to-date'
        }
      } catch (err) {
        state.value = 'error'
        const msg = err instanceof Error ? err.message : String(err)
        error.value = msg
        if (silent) {
          console.debug('[updater] Silent update check failed:', err)
        } else {
          console.error('[updater] Update check failed:', err)
        }
      } finally {
        inFlightCheck = null
      }
    })()

    inFlightCheck = checkPromise
    return checkPromise
  }

  async function install(): Promise<void> {
    if (!backend.isTauri()) {
      return
    }

    if (!currentUpdate) {
      await check({ force: true })
      if (!currentUpdate) {
        return
      }
    }

    state.value = 'downloading'
    percent.value = 0
    error.value = null

    try {
      let totalBytes = contentLength.value ?? 0
      let downloadedBytes = 0

      await currentUpdate.downloadAndInstall((event: DownloadEvent) => {
        if (event.event === 'Started') {
          if (event.data.contentLength) {
            totalBytes = event.data.contentLength
            contentLength.value = totalBytes
          }
        } else if (event.event === 'Progress') {
          downloadedBytes += event.data.chunkLength
          if (totalBytes > 0) {
            percent.value = Math.min(100, Math.round((downloadedBytes / totalBytes) * 100))
          }
        } else if (event.event === 'Finished') {
          percent.value = 100
        }
      })

      state.value = 'ready'
    } catch (err) {
      state.value = 'error'
      const msg = err instanceof Error ? err.message : String(err)
      error.value = msg
      console.error('[updater] Download/install failed:', err)
    }
  }

  async function restart(): Promise<void> {
    if (!backend.isTauri()) {
      return
    }

    try {
      await backend.relaunch()
    } catch (err) {
      state.value = 'error'
      const msg = err instanceof Error ? err.message : String(err)
      error.value = msg
      console.error('[updater] Relaunch failed:', err)
    }
  }

  return {
    state,
    version,
    notes,
    percent,
    error,
    contentLength,
    check,
    install,
    restart,
  }
}

// Global singleton instance for shared state across components
let globalUpdater: UseUpdaterReturn | null = null
let startupCheckTriggered = false

export function useUpdater(customBackend?: UpdaterBackend): UseUpdaterReturn {
  if (customBackend) {
    return createUpdater(customBackend)
  }

  if (!globalUpdater) {
    globalUpdater = createUpdater()
  }

  if (!startupCheckTriggered && defaultBackend.isTauri()) {
    startupCheckTriggered = true
    setTimeout(() => {
      void globalUpdater?.check({ silent: true })
    }, 8000)
  }

  return globalUpdater
}
