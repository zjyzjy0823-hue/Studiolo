/**
 * Studiolo Fleet 控制面 HTTP 与 WebSocket URL 服务。
 */

import { apiRequest, apiResponse, ApiError } from '../api/client'
import { blobResult, externalResultFromPayload, isJsonContentType, type HermesMediaResult } from './hermesMedia'
import { shouldReport } from './downloadProgress'
import { mapSessionProcesses, mapSessionSubagents, type SessionActivityResult } from './sessionActivity'
import type { AdapterProvider, AgentNode, NodePlatform, NodeTokenOut } from '../types/fleet'

export { buildFleetWsUrl, getApiBaseUrl } from './fleetUrl'

export const listFleetNodes = (token: string, origin?: string) => apiRequest<AgentNode[]>('/api/v1/fleet/nodes', {}, token, origin)

export const createFleetNode = (
  token: string,
  payload: { name: string; platform: NodePlatform; hostname?: string | null },
  origin?: string,
) =>
  apiRequest<NodeTokenOut>(
    '/api/v1/fleet/nodes',
    { method: 'POST', body: JSON.stringify(payload) },
    token, origin,
  )

export const updateFleetNode = (
  token: string,
  nodeId: string,
  payload: { name?: string; platform?: NodePlatform; hostname?: string | null },
  origin?: string,
) =>
  apiRequest<AgentNode>(
    `/api/v1/fleet/nodes/${nodeId}`,
    { method: 'PATCH', body: JSON.stringify(payload) },
    token, origin,
  )

export const rotateFleetNodeToken = (token: string, nodeId: string, origin?: string) =>
  apiRequest<NodeTokenOut>(`/api/v1/fleet/nodes/${nodeId}/token`, { method: 'POST' }, token, origin)

export const revokeFleetNode = (token: string, nodeId: string, origin?: string) =>
  apiRequest<AgentNode>(`/api/v1/fleet/nodes/${nodeId}/revoke`, { method: 'POST' }, token, origin)

export const deleteFleetNode = (token: string, nodeId: string, origin?: string) =>
  apiRequest<void>(`/api/v1/fleet/nodes/${nodeId}`, { method: 'DELETE' }, token, origin)

type SessionActivityOptions = { token: string; origin: string; provider: AdapterProvider; signal: AbortSignal }

async function fetchSessionActivity<T>(
  nodeId: string,
  sessionKey: string,
  endpoint: 'processes' | 'subagents',
  map: (payload: unknown) => SessionActivityResult<T>,
  { token, origin, provider, signal }: SessionActivityOptions,
): Promise<SessionActivityResult<T>> {
  try {
    const payload = await apiRequest<unknown>(
      `/api/v1/fleet/nodes/${encodeURIComponent(nodeId)}/session/${endpoint}`,
      { method: 'POST', body: JSON.stringify({ session_id: sessionKey, provider }), signal },
      token, origin,
    )
    return map(payload)
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : '暂不可用' }
  }
}

export const fetchSessionProcesses = (nodeId: string, sessionKey: string, options: SessionActivityOptions) =>
  fetchSessionActivity(nodeId, sessionKey, 'processes', mapSessionProcesses, options)

export const fetchSessionSubagents = (nodeId: string, sessionKey: string, options: SessionActivityOptions) =>
  fetchSessionActivity(nodeId, sessionKey, 'subagents', mapSessionSubagents, options)

export type { HermesMediaResult }

export interface MediaProgress {
  loaded: number
  total: number | null
}

async function readWithProgress(
  response: Response,
  onProgress?: (p: MediaProgress) => void,
): Promise<Blob> {
  const lengthHeader = response.headers.get('Content-Length')
  const total = lengthHeader && !isNaN(Number(lengthHeader)) && Number(lengthHeader) > 0
    ? Number(lengthHeader)
    : null

  if (!response.body || typeof response.body.getReader !== 'function') {
    const blob = await response.blob()
    const size = blob.size
    onProgress?.({ loaded: size, total: total ?? size })
    return blob
  }

  const reader = response.body.getReader()
  const chunks: BlobPart[] = []
  let loaded = 0
  let lastReportAt = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value as unknown as BlobPart)
      loaded += value.length
      const now = Date.now()
      if (shouldReport(now, lastReportAt)) {
        lastReportAt = now
        onProgress?.({ loaded, total })
      }
    }
  }

  onProgress?.({ loaded, total: total ?? loaded })

  const contentType = response.headers.get('Content-Type') || ''
  return new Blob(chunks, { type: contentType })
}

export async function fetchHermesMedia(
  token: string,
  origin: string,
  scope: { nodeId: string; sessionId: string; reference: string; purpose: 'preview' | 'download' },
  signal?: AbortSignal,
  onProgress?: (progress: MediaProgress) => void,
): Promise<HermesMediaResult> {
  const base = '/api/v1/fleet/media'
  const post = (body: object) => ({ method: 'POST', body: JSON.stringify(body), signal })
  const redeem = async (): Promise<HermesMediaResult> => {
    const { ticket, sizeBytes } = await apiRequest<{ ticket: string; sizeBytes: number }>(
      `${base}/resolve`, post({ ...scope, provider: 'hermes' }), token, origin,
    )
    // 显式申请 JSON 模式：浏览器里 fetch(redirect:'manual') 只会得到 opaque-redirect，
    // 读不到 Location，所以大文件由服务端直接给出链接。
    const response = await apiResponse(`${base}/redeem`, {
      ...post({ ticket }),
      headers: { 'X-Studiolo-Media-Link': '1' },
    }, token, origin)
    if (isJsonContentType(response.headers.get('Content-Type'))) {
      return externalResultFromPayload(await response.json(), sizeBytes)
    }
    const blob = await readWithProgress(response, onProgress)
    return blobResult(blob, sizeBytes)
  }
  try {
    return await redeem()
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 410) throw error
    return redeem()
  }
}
