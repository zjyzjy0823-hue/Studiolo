# 规格：Android 一键更新（检查 → 下载 APK → 拉起系统安装器）

## 现状

- 桌面端：`useUpdater` + `tauri-plugin-updater`，可检查/下载/验签/重启 ✅
- **Android：`tauri-plugin-updater` 不支持移动端**，设置页「关于 · 检查更新」点了会走到 `error` 状态 ❌
- 已有能力（可直接复用）：
  - `src/services/saveDownload.ts` → `android_save_attachment(name, base64)` 写入 `Downloads/Studiolo`
  - `android_open_download(name, displayPath)` → 已处理 `REQUEST_INSTALL_PACKAGES` / FileProvider / `install_permission` 错误

## 目标

Android 上点「检查更新」能：
1. 读到最新版本号与 APK 直链
2. 有新版本 → 显示版本、大小、说明
3. 点「下载并安装」→ 带进度下载 → 自动拉起系统安装器（用户只点一次「安装」）

## 数据源

新增 `android.json`（放在 `updater-feed` 这个滚动 tag 里，和 `latest.json` 并列）：

```json
{
  "version": "0.9.13",
  "url": "https://github.com/zjyzjy0823-hue/Studiolo/releases/download/v0.9.13/Studiolo_0.9.13_arm64-release.apk",
  "size": 22378187,
  "sha256": "92d8…",
  "notes": "下载页 + 更新入口打磨"
}
```

- 由 `scripts/make-latest-json.mjs` 一并生成（新增 `--apk <path>` 或自动在同目录找 `*_arm64-release.apk`）
- 客户端 URL 固定：`https://github.com/zjyzjy0823-hue/Studiolo/releases/download/updater-feed/android.json`
- **不要**塞进 `latest.json` 的 `platforms`：Tauri updater 对未知 target 反序列化会失败

## 实现（前端为主，不改 Kotlin）

### 1. `src/composables/useUpdater.ts`

- `UpdaterBackend` 增加可选 `platform: 'desktop' | 'android'`
- Android 分支：
  - `check()`：
    - `fetch(ANDROID_FEED_URL + '?cb=' + Date.now())`（10 分钟内存缓存）
    - 版本比较：semver 三段数字比较，**忽略预发布后缀**（`0.9.13` vs `0.9.13-rc1` 视为相同）
    - 返回 `{ version, currentVersion, body: notes, size, url }`
  - `install()`：
    - `fetch(url)` → `response.body` 流式读取，累计 `percent = loaded/total*100`
    - 拼成 `Uint8Array` → 分块 base64（每 0x8000 字节一块，避免一次性大字符串爆栈）
    - `android_save_attachment({ name, base64 })` 落盘
    - `android_open_download({ name, displayPath })` 拉起安装器
    - 失败：`install_permission` → 提示「需要允许本应用安装应用」；网络错误 → 可重试
- 平台判定：`desktopPlatform() === 'android'`（已有 `src/desktop/platform.ts`）
- 桌面分支行为保持不变

### 2. `src/components/settings/UpdateRow.vue`

- Android 上复用现有五态：
  - `available`：显示「v0.9.13 · 22.4 MB」+ 主按钮「下载并安装」
  - `downloading`：显示百分比
  - 完成后提示「正在打开安装器…」
- 文案不要出现「重启」「验签」这类桌面词

### 3. 测试 `tests/updater-android.test.mjs`（新）

用 mock 的 `fetch` / `invoke` 覆盖：
1. 远端 0.9.14 > 本地 0.9.13 → `available`，带 size/url
2. 远端等于本地 → `up-to-date`
3. `android.json` 404 → `error`，文案含「无法检查更新」
4. `install()` 串行调用 `android_save_attachment` → `android_open_download`
5. `install_permission` 错误 → 状态文案为「需要允许本应用安装应用」
6. 版本比较函数：`0.9.13` vs `0.9.9`、`0.10.0` vs `0.9.13`、`0.9.13` vs `0.9.13-rc1`

## 约束

- 不改 `plugins.updater` 配置，不动桌面更新链路
- 不新增依赖（base64 用现有 `btoa` 分块）
- 不改 Kotlin（`android_save_attachment` / `android_open_download` 已够用）
- 生成进度的 UI 不要用 toast，直接复用 UpdateRow 的百分比

## 验收

1. `npx vue-tsc --noEmit` 0；`npm run test:updater-android` 全绿；`npm run test:updater` 不回归
2. `npm run build` 成功
3. `node scripts/make-latest-json.mjs ...` 能同时产出 `latest.json` 与 `android.json`
4. 真机：旧版 APK 点检查更新 → 显示新版本 → 下载 → 弹出安装器（我这侧用 adb 验证）
