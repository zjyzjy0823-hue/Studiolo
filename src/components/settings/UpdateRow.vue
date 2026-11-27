<script setup lang="ts">
import { computed } from 'vue'
import { RefreshCw, RotateCw } from 'lucide-vue-next'
import { useUpdater } from '../../composables/useUpdater'

const updater = useUpdater()

const statusText = computed(() => {
  switch (updater.state.value) {
    case 'checking':
      return '正在检查…'
    case 'available':
      return `发现 v${updater.version.value || ''}`
    case 'downloading':
      return `下载中 ${updater.percent.value}%`
    case 'ready':
      return '重启生效'
    case 'up-to-date':
      return '已是最新'
    case 'error':
      return '检查失败'
    case 'idle':
    default:
      return '检查更新'
  }
})

const buttonVariant = computed(() => {
  switch (updater.state.value) {
    case 'available':
    case 'ready':
      return 'btn-primary'
    case 'error':
      return 'btn-danger'
    default:
      return 'btn-ghost'
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
    return '更新已准备好，点击重启生效'
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
    void updater.restart()
  } else {
    // idle, up-to-date, error
    void updater.check({ force: true })
  }
}
</script>

<template>
  <div class="update-row">
    <span>检查更新</span>
    <button
      type="button"
      class="btn btn-sm update-status-btn"
      :class="buttonVariant"
      :disabled="updater.state.value === 'checking' || updater.state.value === 'downloading'"
      :title="buttonTitle"
      @click="handleClick"
    >
      <RotateCw v-if="updater.state.value === 'ready'" :size="13" :stroke-width="2" />
      <RefreshCw
        v-else
        :size="13"
        :stroke-width="2"
        :class="{ 'spin-icon': updater.state.value === 'checking' || updater.state.value === 'downloading' }"
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
.update-status-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: calc(13px * var(--fs));
}
.spin-icon {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
