export interface CoreSessionRecord {
  origin: string
  token: string
  localToken: string
  workspaceId: string
  coreUrl: string
}

export const CORE_SESSION_STORAGE_KEY = 'studiolo:core-fleet-session'

export interface StorageLike {
  getItem(k: string): string | null
  setItem(k: string, v: string): void
  removeItem(k: string): void
}

export function isCoreSessionRecord(value: unknown): value is CoreSessionRecord {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Record<string, unknown>
  return (
    typeof r.origin === 'string' && r.origin.trim() !== '' &&
    typeof r.token === 'string' && r.token.trim() !== '' &&
    typeof r.localToken === 'string' && r.localToken.trim() !== '' &&
    typeof r.workspaceId === 'string' && r.workspaceId.trim() !== '' &&
    typeof r.coreUrl === 'string' && r.coreUrl.trim() !== ''
  )
}

export function loadCoreSession(
  storage: StorageLike | null = typeof localStorage === 'undefined' ? null : localStorage,
): CoreSessionRecord | null {
  if (!storage) return null
  let raw: string | null = null
  try {
    raw = storage.getItem(CORE_SESSION_STORAGE_KEY)
  } catch {
    return null
  }
  if (!raw) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    clearCoreSession(storage)
    return null
  }

  if (isCoreSessionRecord(parsed)) {
    return parsed
  }

  clearCoreSession(storage)
  return null
}

export function saveCoreSession(
  session: CoreSessionRecord | null,
  storage: StorageLike | null = typeof localStorage === 'undefined' ? null : localStorage,
): void {
  if (!storage) return
  if (!session) {
    clearCoreSession(storage)
    return
  }
  if (!isCoreSessionRecord(session)) return
  try {
    const record: CoreSessionRecord = {
      origin: session.origin,
      token: session.token,
      localToken: session.localToken,
      workspaceId: session.workspaceId,
      coreUrl: session.coreUrl,
    }
    storage.setItem(CORE_SESSION_STORAGE_KEY, JSON.stringify(record))
  } catch {
    // storage 不可用（隐私模式 / setItem 抛错）时静默降级，绝不抛
  }
}

export function clearCoreSession(
  storage: StorageLike | null = typeof localStorage === 'undefined' ? null : localStorage,
): void {
  if (!storage) return
  try {
    storage.removeItem(CORE_SESSION_STORAGE_KEY)
  } catch {
    // storage 不可用时静默降级，绝不抛
  }
}

export function coreSessionMatches(
  session: CoreSessionRecord | null | undefined,
  context: {
    localToken: string | null | undefined
    workspaceId: string | null | undefined
    coreUrl: string | null | undefined
  },
): session is CoreSessionRecord {
  if (!isCoreSessionRecord(session)) return false
  if (!context.localToken || !context.workspaceId || !context.coreUrl) return false
  return (
    session.localToken === context.localToken &&
    session.workspaceId === context.workspaceId &&
    session.coreUrl === context.coreUrl
  )
}
