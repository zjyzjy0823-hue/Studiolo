import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createUpdater,
  compareSemver,
  isNewerVersion,
  ANDROID_FEED_URL,
} from '../src/composables/useUpdater.ts'
import { generateAndroidManifest } from '../scripts/make-latest-json.mjs'

/** Android 上读 feed 走原生 HTTP（android_fetch_text），测试里用 invoke 模拟 */
function feedInvoke(manifest) {
  return async (command, args) => {
    assert.equal(command, 'android_fetch_text')
    assert.ok(String(args?.url).startsWith(ANDROID_FEED_URL))
    return { text: JSON.stringify(manifest) }
  }
}

function apkFetch(bytes) {
  return async (url) => {
    assert.ok(String(url).endsWith('.apk') || String(url).includes('/apk'), `unexpected apk url ${url}`)
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': String(bytes.length) }),
      body: {
        getReader() {
          let delivered = false
          return {
            async read() {
              if (delivered) return { done: true, value: undefined }
              delivered = true
              return { done: false, value: bytes }
            },
          }
        },
      },
      arrayBuffer: async () => bytes.buffer,
    }
  }
}

test('1. 远端 0.9.14 > 本地 0.9.13 → available，带 size/url', async () => {
  const mockManifest = {
    version: '0.9.14',
    url: 'https://alist.isidel.com/p/dl/Studiolo_0.9.14_arm64-release.apk',
    size: 22378187,
    notes: '下载页 + 更新入口打磨',
    sha256: '92d83626789428004b2dc302e54ebfc997c4e2363a31dafffb8059f67c9ad903',
  }

  const updater = createUpdater({
    platform: 'android',
    isTauri: () => true,
    currentVersion: '0.9.13',
    invoke: feedInvoke(mockManifest),
  })

  await updater.check({ force: true })

  assert.equal(updater.state.value, 'available')
  assert.equal(updater.version.value, '0.9.14')
  assert.equal(updater.contentLength.value, 22378187)
  assert.equal(updater.url.value, 'https://alist.isidel.com/p/dl/Studiolo_0.9.14_arm64-release.apk')
  assert.equal(updater.notes.value, '下载页 + 更新入口打磨')
})

test('2. 远端等于本地 → up-to-date', async () => {
  const updater = createUpdater({
    platform: 'android',
    isTauri: () => true,
    currentVersion: '0.9.13',
    invoke: feedInvoke({ version: '0.9.13', url: 'https://alist.isidel.com/p/dl/x.apk', size: 1 }),
  })

  await updater.check({ force: true })

  assert.equal(updater.state.value, 'up-to-date')
  assert.equal(updater.version.value, null)
})

test('3. android.json 拉取失败 → error，文案含「无法检查更新」', async () => {
  const updater = createUpdater({
    platform: 'android',
    isTauri: () => true,
    currentVersion: '0.9.13',
    invoke: async () => {
      throw new Error('HTTP 404')
    },
  })

  await updater.check({ force: true, silent: true })

  assert.equal(updater.state.value, 'error')
  assert.ok(
    updater.error.value?.includes('无法检查更新'),
    `Expected error message to include '无法检查更新', got '${updater.error.value}'`
  )
})

test('4. install() 串行调用 android_save_attachment → android_open_download', async () => {
  const calls = []
  const apkBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x08, 0x00])
  const manifest = {
    version: '0.9.14',
    url: 'https://alist.isidel.com/p/dl/Studiolo_0.9.14_arm64-release.apk',
    size: apkBytes.length,
    notes: '修复更新',
  }

  const mockInvoke = async (command, args) => {
    calls.push({ command, args })
    if (command === 'android_fetch_text') {
      return { text: JSON.stringify(manifest) }
    }
    if (command === 'android_save_attachment') {
      return { saved: true, displayPath: '/storage/emulated/0/Download/Studiolo/Studiolo_0.9.14_arm64-release.apk' }
    }
    if (command === 'android_open_download') {
      return true
    }
    throw new Error(`Unexpected command: ${command}`)
  }

  const updater = createUpdater({
    platform: 'android',
    isTauri: () => true,
    currentVersion: '0.9.13',
    fetch: apkFetch(apkBytes),
    invoke: mockInvoke,
  })

  await updater.check({ force: true })
  assert.equal(updater.state.value, 'available')

  await updater.install()

  const commands = calls.map(call => call.command)
  assert.deepEqual(commands, ['android_fetch_text', 'android_save_attachment', 'android_open_download'])

  const save = calls[1]
  assert.equal(save.args.name, 'Studiolo_0.9.14_arm64-release.apk')
  assert.ok(typeof save.args.base64 === 'string' && save.args.base64.length > 0)

  const open = calls[2]
  assert.equal(open.args.name, 'Studiolo_0.9.14_arm64-release.apk')
  assert.equal(open.args.displayPath, '/storage/emulated/0/Download/Studiolo/Studiolo_0.9.14_arm64-release.apk')

  assert.equal(updater.state.value, 'ready')
  assert.equal(updater.percent.value, 100)
})

