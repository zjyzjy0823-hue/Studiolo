<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { isAndroidLocal } from '../../desktop/androidLocal'
import { decodeBase64Url } from '../../services/blobTransfer'
import type { InlineMediaAttachment } from '../../services/messageSegments'
import { saveBlobToDevice } from '../../services/saveDownload'
import { useFleetStore } from '../../stores/fleet'
import type { ArtifactRef } from '../../types/fleet'
import OpusIcon from '../ui/OpusIcon.vue'
import { formatBytes } from './providerMeta'

const props = defineProps<{
  attachment: InlineMediaAttachment
  compact?: boolean
  sessionKey?: string
  hermesMedia?: boolean
  streaming?: boolean
}>()

const emit = defineEmits<{
  previewImage: [src: string, alt: string, download: () => Promise<void>, handoff?: () => void]
  openFile: [path: string]
  handoff: [artifact: ArtifactRef]
  status: [message: string]
}>()

const fleet = useFleetStore()
const downloading = ref(false)
const previewFailed = ref(false)
const loadingPreview = ref(false)
const imageButton = ref<HTMLButtonElement | null>(null)
const hermesPreviewUrl = ref('')
const mediaError = ref('')
let previewController: AbortController | undefined
const hermesReference = computed(() => props.hermesMedia && !props.attachment.artifact && !props.attachment.url
  ? props.attachment.filePath : undefined)
const opensWorkspaceFile = computed(() => Boolean(props.attachment.filePath && !hermesReference.value))

onMounted(async () => {
  if (props.attachment.artifact && props.attachment.mime.startsWith('image/')) {
    loadingPreview.value = true
    await fleet.ensureArtifactImagePreview(props.attachment.artifact)
    loadingPreview.value = false
  }
})

const effectiveUrl = computed(() => {
  if (hermesPreviewUrl.value) return hermesPreviewUrl.value
  if (props.attachment.url) return props.attachment.url
  if (props.attachment.artifact) {
    return fleet.imagePreviewByArtifactId[props.attachment.artifact.artifactId] || ''
  }
  return ''
})

const isImage = computed(() =>
  props.attachment.mime.startsWith('image/') || effectiveUrl.value.startsWith('data:image/'),
)

const isVideo = computed(() =>
  props.attachment.mime.startsWith('video/') || effectiveUrl.value.startsWith('data:video/'),
)

const isAudio = computed(() =>
  props.attachment.mime.startsWith('audio/') || effectiveUrl.value.startsWith('data:audio/'),
)

const subLabel = computed(() => {
  if (mediaError.value) return mediaError.value
  const parts: string[] = []
  if (props.attachment.sizeBytes && props.attachment.sizeBytes > 0) {
    parts.push(formatBytes(props.attachment.sizeBytes))
  }
  if (props.attachment.artifact) {
    parts.push('AES-256-GCM')
  } else if (props.attachment.mime && props.attachment.mime !== 'application/octet-stream') {
    parts.push(props.attachment.mime)
  } else if (opensWorkspaceFile.value && props.attachment.filePath) {
    parts.push(props.attachment.filePath)
  }
  return parts.join(' · ') || '文件附件'
})

function handleCardClick() {
  if (opensWorkspaceFile.value && props.attachment.filePath) {
    emit('openFile', props.attachment.filePath)
  }
}

async function loadHermesPreview() {
  const key = props.sessionKey
  const reference = hermesReference.value
  if (!reference || !key || previewController || hermesPreviewUrl.value) return
  const controller = new AbortController()
  previewController = controller
  loadingPreview.value = true
  mediaError.value = ''
  try {
    const blob = await fleet.readHermesAttachment(key, reference, 'preview', controller.signal)
    if (!controller.signal.aborted) hermesPreviewUrl.value = URL.createObjectURL(blob)
  } catch (error) {
    if (!controller.signal.aborted) mediaError.value = error instanceof Error ? error.message : '图片预览失败'
  } finally {
    if (previewController === controller) {
      previewController = undefined
      loadingPreview.value = false
    }
  }
}

watch([imageButton, hermesReference, () => props.sessionKey, () => props.attachment.id, () => props.streaming],
  ([button, reference, key, , streaming], _previous, onCleanup) => {
    mediaError.value = ''
    previewFailed.value = false
    let observer: IntersectionObserver | undefined
    onCleanup(() => {
      observer?.disconnect()
      previewController?.abort()
      previewController = undefined
      loadingPreview.value = false
      if (hermesPreviewUrl.value) URL.revokeObjectURL(hermesPreviewUrl.value)
      hermesPreviewUrl.value = ''
    })
    if (!reference || !key || !button || streaming) return
    if (typeof IntersectionObserver === 'undefined') {
      void loadHermesPreview()
    } else {
      observer = new IntersectionObserver(entries => {
        if (!entries.some(entry => entry.isIntersecting)) return
        observer?.disconnect()
        void loadHermesPreview()
      })
      observer.observe(button)
    }
  },
)

