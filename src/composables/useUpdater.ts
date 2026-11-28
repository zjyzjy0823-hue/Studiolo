import { ref, type Ref } from 'vue'
import { invoke as tauriInvoke, isTauri } from '@tauri-apps/api/core'
import { check as tauriCheck, type DownloadEvent } from '@tauri-apps/plugin-updater'
import { relaunch as tauriRelaunch } from '@tauri-apps/plugin-process'
import { desktopPlatform } from '../desktop/platform.ts'

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
  size?: number
  url?: string
  downloadAndInstall?(onEvent?: (progress: DownloadEvent) => void): Promise<void>
}

export interface AndroidFeedManifest {
  version: string
  url: string
  size: number
  sha256?: string
  notes?: string
}

export interface UpdaterBackend {
  isTauri(): boolean
  platform?: 'desktop' | 'android'
  currentVersion?: string | (() => Promise<string> | string)
  check?(): Promise<UpdateBackendResult | null>
  relaunch?(): Promise<void>
  fetch?: typeof fetch
  invoke?<T>(cmd: string, args?: Record<string, unknown>): Promise<T>
}

export interface UseUpdaterReturn {
  state: Ref<UpdateState>
  version: Ref<string | null>
  notes: Ref<string>
  percent: Ref<number>
  error: Ref<string | null>
  contentLength: Ref<number | null>
  url: Ref<string | null>
  check(options?: CheckOptions): Promise<void>
  install(): Promise<void>
  restart(): Promise<void>
}

export const ANDROID_FEED_URL = 'https://updates.isidel.com/android.json'
export const ANDROID_APK_PROXY = 'https://updates.isidel.com/apk'
export const CACHE_TTL_MS = 10 * 60 * 1000 // 10 minutes cache
export const PERIODIC_CHECK_MS = 3 * 60 * 60 * 1000 // 每 3 小时静默检查一次

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export function parseSemverCore(v: string): [number, number, number] {
  const clean = String(v || '').trim().replace(/^v/i, '').split(/[-+]/)[0]
  const parts = clean.split('.').map(n => parseInt(n, 10) || 0)
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]
}

export function compareSemver(a: string, b: string): number {
  const [majA, minA, patchA] = parseSemverCore(a)
  const [majB, minB, patchB] = parseSemverCore(b)
  if (majA !== majB) return majA > majB ? 1 : -1
  if (minA !== minB) return minA > minB ? 1 : -1
  if (patchA !== patchB) return patchA > patchB ? 1 : -1
  return 0
}

export function isNewerVersion(remote: string, current: string): boolean {
  return compareSemver(remote, current) > 0
}

