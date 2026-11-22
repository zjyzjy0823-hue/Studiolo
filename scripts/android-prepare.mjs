import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

function patchBuildTask(source, cli, filename) {
  const cliArgs = /(\blistOf\s*\(\s*)(["'])((?:\\.|(?!\2)[^\\\r\n])*)\2(?=\s*,\s*(["'])android\4\s*,\s*(["'])android-studio-script\5\s*[),])/g
  for (const match of source.matchAll(cliArgs)) {
    const [matched, prefix, , currentCli] = match
    // Node resolves the first argument as a script path.
    if (currentCli === 'tauri') {
      const kotlinEscapes = { '$': '\\$', '\\f': '\\u000c' }
      const kotlinCli = JSON.stringify(cli).replace(/\\.|\$/g, token => kotlinEscapes[token] ?? token)
      return source.slice(0, match.index + prefix.length) + kotlinCli + source.slice(match.index + matched.length)
    }

    const normalizedCli = currentCli.replace(/\\+/g, '/')
    if ((isAbsolute(normalizedCli) || win32.isAbsolute(normalizedCli)) &&
        normalizedCli.endsWith('/node_modules/@tauri-apps/cli/tauri.js')) return source
  }

  const argsStart = Math.max(0, source.search(/\bval\s+args\b/))
  const excerpt = source.slice(Math.max(0, argsStart - 200), argsStart + 200)
  throw new Error(`Unexpected Tauri Android CLI args template in ${filename}\n${excerpt}`)
}

const root = fileURLToPath(new URL('..', import.meta.url))
const tauri = join(root, 'src-tauri')
const config = JSON.parse(await readFile(join(tauri, 'tauri.conf.json'), 'utf8'))
const android = join(tauri, 'gen/android/app/src/main')
const cli = join(root, 'node_modules/@tauri-apps/cli/tauri.js')
// Tauri picks the generated Gradle command from npm_execpath when this script runs via npm.
const initEnv = { ...process.env }
delete initEnv.npm_execpath
const init = spawnSync(process.execPath, [cli, 'android', 'init', '--ci', '--skip-targets-install'], {
  cwd: root,
  stdio: 'inherit',
  env: initEnv,
})
if (init.status !== 0) throw init.error ?? new Error('Tauri Android initialization failed')

const buildTaskDir = join(tauri, 'gen/android/buildSrc/src/main/java')
const buildTaskEntries = await readdir(buildTaskDir, { recursive: true, withFileTypes: true }).catch(error => {
  if (error.code === 'ENOENT') return []
  throw error
})
const buildTask = buildTaskEntries.find(entry => entry.name === 'BuildTask.kt' && entry.isFile())
if (!buildTask) throw new Error(`BuildTask.kt not found under ${buildTaskDir}. The Tauri Android template may have changed.`)

const buildTaskPath = join(buildTask.parentPath, buildTask.name)
const buildTaskSource = await readFile(buildTaskPath, 'utf8')
const patchedBuildTask = patchBuildTask(buildTaskSource, cli, buildTaskPath)
if (patchedBuildTask !== buildTaskSource) await writeFile(buildTaskPath, patchedBuildTask)

const copy = async (file, destination) => {
  await mkdir(dirname(destination), { recursive: true })
  await copyFile(join(tauri, 'android', file), destination)
}

await copy('LocalCorePlugin.kt', join(android, 'java', ...config.identifier.split('.'), 'LocalCorePlugin.kt'))
for (const file of ['AndroidNotifications.kt', 'FleetConnectionService.kt', 'MainActivity.kt']) {
  await copy(file, join(android, 'java', ...config.identifier.split('.'), file))
}
for (const resource of ['studiolo_backup_rules.xml', 'studiolo_data_extraction_rules.xml', 'studiolo_network_security.xml']) {
  await copy(resource, join(android, 'res/xml', resource))
}

const logo = await readFile(join(root, 'public/favicon.svg'), 'utf8')
const mark = logo.match(/<path\b[^>]*\sd="([MmLlHhVvCcSsQqTtAaZz\d\s.,+\-]+)"/)?.[1]
const background = logo.match(/<rect\b[^>]*\sfill="(#[0-9a-f]{6})"/i)?.[1]
if (!mark || !background) throw new Error('Studiolo logo path and background are required')

