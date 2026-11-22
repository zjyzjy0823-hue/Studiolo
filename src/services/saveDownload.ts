import { androidInvoke, isAndroidLocal } from '../desktop/androidLocal'

export async function saveBlobToDevice(blob: Blob, filename: string): Promise<string> {
  const name = filename.trim() || 'download'
  if (isAndroidLocal()) {
    const bytes = new Uint8Array(await blob.arrayBuffer())
    // Non-final chunks must contain complete Base64 groups so padding only appears at the end.
    const chunkSize = 3 * 8192
    const chunks: string[] = []
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      chunks.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))))
    }
    const result = await androidInvoke<{ saved: boolean; displayPath: string }>(
      'android_save_attachment', { name, base64: chunks.join('') },
    )
    if (result.saved !== true) throw new Error('下载失败')
    return result.displayPath
  }

  const link = document.createElement('a')
  const url = URL.createObjectURL(blob)
  try {
    link.href = url
    link.download = name
    document.body.appendChild(link)
    link.click()
  } finally {
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return name
}