async function resolveCurrentVersion(backend: UpdaterBackend): Promise<string> {
  if (typeof backend.currentVersion === 'function') {
    return await backend.currentVersion()
  }
  if (typeof backend.currentVersion === 'string') {
    return backend.currentVersion
  }
  try {
    const { getVersion } = await import('@tauri-apps/api/app')
    return await getVersion()
  } catch {
    return '0.9.13'
  }
}

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
  const url = ref<string | null>(null)

  let lastCheckedAt = 0
  let currentUpdate: UpdateBackendResult | null = null
  let inFlightCheck: Promise<void> | null = null

  function isAndroidPlatform(): boolean {
    if (backend.platform) {
      return backend.platform === 'android'
    }
    if (desktopPlatform() === 'android') {
      return true
    }
    // 平台探测在 Tauri 注入前执行时会停在 'web'，用 UA 兜底
    return typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent)
  }

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
        let update: UpdateBackendResult | null = null

        if (isAndroidPlatform()) {
          // 默认后端（tauri-plugin-updater）不支持 Android，只有显式传入 platform 的自定义后端才用它
          if (backend.check && backend.platform) {
            update = await backend.check()
          } else {
            const invokeFn = backend.invoke ?? tauriInvoke
            const sep = ANDROID_FEED_URL.includes('?') ? '&' : '?'
            const feedUrl = `${ANDROID_FEED_URL}${sep}cb=${Date.now()}`
            // WebView 里直接 fetch 第三方域会被 CORS/重定向拦住，Android 上交给原生 HTTP
            let raw: string | { text?: string }
            try {
              raw = await invokeFn<string | { text?: string }>('android_fetch_text', { url: feedUrl })
            } catch (err) {
              const detail = err instanceof Error ? err.message : String(err)
              throw new Error(`无法检查更新 (${detail})`)
            }
            const text = typeof raw === 'string' ? raw : String(raw?.text ?? '')
            const manifest = JSON.parse(text) as AndroidFeedManifest
            const currentVer = await resolveCurrentVersion(backend)
            if (isNewerVersion(manifest.version, currentVer)) {
              update = {
                version: manifest.version,
                currentVersion: currentVer,
                body: manifest.notes || '',
                size: manifest.size,
                url: manifest.url,
                rawJson: {
                  size: manifest.size,
                  url: manifest.url,
                  sha256: manifest.sha256,
                },
              }
            } else {
              update = null
            }
          }
        } else {
          update = backend.check ? await backend.check() : await defaultBackend.check!()
        }

        lastCheckedAt = Date.now()

        if (update) {
          currentUpdate = update
          version.value = update.version
          notes.value = update.body || ''
          url.value = update.url || (typeof update.rawJson?.url === 'string' ? update.rawJson.url : null)
          contentLength.value = update.size ?? null

          if (contentLength.value === null && update.rawJson && typeof update.rawJson === 'object') {
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
          url.value = null
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

    if (isAndroidPlatform()) {
      try {
        // Android 固定走代理，manifest.url 不参与下载
        const downloadUrl = ANDROID_APK_PROXY
        if (!downloadUrl) {
          throw new Error('未找到更新下载地址')
        }

        const fetchFn = backend.fetch ?? globalThis.fetch
        const invokeFn = backend.invoke ?? tauriInvoke

        const res = await fetchFn(downloadUrl)
        if (!res.ok) {
          throw new Error(`下载更新失败 (HTTP ${res.status})`)
        }

        const contentLengthHeader = res.headers?.get?.('content-length')
        const total = (contentLengthHeader ? parseInt(contentLengthHeader, 10) : 0) || currentUpdate.size || contentLength.value || 0
        if (total > 0) {
          contentLength.value = total
        }

        const chunks: Uint8Array[] = []
        let loaded = 0

        const reader = res.body?.getReader?.()
        if (reader) {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            if (value) {
              chunks.push(value)
              loaded += value.length
              if (total > 0) {
                percent.value = Math.min(100, Math.round((loaded / total) * 100))
              }
            }
          }
        } else if (typeof res.arrayBuffer === 'function') {
          const buf = await res.arrayBuffer()
          const u8 = new Uint8Array(buf)
          chunks.push(u8)
          loaded = u8.length
        }

        percent.value = 100

        const fullBytes = new Uint8Array(loaded)
        let offset = 0
        for (const chunk of chunks) {
          fullBytes.set(chunk, offset)
          offset += chunk.length
        }

        // 更新包完整性校验：manifest 带 sha256 时必须匹配，否则不落盘、不拉起安装器
        const expectedSha = typeof currentUpdate.rawJson?.sha256 === 'string'
          ? (currentUpdate.rawJson.sha256 as string).trim().toLowerCase()
          : ''
        if (expectedSha) {
          let actualSha = ''
          try {
            const digest = await crypto.subtle.digest('SHA-256', fullBytes)
            actualSha = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
          } catch {
            actualSha = ''
          }
          if (actualSha !== expectedSha) {
            state.value = 'error'
            error.value = '更新包校验失败，请重试'
            return
          }
        }

        // Chunked Base64 (0x8000 bytes per chunk)
        let binary = ''
        const chunkSize = 0x8000
        for (let i = 0; i < fullBytes.length; i += chunkSize) {
          binary += String.fromCharCode(...fullBytes.subarray(i, i + chunkSize))
        }
        const base64 = btoa(binary)

        let filename = 'studiolo-update.apk'
        try {
          const parts = downloadUrl.split('/')
          const last = parts[parts.length - 1].split('?')[0]
          if (last.endsWith('.apk')) {
            filename = last
          } else if (currentUpdate.version) {
            filename = `Studiolo_${currentUpdate.version}_arm64-release.apk`
          }
        } catch {
          // fallback
        }

        const saveResult = await invokeFn<{ saved?: boolean; displayPath?: string; display_path?: string }>(
          'android_save_attachment',
          { name: filename, base64 }
        )

        const displayPath = (saveResult && typeof saveResult === 'object')
          ? (saveResult.displayPath || saveResult.display_path)
          : undefined

        await invokeFn<boolean>('android_open_download', {
          name: filename,
          displayPath,
        })

        state.value = 'ready'
      } catch (err: unknown) {
        state.value = 'error'
        const errCode = (err && typeof err === 'object' && 'code' in err) ? String((err as any).code) : ''
        const errMsg = err instanceof Error ? err.message : String(err || '')

        if (errCode === 'install_permission' || errMsg.includes('install_permission') || errMsg.includes('需要允许本应用安装应用')) {
          error.value = '需要允许本应用安装应用'
        } else {
          error.value = errMsg || '下载或安装失败'
        }
        console.error('[updater] Android download/install failed:', err)
      }
      return
    }

    try {
      let totalBytes = contentLength.value ?? 0
      let downloadedBytes = 0

      await currentUpdate.downloadAndInstall?.((event: DownloadEvent) => {
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
      if (isAndroidPlatform()) {
        await install()
        return
      }
      await (backend.relaunch ? backend.relaunch() : defaultBackend.relaunch!())
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
    url,
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
    // 启动后 8 秒查一次
    setTimeout(() => {
      void globalUpdater?.check({ silent: true })
    }, 8000)
    // 之后每 3 小时查一次（force 穿透 10 分钟缓存）
    setInterval(() => {
      void globalUpdater?.check({ silent: true, force: true })
    }, PERIODIC_CHECK_MS)
  }

  return globalUpdater
}