async function openImage() {
  const reference = hermesReference.value
  const key = props.sessionKey
  if (reference && !hermesPreviewUrl.value) await loadHermesPreview()
  if (reference !== hermesReference.value || key !== props.sessionKey) return
  const artifact = props.attachment.artifact
  emit(
    'previewImage',
    previewFailed.value ? '' : effectiveUrl.value,
    props.attachment.fileName,
    handleDownload,
    artifact && !props.compact ? () => emit('handoff', artifact) : undefined,
  )
}

async function readDownloadBlob(url: string): Promise<Blob> {
  // Tauri allows these URLs as image sources, but its CSP blocks fetching them.
  const dataUrl = /^data:([^,]*),/i.exec(url)
  if (dataUrl) {
    const metadata = dataUrl[1]
    const payloadStart = dataUrl[0].length
    const fragmentStart = url.indexOf('#', payloadStart)
    const payload = url.slice(payloadStart, fragmentStart === -1 ? undefined : fragmentStart)
    const type = metadata.replace(/;base64$/i, '') || 'text/plain;charset=US-ASCII'
    if (/;base64$/i.test(metadata)) {
      return new Blob([decodeBase64Url(decodeURIComponent(payload))], { type })
    }
    const bytes = new TextEncoder().encode(payload)
    let length = 0
    for (let i = 0; i < bytes.length; i += 1) {
      if (bytes[i] === 0x25 && i + 2 < bytes.length) {
        const hex = String.fromCharCode(bytes[i + 1], bytes[i + 2])
        if (/^[\da-f]{2}$/i.test(hex)) {
          bytes[length++] = Number.parseInt(hex, 16)
          i += 2
          continue
        }
      }
      bytes[length++] = bytes[i]
    }
    return new Blob([bytes.subarray(0, length)], { type })
  }
  const response = await fetch(url)
  if (!response.ok) throw new Error('下载失败')
  return response.blob()
}

