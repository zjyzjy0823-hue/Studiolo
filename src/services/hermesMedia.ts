export type HermesMediaResult =
  | { kind: 'blob'; blob: Blob }
  | { kind: 'external'; url: string; fileName?: string; sizeBytes?: number }

/** 服务端在 JSON 模式下返回外链；二进制响应仍是中继字节流。 */
export function isJsonContentType(value: string | null): boolean {
  return (value || '').toLowerCase().includes('application/json')
}

export function externalResultFromPayload(payload: unknown, fallbackSizeBytes?: number): HermesMediaResult {
  const data = (payload ?? {}) as { url?: unknown; fileName?: unknown; sizeBytes?: unknown }
  if (typeof data.url !== 'string' || !data.url) throw new Error('服务端未返回下载地址，请重试')
  return {
    kind: 'external',
    url: data.url,
    fileName: typeof data.fileName === 'string' ? data.fileName : undefined,
    sizeBytes: typeof data.sizeBytes === 'number' ? data.sizeBytes : fallbackSizeBytes,
  }
}

export function blobResult(blob: Blob, expectedSizeBytes: number): HermesMediaResult {
  if (!blob.size || blob.size !== expectedSizeBytes) throw new Error('附件字节不完整，请重试')
  return { kind: 'blob', blob }
}