const androidNamespace = 'http://schemas.android.com/apk/res/android'
const brandColor = '@color/studiolo_brand_background'
const foreground = '@drawable/studiolo_launcher_mark'
const startupMark = '@drawable/studiolo_startup_mark'

function vector(size, markSize, backgroundPath = '') {
  const inset = (size - markSize) / 2
  const scale = markSize / 100
  return `<vector xmlns:android="${androidNamespace}"
    android:width="${size}dp" android:height="${size}dp"
    android:viewportWidth="${size}" android:viewportHeight="${size}">
${backgroundPath}    <group android:translateX="${inset}" android:translateY="${inset}"
        android:scaleX="${scale}" android:scaleY="${scale}">
        <path android:fillColor="#FFFFFF" android:pathData="${mark}" />
    </group>
</vector>`
}

function startingTheme(items) {
  return `<resources>
    <style name="Theme.Studiolo.Starting" parent="Theme.studiolo_desktop">
        <item name="android:statusBarColor">${brandColor}</item>
        <item name="android:navigationBarColor">${brandColor}</item>
        <item name="android:windowLightStatusBar">false</item>
        <item name="android:windowLightNavigationBar">false</item>
${items}
    </style>
</resources>`
}

const resources = {
  'values/studiolo_brand.xml': `<resources><color name="studiolo_brand_background">${background}</color></resources>`,
  'drawable/studiolo_launcher_mark.xml': vector(108, 48),
  'drawable/studiolo_startup_mark.xml': vector(288, 120),
  'drawable/studiolo_notification_icon.xml': vector(24, 16),
  'mipmap-anydpi/studiolo_launcher.xml': vector(128, 72,
    `    <path android:fillColor="${brandColor}" android:strokeColor="#383B44"
        android:strokeWidth="1.5"
        android:pathData="M32 4H96A28 28 0 0 1 124 32V96A28 28 0 0 1 96 124H32A28 28 0 0 1 4 96V32A28 28 0 0 1 32 4Z" />
`),
  'mipmap-anydpi-v26/studiolo_launcher.xml': `<adaptive-icon xmlns:android="${androidNamespace}">
    <background android:drawable="${brandColor}" />
    <foreground android:drawable="${foreground}" />
    <monochrome android:drawable="${foreground}" />
</adaptive-icon>`,
  'drawable/studiolo_starting_window.xml': `<layer-list xmlns:android="${androidNamespace}">
    <item android:drawable="${brandColor}" />
    <item android:drawable="${startupMark}" android:gravity="center" android:width="192dp" android:height="192dp" />
</layer-list>`,
  'values/studiolo_starting_theme.xml': startingTheme(
    '        <item name="android:windowBackground">@drawable/studiolo_starting_window</item>'),
  'values-v31/studiolo_starting_theme.xml': startingTheme(
    `        <item name="android:windowSplashScreenBackground">${brandColor}</item>
        <item name="android:windowSplashScreenAnimatedIcon">${startupMark}</item>`),
}
for (const [path, xml] of Object.entries(resources)) {
  const resource = join(android, 'res', path)
  await mkdir(dirname(resource), { recursive: true })
  await writeFile(resource, `<?xml version="1.0" encoding="utf-8"?>\n${xml}\n`)
}

