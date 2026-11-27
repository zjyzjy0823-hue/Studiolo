import { invoke, isTauri } from '@tauri-apps/api/core'
import { androidInvoke, isAndroidLocal, AndroidLocalError } from '../desktop/androidLocal'

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

  if (isTauri()) {
    const bytes = new Uint8Array(await blob.arrayBuffer())
    // 走 base64：IPC 会把 number[] 序列化成 JSON，20MB 文件会膨胀到 ~60MB 文本导致卡死
    let binary = ''
    const chunkSize = 0x8000
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
    }
    const displayPath = await invoke<string>('save_download_file_b64', {
      name,
      base64: btoa(binary),
    })
    return displayPath
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

export async function openSavedDownload(record: { name: string; displayPath?: string }): Promise<void> {
  if (isAndroidLocal()) {
    try {
      await androidInvoke<boolean>('android_open_download', {
        name: record.name,
        displayPath: record.displayPath,
      })
    } catch (error) {
      if (error instanceof AndroidLocalError) {
        if (error.code === 'download_missing') {
          throw new Error('文件已被移动或删除')
        }
        if (error.code === 'no_viewer') {
          throw new Error('没有能打开这种文件的应用')
        }
      }
      const message = error instanceof Error ? error.message : String(error || '')
      if (message.includes('download_missing')) {
        throw new Error('文件已被移动或删除')
      }
      if (message.includes('no_viewer')) {
        throw new Error('没有能打开这种文件的应用')
      }
      throw error instanceof Error ? error : new Error(message || '打开失败')
    }
    return
  }

  if (isTauri()) {
    if (!record.displayPath) {
      throw new Error('文件已被移动或删除')
    }
    try {
      await invoke('open_saved_path', { path: record.displayPath })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || '')
      if (message.includes('path_missing')) {
        throw new Error('文件已被移动或删除')
      }
      throw error instanceof Error ? error : new Error(message || '打开失败')
    }
    return
  }

  throw new Error('仅客户端支持打开已下载文件')
}