test('5. install_permission 错误 → 状态文案为「需要允许本应用安装应用」', async () => {
  const apkBytes = new Uint8Array([1, 2, 3, 4])
  const manifest = {
    version: '0.9.14',
    url: 'https://alist.isidel.com/p/dl/Studiolo_0.9.14_arm64-release.apk',
    size: apkBytes.length,
    notes: '测试权限',
  }

  const mockInvoke = async (command) => {
    if (command === 'android_fetch_text') {
      return { text: JSON.stringify(manifest) }
    }
    if (command === 'android_save_attachment') {
      return { saved: true, displayPath: '/storage/emulated/0/Download/Studiolo/app.apk' }
    }
    if (command === 'android_open_download') {
      const err = new Error('需要允许本应用安装应用（系统设置 → 安装未知应用）')
      err.code = 'install_permission'
      throw err
    }
    throw new Error(`Unexpected command: ${command}`)
  }

  const updater = createUpdater({
    platform: 'android',
    isTauri: () => true,
    currentVersion: '0.9.13',
    fetch: apkFetch(apkBytes),
    invoke: mockInvoke,
  })

  await updater.check({ force: true })
  await updater.install()

  assert.equal(updater.state.value, 'error')
  assert.equal(updater.error.value, '需要允许本应用安装应用')
})

test('6. 版本比较函数：0.9.13 vs 0.9.9、0.10.0 vs 0.9.13、0.9.13 vs 0.9.13-rc1', () => {
  assert.equal(compareSemver('0.9.13', '0.9.9'), 1)
  assert.equal(compareSemver('0.9.9', '0.9.13'), -1)
  assert.equal(isNewerVersion('0.9.13', '0.9.9'), true)
  assert.equal(isNewerVersion('0.9.9', '0.9.13'), false)

  assert.equal(compareSemver('0.10.0', '0.9.13'), 1)
  assert.equal(compareSemver('0.9.13', '0.10.0'), -1)
  assert.equal(isNewerVersion('0.10.0', '0.9.13'), true)
  assert.equal(isNewerVersion('0.9.13', '0.10.0'), false)

  assert.equal(compareSemver('0.9.13', '0.9.13-rc1'), 0)
  assert.equal(compareSemver('0.9.13-rc1', '0.9.13'), 0)
  assert.equal(isNewerVersion('0.9.13', '0.9.13-rc1'), false)
  assert.equal(isNewerVersion('0.9.13-rc1', '0.9.13'), false)
})

test('7. scripts/make-latest-json.mjs 生成 android.json 格式结构', () => {
  const manifest = generateAndroidManifest({
    version: '0.9.13',
    releaseDir: 'dist-release',
    baseUrl: 'https://github.com/zjyzjy0823-hue/Studiolo/releases/download/v0.9.13',
    notes: '下载页 + 更新入口打磨',
  })

  assert.ok(manifest)
  assert.equal(manifest.version, '0.9.13')
  assert.equal(
    manifest.url,
    'https://github.com/zjyzjy0823-hue/Studiolo/releases/download/v0.9.13/Studiolo_0.9.13_arm64-release.apk'
  )
  assert.equal(manifest.size, 22378187)
  assert.ok(manifest.sha256?.startsWith('92d8'))
  assert.equal(manifest.notes, '下载页 + 更新入口打磨')
})
