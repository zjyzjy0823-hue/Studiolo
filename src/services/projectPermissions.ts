import type { ChatPermissionMode, ProjectPermission } from '../types/fleet'

export function projectPathKey(path: string) {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
  return /^[a-z]:|^\/\//i.test(normalized) ? normalized.toLowerCase() : normalized
}

export function findProjectPermission(permissions: readonly ProjectPermission[], directory: string) {
  if (!directory) return undefined
  const cwd = projectPathKey(directory)
  let nearest: ProjectPermission | undefined
  let longest = -1
  for (const rule of permissions) {
    const root = projectPathKey(rule.cwd)
    if (root.length > longest && (cwd === root || cwd.startsWith(root.endsWith('/') ? root : root + '/'))) {
      nearest = rule
      longest = root.length
    }
  }
  return nearest
}

export function supportsChatPermission(mode: ChatPermissionMode, capabilities: readonly string[]) {
  if (mode === 'read') return capabilities.includes('read-only')
  if (mode === 'deny') return capabilities.includes('deny-requests')
  return true
}