const manifestPath = join(android, 'AndroidManifest.xml')
let manifest = await readFile(manifestPath, 'utf8')
if (!/<application\b[^>]*>/s.test(manifest) || !manifest.includes('android.permission.INTERNET')) {
  throw new Error('Unexpected Tauri Android manifest template')
}
for (const permission of ['POST_NOTIFICATIONS', 'FOREGROUND_SERVICE', 'FOREGROUND_SERVICE_REMOTE_MESSAGING']) {
  if (!manifest.includes('android.permission.' + permission + '"')) {
    manifest = manifest.replace(/<uses-permission\b[^>]*android.permission.INTERNET[^>]*\/>/,
      '$&\n    <uses-permission android:name="android.permission.' + permission + '" />')
  }
}
if (!manifest.includes('android:name=".FleetConnectionService"')) {
  manifest = manifest.replace(/<application\b[^>]*>/s, '$&\n' +
    '        <service android:name=".FleetConnectionService" android:exported="false"\n' +
    '            android:foregroundServiceType="remoteMessaging" android:stopWithTask="false" />')
}
const attributes = {
  icon: '@mipmap/studiolo_launcher',
  roundIcon: '@mipmap/studiolo_launcher',
  allowBackup: 'false',
  fullBackupContent: '@xml/studiolo_backup_rules',
  dataExtractionRules: '@xml/studiolo_data_extraction_rules',
  networkSecurityConfig: '@xml/studiolo_network_security',
}
function setAttributes(tag, entries) {
  for (const [name, value] of Object.entries(entries)) {
    const existing = new RegExp(`\\s+android:${name}="[^"]*"`)
    tag = tag.replace(existing, '').replace(/^<\w+/, `$&\n        android:${name}="${value}"`)
  }
  return tag
}
const mainActivityTag = /<activity\b[^>]*android:name="\.MainActivity"[^>]*>/
if (!mainActivityTag.test(manifest)) throw new Error('Unexpected Tauri main activity declaration')
const updated = manifest.replace(/<application\b[^>]*>/s, tag => setAttributes(tag, attributes))
  .replace(mainActivityTag, tag => setAttributes(tag, { theme: '@style/Theme.Studiolo.Starting' }))
await writeFile(manifestPath, updated)

// Keep the app SDK aligned with the pinned SDK installed by Android CI.
const gradlePath = join(android, '../../build.gradle.kts')
let gradle = await readFile(gradlePath, 'utf8')
for (const setting of ['compileSdk', 'targetSdk']) {
  const declaration = new RegExp(`^([ \\t]*${setting}[ \\t]*=[ \\t]*)\\d+[ \\t]*$`, 'm')
  if (!declaration.test(gradle)) throw new Error(`Unexpected Tauri Android SDK declaration for ${setting}`)
  gradle = gradle.replace(declaration, (_, prefix) => `${prefix}36`)
}

gradle = gradle.replace(/^    \/\/ Begin Studiolo release signing\r?\n[\s\S]*?^    \/\/ End Studiolo release signing\r?\n/m, '')
const { STUDIOLO_ANDROID_KEYSTORE_PATH, STUDIOLO_ANDROID_KEYSTORE_PASSWORD, STUDIOLO_ANDROID_KEY_ALIAS } = process.env
if (STUDIOLO_ANDROID_KEYSTORE_PATH && STUDIOLO_ANDROID_KEYSTORE_PASSWORD && STUDIOLO_ANDROID_KEY_ALIAS) {
  const androidBlock = /^android \{\r?\n/m
  if (!androidBlock.test(gradle)) throw new Error('Unexpected Tauri Android Gradle template')
  gradle = gradle.replace(androidBlock, `$&    // Begin Studiolo release signing
    signingConfigs {
        create("release") {
            storeFile = file(System.getenv("STUDIOLO_ANDROID_KEYSTORE_PATH")?.takeIf { it.isNotEmpty() }
                ?: error("Missing STUDIOLO_ANDROID_KEYSTORE_PATH"))
            storePassword = System.getenv("STUDIOLO_ANDROID_KEYSTORE_PASSWORD")?.takeIf { it.isNotEmpty() }
                ?: error("Missing STUDIOLO_ANDROID_KEYSTORE_PASSWORD")
            keyAlias = System.getenv("STUDIOLO_ANDROID_KEY_ALIAS")?.takeIf { it.isNotEmpty() }
                ?: error("Missing STUDIOLO_ANDROID_KEY_ALIAS")
            keyPassword = System.getenv("STUDIOLO_ANDROID_KEY_PASSWORD")?.takeIf { it.isNotEmpty() } ?: storePassword
        }
    }
    buildTypes.named("release") {
        signingConfig = signingConfigs.getByName("release")
    }
    // End Studiolo release signing
`)
}
await writeFile(gradlePath, gradle)
