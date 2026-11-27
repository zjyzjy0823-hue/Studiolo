import test from 'node:test'
import assert from 'node:assert/strict'
import { createUpdater, formatBytes } from '../src/composables/useUpdater.ts'

test('1. 初始状态为 idle，默认版本为空', () => {
  const updater = createUpdater({
    isTauri: () => true,
    check: async () => null,
    relaunch: async () => {},
  })

  assert.equal(updater.state.value, 'idle')
  assert.equal(updater.version.value, null)
  assert.equal(updater.notes.value, '')
  assert.equal(updater.percent.value, 0)
  assert.equal(updater.error.value, null)
})

test('2. 非 Tauri 环境跳过检查，保持 idle', async () => {
  let backendCheckCalled = false
  const updater = createUpdater({
    isTauri: () => false,
    check: async () => {
      backendCheckCalled = true
      return null
    },
    relaunch: async () => {},
  })

  await updater.check()
  assert.equal(backendCheckCalled, false)
  assert.equal(updater.state.value, 'idle')
})

test('3. 检查无可用更新时流转到 up-to-date', async () => {
  const updater = createUpdater({
    isTauri: () => true,
    check: async () => null,
    relaunch: async () => {},
  })

  await updater.check()
  assert.equal(updater.state.value, 'up-to-date')
  assert.equal(updater.version.value, null)
})

test('4. 检查发现可用更新时流转到 available 并解析版本/说明/大小', async () => {
  const updater = createUpdater({
    isTauri: () => true,
    check: async () => ({
      version: '0.9.11',
      body: '修复若干问题\n提升稳定性\n优化桌面体验\n第四行说明',
      rawJson: {
        size: 25 * 1024 * 1024,
      },
      downloadAndInstall: async () => {},
    }),
    relaunch: async () => {},
  })

  await updater.check()
  assert.equal(updater.state.value, 'available')
  assert.equal(updater.version.value, '0.9.11')
  assert.equal(updater.notes.value.includes('修复若干问题'), true)
  assert.equal(updater.contentLength.value, 26214400)
})

test('5. 检查失败时流转到 error，silent 模式不抛异常', async () => {
  const updater = createUpdater({
    isTauri: () => true,
    check: async () => {
      throw new Error('网络连接超时')
    },
    relaunch: async () => {},
  })

  await updater.check({ silent: true })
  assert.equal(updater.state.value, 'error')
  assert.equal(updater.error.value, '网络连接超时')
})

test('6. 检查结果 10 分钟缓存与 force 强制穿透', async () => {
  let checkCount = 0
  const updater = createUpdater({
    isTauri: () => true,
    check: async () => {
      checkCount++
      return null
    },
    relaunch: async () => {},
  })

  await updater.check()
  assert.equal(checkCount, 1)
  assert.equal(updater.state.value, 'up-to-date')

  // 10 分钟内再次检查，命中缓存，不触发网络调用
  await updater.check()
  assert.equal(checkCount, 1)

  // force: true 强制绕过缓存
  await updater.check({ force: true })
  assert.equal(checkCount, 2)
})

test('7. 下载与安装完整状态机：available -> downloading (0%..100%) -> ready', async () => {
  let progressCallback = null
  const updater = createUpdater({
    isTauri: () => true,
    check: async () => ({
      version: '0.9.12',
      body: '新版特性',
      downloadAndInstall: async (onEvent) => {
        progressCallback = onEvent
        onEvent?.({ event: 'Started', data: { contentLength: 1000 } })
        onEvent?.({ event: 'Progress', data: { chunkLength: 300 } })
        onEvent?.({ event: 'Progress', data: { chunkLength: 700 } })
        onEvent?.({ event: 'Finished' })
      },
    }),
    relaunch: async () => {},
  })

  await updater.check()
  assert.equal(updater.state.value, 'available')

  await updater.install()
  assert.equal(updater.state.value, 'ready')
  assert.equal(updater.percent.value, 100)
  assert.equal(updater.contentLength.value, 1000)
})

test('8. 重启调用 relaunch', async () => {
  let relaunchCalled = false
  const updater = createUpdater({
    isTauri: () => true,
    check: async () => null,
    relaunch: async () => {
      relaunchCalled = true
    },
  })

  await updater.restart()
  assert.equal(relaunchCalled, true)
})

test('9. formatBytes 格式化', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(500), '500 B')
  assert.equal(formatBytes(2048), '2.0 KB')
  assert.equal(formatBytes(15 * 1024 * 1024), '15.00 MB')
  assert.equal(formatBytes(2 * 1024 * 1024 * 1024), '2.00 GB')
})
