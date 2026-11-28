import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studiolo-apk-'))
  try {
    const fakeContent = Buffer.from('fake-apk-for-manifest-test')
    const apkFileName = 'Studiolo_0.9.13_arm64-release.apk'
    fs.writeFileSync(path.join(tmpDir, apkFileName), fakeContent)
    const expectedSha256 = crypto.createHash('sha256').update(fakeContent).digest('hex')
    const baseUrl = 'https://github.com/zjyzjy0823-hue/Studiolo/releases/download/v0.9.13'

    const manifest = generateAndroidManifest({
      version: '0.9.13',
      releaseDir: tmpDir,
      baseUrl,
      notes: '下载页 + 更新入口打磨',
    })

    assert.ok(manifest)
    assert.equal(manifest.version, '0.9.13')
    assert.equal(manifest.url, `${baseUrl}/${apkFileName}`)
    assert.equal(manifest.size, fakeContent.length)
    assert.equal(manifest.sha256, expectedSha256)
    assert.equal(manifest.notes, '下载页 + 更新入口打磨')
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('8. 同目录同时有 0.9.13 与 0.9.14 两个 APK，请求 0.9.14 -> url/size/sha256 全部是 0.9.14 那份', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studiolo-apk-'))
  try {
    const content13 = Buffer.from('fake-apk-0.9.13-payload')
    const content14 = Buffer.from('fake-apk-0.9.14-payload-different-bytes')
    fs.writeFileSync(path.join(tmpDir, 'Studiolo_0.9.13_arm64-release.apk'), content13)
    fs.writeFileSync(path.join(tmpDir, 'Studiolo_0.9.14_arm64-release.apk'), content14)

    const expectedSha14 = crypto.createHash('sha256').update(content14).digest('hex')
    const baseUrl = 'https://github.com/zjyzjy0823-hue/Studiolo/releases/download/v0.9.14'

    const manifest = generateAndroidManifest({
      version: '0.9.14',
      releaseDir: tmpDir,
      baseUrl,
      notes: '0.9.14 更新说明',
    })

    assert.ok(manifest)
    assert.equal(manifest.version, '0.9.14')
    assert.equal(manifest.url, `${baseUrl}/Studiolo_0.9.14_arm64-release.apk`)
    assert.equal(manifest.size, content14.length)
    assert.equal(manifest.sha256, expectedSha14)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('9. 目录里一个 APK 都没有 -> generateAndroidManifest(...) === null', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studiolo-apk-'))
  try {
    fs.writeFileSync(path.join(tmpDir, 'Studiolo_0.9.14_x64.app.tar.gz.sig'), 'dummy')

    const manifest = generateAndroidManifest({
      version: '0.9.14',
      releaseDir: tmpDir,
      baseUrl: 'https://example.com/releases',
    })

    assert.equal(manifest, null)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('10. 目录里只有 0.9.13，请求 0.9.14 -> assert.throws 且错误文案含 0.9.14', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studiolo-apk-'))
  try {
    fs.writeFileSync(path.join(tmpDir, 'Studiolo_0.9.13_arm64-release.apk'), Buffer.from('old-apk'))

    assert.throws(
      () => {
        generateAndroidManifest({
          version: '0.9.14',
          releaseDir: tmpDir,
          baseUrl: 'https://example.com/releases',
        })
      },
      (err) => {
        assert.ok(err instanceof Error)
        assert.ok(err.message.includes('0.9.14'), `expected error to include '0.9.14', got: ${err.message}`)
        return true
      }
    )
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('11. 更新流：manifest.sha256 与下载字节不一致 -> error，含「校验失败」，未调用 android_save_attachment', async () => {
  const calls = []
  const apkBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xaa, 0xbb, 0xcc, 0xdd])
  const manifest = {
    version: '0.9.14',
    url: 'https://alist.isidel.com/p/dl/Studiolo_0.9.14_arm64-release.apk',
    size: apkBytes.length,
    notes: '测试哈希校验不匹配',
    sha256: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  }

  const mockInvoke = async (command, args) => {
    calls.push({ command, args })
    if (command === 'android_fetch_text') {
      return { text: JSON.stringify(manifest) }
    }
    if (command === 'android_save_attachment') {
      return { saved: true, displayPath: '/storage/emulated/0/Download/Studiolo/app.apk' }
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

  assert.equal(updater.state.value, 'error')
  assert.ok(
    updater.error.value?.includes('校验失败'),
    `expected error message to include '校验失败', got: '${updater.error.value}'`
  )
  const saveCalls = calls.filter(c => c.command === 'android_save_attachment')
  assert.equal(saveCalls.length, 0, 'android_save_attachment should not be called when sha256 mismatch')
  const openCalls = calls.filter(c => c.command === 'android_open_download')
  assert.equal(openCalls.length, 0, 'android_open_download should not be called when sha256 mismatch')
})

test('12. 更新流：manifest.sha256 与下载字节一致 -> 正常走到 android_save_attachment', async () => {
  const calls = []
  const apkBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x11, 0x22, 0x33, 0x44])
  const actualSha256 = crypto.createHash('sha256').update(apkBytes).digest('hex')
  const manifest = {
    version: '0.9.14',
    url: 'https://alist.isidel.com/p/dl/Studiolo_0.9.14_arm64-release.apk',
    size: apkBytes.length,
    notes: '测试哈希校验匹配',
    sha256: actualSha256,
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

  const commands = calls.map(c => c.command)
  assert.deepEqual(commands, ['android_fetch_text', 'android_save_attachment', 'android_open_download'])
  assert.equal(updater.state.value, 'ready')
  assert.equal(updater.error.value, null)
})
