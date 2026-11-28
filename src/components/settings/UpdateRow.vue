<script setup lang="ts">
import { computed } from 'vue'
import { AlertCircle, RefreshCw, RotateCw } from 'lucide-vue-next'
import { useUpdater, formatBytes } from '../../composables/useUpdater'
import { isAndroidLocal } from '../../desktop/androidLocal'
import { desktopPlatform } from '../../desktop/platform'

const updater = useUpdater()
const isAndroid = computed(() => isAndroidLocal() || desktopPlatform() === 'android'
  || (typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent)))

const formattedSize = computed(() => {
  if (typeof updater.contentLength.value === 'number' && updater.contentLength.value > 0) {
    return formatBytes(updater.contentLength.value)
  }
  return null
})

const statusText = computed(() => {
  switch (updater.state.value) {
    case 'checking':
      return '正在检查…'
    case 'available':
      if (isAndroid.value) {
        return '下载并安装'
      }
      return `发现 v${updater.version.value || ''}`
    case 'downloading':
      return `下载中 ${updater.percent.value}%`
    case 'ready':
      if (isAndroid.value) {
        return '正在打开安装器…'
      }
      return '重启生效'
    case 'up-to-date':
      return '已是最新'
    case 'error':
      if (updater.error.value === '需要允许本应用安装应用') {
        return '需要允许本应用安装应用'
      }
      return updater.error.value ? `检查失败：${updater.error.value}` : '检查失败'
    case 'idle':
    default:
      return '检查更新'
  }
})

const buttonTitle = computed(() => {
  if (updater.state.value === 'error' && updater.error.value) {
    return `失败原因: ${updater.error.value}，点击重试`
  }
  if (updater.state.value === 'available') {
    return '发现新版本，点击下载并安装'
  }
  if (updater.state.value === 'ready') {
    return isAndroid.value ? '安装包已保存，请在系统安装界面完成' : '更新已准备好，点击重启生效'
  }
  return statusText.value
})

function handleClick() {
  const s = updater.state.value
  if (s === 'checking' || s === 'downloading') {
    return
  }
  if (s === 'available') {
    void updater.install()
  } else if (s === 'ready') {
    // 桌面：重启生效；Android：安装器已拉起，重复点击不再重新下载
    if (!isAndroid.value) {
      void updater.restart()
    }
  } else {
    // idle, up-to-date, error
    void updater.check({ force: true })
  }
}
</script>

<template>
  <div class="update-row">
    <div class="update-label-area">
      <span v-if="!isAndroid || updater.state.value !== 'available'">检查更新</span>
      <span v-else class="update-android-available">
        v{{ updater.version.value }}{{ formattedSize ? ` · ${formattedSize}` : '' }}
      </span>
    </div>
    <button
      type="button"
      class="update-capsule"
      :class="{
        'is-checking': updater.state.value === 'checking',
        'is-available': updater.state.value === 'available',
        'is-downloading': updater.state.value === 'downloading',
        'is-ready': updater.state.value === 'ready',
        'is-error': updater.state.value === 'error',
        'is-up-to-date': updater.state.value === 'up-to-date',
      }"
      :disabled="updater.state.value === 'checking' || updater.state.value === 'downloading'"
      :title="buttonTitle"
      @click="handleClick"
    >
      <RotateCw v-if="updater.state.value === 'ready' && !isAndroid" :size="13" :stroke-width="2" />
      <AlertCircle v-else-if="updater.state.value === 'error'" :size="13" :stroke-width="2" />
      <RefreshCw
        v-else
        :size="13"
        :stroke-width="2"
        :class="{ 'spin-icon': updater.state.value === 'checking' || updater.state.value === 'downloading' || (isAndroid && updater.state.value === 'ready') }"
      />
      <span>{{ statusText }}</span>
    </button>
  </div>
</template>

<style scoped>
.update-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 50px;
  padding: 0 16px;
  font-size: calc(15px * var(--fs));
}
.update-label-area {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.update-android-available {
  font-weight: 600;
  color: var(--text);
  font-family: var(--font-mono, monospace);
  font-size: calc(14px * var(--fs));
  letter-spacing: -0.01em;
}
.update-capsule {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  background: var(--surface-2);
  border: 1px solid var(--line);
  color: var(--text-2);
  font-size: calc(13px * var(--fs));
  font-weight: 500;
  cursor: pointer;
  outline: none;
  box-sizing: border-box;
  transition: background 150ms ease, color 150ms ease, border-color 150ms ease, transform 100ms ease;
  white-space: nowrap;
}
.update-capsule:hover:not(:disabled) {
  background: var(--surface-3);
  color: var(--text);
}
.update-capsule:active:not(:disabled) {
  transform: scale(0.96);
}
.update-capsule:focus-visible {
  box-shadow: 0 0 0 2px var(--surface), 0 0 0 4px var(--accent);
}
.update-capsule:disabled {
  cursor: default;
  opacity: 0.85;
}
.update-capsule.is-available {
  color: var(--accent);
  background: var(--accent-soft, var(--surface-2));
  border-color: transparent;
  font-weight: 600;
}
.update-capsule.is-ready {
  color: var(--ok, #10b981);
  background: var(--ok-soft, var(--surface-2));
  border-color: transparent;
  font-weight: 600;
}
.update-capsule.is-error {
  color: var(--danger, #ef4444);
  background: var(--danger-soft, var(--surface-2));
  border-color: transparent;
}
.spin-icon {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .spin-icon {
    animation: none !important;
  }
  .update-capsule {
    transition: none !important;
  }
}
:global([data-motion="reduced"]) .spin-icon {
  animation: none !important;
}
:global([data-motion="reduced"]) .update-capsule {
  transition: none !important;
}
</style>
