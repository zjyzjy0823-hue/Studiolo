/**
 * Studiolo Fleet 控制面 HTTP 与 WebSocket URL 服务。
 */

import { apiRequest, apiResponse, ApiError } from '../api/client'
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

export async function fetchHermesMedia(
  token: string,
  origin: string,
  scope: { nodeId: string; sessionId: string; reference: string; purpose: 'preview' | 'download' },
  signal?: AbortSignal,
): Promise<Blob> {
  const base = '/api/v1/fleet/media'
  const post = (body: object) => ({ method: 'POST', body: JSON.stringify(body), signal })
  const redeem = async () => {
    const { ticket, sizeBytes } = await apiRequest<{ ticket: string; sizeBytes: number }>(
      `${base}/resolve`, post({ ...scope, provider: 'hermes' }), token, origin,
    )
    const response = await apiResponse(`${base}/redeem`, post({ ticket }), token, origin)
    const blob = await response.blob()
    if (!blob.size || blob.size !== sizeBytes) throw new Error('附件字节不完整，请重试')
    return blob
  }
  try {
    return await redeem()
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 410) throw error
    return redeem()
  }
}