async function handleDownload() {
  if (downloading.value) return
  const { artifact, fileName, filePath } = props.attachment
  const reference = hermesReference.value
  const url = effectiveUrl.value
  const android = isAndroidLocal()
  const androidStatus = '已保存到 Download/Studiolo'
  downloading.value = true
  if (reference) mediaError.value = ''
  try {
    if (artifact) {
      await fleet.downloadArtifactToBrowser(artifact)
      emit('status', android ? androidStatus : `已解密下载 ${fileName}`)
    } else if (reference) {
      if (!props.sessionKey) throw new Error('找不到附件所属的 Hermes 会话')
      const blob = await fleet.readHermesAttachment(props.sessionKey, reference, 'download')
      await saveBlobToDevice(blob, fileName)
      emit('status', android ? androidStatus : `正在下载 ${fileName}`)
    } else if (url) {
      const blob = await readDownloadBlob(url).catch(error => {
        if (android || !/^(?:https?:)?\/\//i.test(url)) throw error
        // Preserve browser navigation for external URLs that cannot be fetched (for example, CORS).
        const link = document.createElement('a')
        link.href = url
        link.download = fileName || 'download'
        link.target = '_blank'
        link.rel = 'noopener noreferrer'
        document.body.appendChild(link)
        link.click()
        link.remove()
        return null
      })
      if (blob) await saveBlobToDevice(blob, fileName)
      emit('status', android ? androidStatus : `正在下载 ${fileName}`)
    } else if (filePath) {
      const onSaved = android ? () => emit('status', androidStatus) : undefined
      if (fleet.downloadWorkspaceFile(filePath, props.sessionKey, onSaved)) {
        emit('status', `正在请求节点下载 ${fileName}`)
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '下载失败'
    if (reference) mediaError.value = message
    emit('status', message)
  } finally {
    downloading.value = false
  }
}
</script>

<template>
  <div v-if="isImage" class="inline-att-img-card">
    <button
      ref="imageButton"
      type="button"
      class="inline-att-img-btn"
      :aria-label="`预览图片：${attachment.fileName}`"
      :disabled="loadingPreview && !effectiveUrl"
      @click="openImage"
    >
      <img
        v-if="effectiveUrl && !previewFailed"
        :src="effectiveUrl"
        :alt="attachment.fileName"
        loading="lazy"
        class="inline-att-img"
        @error="previewFailed = true"
      />
      <span v-else class="inline-att-img-placeholder">
        <OpusIcon name="file" />
        {{ loadingPreview ? '正在加载图片…' : mediaError || attachment.fileName }}
      </span>
    </button>
  </div>

  <!-- 2. 内联音视频播放器（参考 hermes-mobile InlineMediaPlayer） -->
  <div v-else-if="(isVideo || isAudio) && effectiveUrl" class="inline-att-media-card">
    <video v-if="isVideo" :src="effectiveUrl" controls preload="metadata" class="inline-att-video" />
    <audio v-else :src="effectiveUrl" controls preload="metadata" class="inline-att-audio" />
    <div class="inline-att-img-bar">
      <span class="inline-att-name" :title="attachment.fileName">{{ attachment.fileName }}</span>
      <button
        type="button"
        class="btn btn-subtle btn-sm inline-att-dl-btn"
        :disabled="downloading"
        @click.stop="handleDownload"
      >
        <OpusIcon name="download" />
        <span>下载</span>
      </button>
    </div>
  </div>

  <!-- 3. 内联文件卡片（参考 hermes-mobile InlineAttachment 文件 Surface 卡片） -->
  <div
    v-else
    class="inline-att-file-card"
    :class="{ 'is-clickable': opensWorkspaceFile }"
    :data-pressable="opensWorkspaceFile ? '' : undefined"
    @click="handleCardClick"
  >
    <div class="inline-att-file-ic">
      <OpusIcon name="file" />
    </div>
    <div class="inline-att-file-copy">
      <div class="inline-att-name" :title="opensWorkspaceFile ? attachment.filePath : attachment.fileName">{{ attachment.fileName }}</div>
      <div class="inline-att-sub">{{ subLabel }}</div>
    </div>
    <button
      v-if="opensWorkspaceFile && attachment.filePath"
      type="button"
      class="btn btn-subtle btn-sm"
      title="在文件抽屉中预览"
      @click.stop="emit('openFile', attachment.filePath)"
    >预览</button>
    <button
      v-if="attachment.artifact && !compact"
      type="button"
      class="btn btn-subtle btn-sm"
      title="将此加密文件交接给其他节点"
      @click.stop="emit('handoff', attachment.artifact)"
    >@Handoff</button>
    <button
      type="button"
      class="btn btn-ghost btn-sm inline-att-dl-btn"
      :disabled="downloading"
      :title="`下载 ${attachment.fileName}`"
      @click.stop="handleDownload"
    >
      <OpusIcon name="download" />
      <span>{{ downloading ? '下载中' : '下载' }}</span>
    </button>
  </div>
</template>

<style scoped>
.inline-att-img-card,
.inline-att-media-card {
  display: flex;
  flex-direction: column;
  width: fit-content;
  max-width: min(360px, 100%);
  margin: 6px 0;
  border: 1px solid var(--line-strong);
  border-radius: 12px;
  overflow: hidden;
  background: var(--surface-2);
  box-shadow: var(--shadow-1);
}
.inline-att-img-btn {
  position: relative;
  display: block;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: zoom-in;
  line-height: 0;
}
.inline-att-img {
  display: block;
  max-width: 100%;
  max-height: 240px;
  width: auto;
  height: auto;
  object-fit: contain;
}
.inline-att-img-placeholder {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  line-height: 1.4;
  overflow-wrap: anywhere;
  color: var(--text-3);
}
.inline-att-video {
  display: block;
  max-width: 100%;
  max-height: 240px;
  background: #000;
}
.inline-att-audio {
  display: block;
  width: min(320px, 100%);
  margin: 8px 10px 4px;
}
.inline-att-img-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  border-top: 1px solid var(--line);
  background: var(--solid);
  color: var(--text);
}
.inline-att-file-card {
  display: flex;
  align-items: center;
  gap: 10px;
  width: min(380px, 100%);
  margin: 6px 0;
  padding: 9px 12px;
  border: 1px solid var(--line-strong);
  border-radius: 12px;
  background: color-mix(in srgb, var(--surface-2) 85%, var(--solid));
  color: var(--text);
}
.inline-att-file-card.is-clickable {
  cursor: pointer;
}
.inline-att-file-card.is-clickable:hover {
  border-color: var(--accent-line);
}
.inline-att-file-ic {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: var(--accent-soft);
  color: var(--accent);
  flex: none;
}
.inline-att-file-ic .i {
  width: 18px;
  height: 18px;
}
.inline-att-file-copy {
  flex: 1;
  min-width: 0;
  display: grid;
  gap: 2px;
}
.inline-att-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  font-weight: 560;
  color: var(--text);
}
.inline-att-sub {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--text-3);
}
.inline-att-dl-btn {
  flex: none;
  height: 28px;
  padding: 0 9px;
  font-size: 11.5px;
}
</style>
