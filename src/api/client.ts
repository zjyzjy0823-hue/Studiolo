import { getApiBaseUrl } from '../services/fleetUrl'

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

export async function apiResponse(
  path: string, options: RequestInit = {}, token?: string | null, baseUrl = getApiBaseUrl(),
): Promise<Response> {
  let response: Response
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...options,
      ...(baseUrl ? { credentials: 'omit', redirect: 'error' } as const : {}),
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
    })
  } catch {
    throw new ApiError(0, '无法连接到 Studiolo 后端')
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as {
      detail?: string | { message?: string }
      error?: { message?: string }
    }
    const detail = body.detail
    const message = detail && typeof detail === 'object' ? detail.message : undefined
    throw new ApiError(response.status, message || body.error?.message || (typeof detail === 'string' && detail)
      || `请求失败 (${response.status})`)
  }
  return response
}

export async function apiRequest<T>(
  path: string, options: RequestInit = {}, token?: string | null, baseUrl = getApiBaseUrl(),
): Promise<T> {
  const response = await apiResponse(path, options, token, baseUrl)
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}
