/**
 * Studiolo Fleet 控制面 HTTP 与 WebSocket URL 服务。
 */

import { apiRequest, apiResponse, ApiError } from '../api/client'
import { blobResult, externalResultFromPayload, isJsonContentType, type HermesMediaResult } from './hermesMedia'
import type { AgentNode, NodePlatform, NodeTokenOut } from '../types/fleet'

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

export type { HermesMediaResult }

export async function fetchHermesMedia(
  token: string,
  origin: string,
  scope: { nodeId: string; sessionId: string; reference: string; purpose: 'preview' | 'download' },
  signal?: AbortSignal,
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
    return blobResult(await response.blob(), sizeBytes)
  }
  try {
    return await redeem()
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 410) throw error
    return redeem()
  }
}
