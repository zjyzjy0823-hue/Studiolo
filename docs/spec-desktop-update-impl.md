# 实现规格：桌面安装/更新体系 + 桌面端功能补齐（一次性交付）

> 前置事实（已由我完成，agy 不需要再做）：
> - updater 密钥已生成：私钥 `~/.hermes/secrets/studiolo-updater.key`、密码 `~/.hermes/secrets/studiolo-updater.password`
> - 公钥文件 `~/.hermes/secrets/studiolo-updater.key.pub`（内容需原样写进 `tauri.conf.json`）
> - macOS 签名证书已导出 p12：`~/.hermes/secrets/studiolo-signing.p12`（密码在 `.p12.password`）
> - GitHub Secrets 已配好：`TAURI_SIGNING_PRIVATE_KEY`、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`、`MACOS_SIGNING_CERT_P12`、`MACOS_SIGNING_CERT_PASSWORD`
> - 用户此前装的是 **exe（NSIS）**，不是 MSI；因此不必写「静默卸载历史 MSI」的 hook。

---

## A. Windows 覆盖安装（不要求先卸载）

### A1. `src-tauri/tauri.windows.conf.json`

`bundle.windows.nsis` 显式补两项：

```json
"nsis": {
  "installMode": "currentUser",
  "languages": ["English", "SimpChinese"],
  "installerHooks": "windows/hooks.nsh"
}
```

- `installMode` 必须显式写死（默认值会随 Tauri 版本变，历史安装会被当成另一份）。
- `targets` 保持 `["nsis"]`。

### A2. `src-tauri/windows/hooks.nsh`（新增）

```nsh
!macro NSIS_HOOK_PREINSTALL
  ; 结束正在运行的旧版与 sidecar，避免文件占用导致"装完还是旧版"
  nsExec::Exec 'taskkill /F /IM "Studiolo.exe"'
  nsExec::Exec 'taskkill /F /IM "studiolo-backend.exe"'
  Sleep 800
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; 安装完成不自动拉起，交给用户/更新器
!macroend
```

> 不要写 `msiexec /x` 那一段。用户从没装过 MSI，写了反而可能误删别的产品。

### A3. `.github/workflows/desktop-windows.yml`

- 构建命令改 `--bundles nsis`（去掉 `msi`，避免两条安装链打架）。
- 新增环境变量透传：`TAURI_SIGNING_PRIVATE_KEY`、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`（来自 secrets）。
- 新增「便携版」步骤：把 `src-tauri/target/x86_64-pc-windows-msvc/release/` 下的 `Studiolo.exe`、`studiolo-backend.exe`（sidecar）打成一个 `Studiolo_<version>_x64-portable.zip`（PowerShell `Compress-Archive`）。
- artifact 路径增加：`nsis/*.exe`、`nsis/*.exe.sig`（若存在）、`*.zip`。

---

## B. 应用内一键更新（Tauri updater）

### B1. 依赖

- `npm i @tauri-apps/plugin-updater@^2 @tauri-apps/plugin-process@^2`
- `cargo add tauri-plugin-updater tauri-plugin-process --manifest-path src-tauri/Cargo.toml`

### B2. `src-tauri/tauri.conf.json`

```jsonc
{
  "bundle": {
    // 现有字段保持不动，仅新增：
    "createUpdaterArtifacts": true
  },
  "plugins": {
    "updater": {
      "pubkey": "<把 ~/.hermes/secrets/studiolo-updater.key.pub 的内容原样粘进来>",
      "endpoints": [
        "https://github.com/zjyzjy0823-hue/Studiolo/releases/latest/download/latest.json"
      ]
    }
  }
}
```

### B3. `src-tauri/src/lib.rs`

注册插件：`tauri_plugin_updater::Builder::new().build()` 与 `tauri_plugin_process::init()`。

### B4. capabilities

在 `src-tauri/capabilities/` 里已有的 capability 文件中补权限：`"updater:default"`、`"process:allow-restart"`（Tauri v2 的 process 插件重启权限）。

### B5. 前端 `src/composables/useUpdater.ts`（新增）

状态机：`idle | checking | available | downloading | ready | up-to-date | error`。

```ts
// 关键 API（@tauri-apps/plugin-updater v2）
const update = await check()            // 无更新返回 null
await update.downloadAndInstall(evt => { /* evt.event === 'Progress' | 'Started' | 'Finished'; 计算百分比 */ })
await relaunch()                         // @tauri-apps/plugin-process
```

要求：

- 启动后 **静默检查一次**（延迟 8 s，失败只 `console.debug`，绝不弹错、不阻塞首屏）。
- 只在 Tauri 环境执行（`isTauri()` 判断，浏览器预览直接跳过）。
- 暴露：`state`、`version`、`notes`、`percent`、`error`、`check({ silent })`、`install()`、`restart()`。
- 检查结果缓存 10 分钟，避免设置页反复点触发多次请求。

### B6. 桌面 UI（按用户要求：版本号旁边一个黑色圆形箭头图标）

位置：`src/components/layout/OpusShell.vue` 的 `footer.statusbar`，紧挨现有 `<span class="sb-item faint">v{{ version }}</span>`。

实现要点：

- 一个 **32×32 的黑色圆形按钮**（`background: #111`, 白色箭头图标），箭头用「旋转/刷新」语义（lucide `RefreshCw`，`stroke-width: 2`）。
- 状态映射：
  - `idle/up-to-date`：箭头静态，`title="检查更新"`
  - `checking`：图标 `animation: spin 1s linear infinite`
  - `available`：按钮右上角一个 accent 小圆点 + `title="发现新版本 vX.Y.Z"`
  - `downloading`：按钮内显示圆形进度（`conic-gradient` 环），`title="下载中 42%"`
  - `ready`：图标换成 `RotateCw`，`title="重启以完成更新"`
  - `error`：图标变红，`title` 带失败原因
- 点击行为：`idle/up-to-date/error → check()`；`available →` 弹一个 240px 的小 popover（版本号、包大小、更新说明前 3 行、「下载并安装」按钮）；`ready → restart()`。
- popover 用现有 `mat-solid` / `--r-lg` 风格，不要新造设计语言。

### B7. 移动端 UI（位置由实现者定，建议设置页）

`src/pages/SettingsPage.vue` 的「更多设置」区最上面加一组「关于」：

- 行 1：`当前版本` → `v{{ version }}`
- 行 2：`检查更新` → 右侧显示状态（`已是最新` / `发现 vX.Y.Z` / `下载中 42%` / `重启生效`），点击走同一套 `useUpdater`
- 移动端不显示悬浮圆钮（屏幕小），状态文案足够。

### B8. 更新源文件 `scripts/make-latest-json.mjs`（新增）

用途：发版时把 release 里各平台的 `.sig` 与安装包 URL 汇总成 `latest.json`。

```bash
node scripts/make-latest-json.mjs \
  --version 0.9.11 \
  --release-dir /tmp/rel911 \
  --base-url https://github.com/zjyzjy0823-hue/Studiolo/releases/download/v0.9.11
```

- 扫 `--release-dir` 里的 `*.sig`，按文件名映射平台：
  - `*_x64.app.tar.gz.sig` → `darwin-x86_64`
  - `*_aarch64.app.tar.gz.sig` → `darwin-aarch64`
  - `*-setup.exe.sig` → `windows-x86_64`
- 输出 `latest.json`（字段：`version` / `pub_date` / `platforms.<target>.{signature,url}`）。
- `signature` 内容是 `.sig` 文件的**原文**（minisign 串），不要 base64 再包一层。
- 缺少任一平台要在 stderr 警告但不失败（允许先发单平台）。
- 同时在 package.json 加 `"release:feed": "node scripts/make-latest-json.mjs"`。

### B9. `.github/workflows/ci.yml`（macOS 部分）

1. **签名一致**：删掉 `--config '{"bundle":{"macOS":{"signingIdentity":"-"}}}'` 这段覆盖；改为在构建前把 `MACOS_SIGNING_CERT_P12` 导入临时 keychain：

```bash
echo "$MACOS_SIGNING_CERT_P12" | base64 -d > /tmp/studiolo.p12
security create-keychain -p actions tmp.keychain
security set-keychain-settings -lut 21600 tmp.keychain
security unlock-keychain -p actions tmp.keychain
security import /tmp/studiolo.p12 -k tmp.keychain -P "$MACOS_SIGNING_CERT_PASSWORD" -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple: -s -k actions tmp.keychain
security list-keychains -d user -s tmp.keychain $(security list-keychains -d user | tr -d '"')
```

2. sidecar 与 app 都用 **`Studiolo Dev`** 签名（现在写的是 `-`）：

```bash
codesign --force --sign "Studiolo Dev" "$APP/Contents/MacOS/studiolo-backend"
codesign --force --deep --sign "Studiolo Dev" "$APP"
codesign --verify --deep --strict "$APP"
```

3. 构建环境加 `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`，产出 `.app.tar.gz` 与 `.sig`。
4. 上传 release 的资产增加：`*.app.tar.gz`、`*.app.tar.gz.sig`。

---

## C. 桌面端功能补齐（上一轮清单的 P1 / P2）

### C1. 下载落到可预期位置并记录真实路径（P1）

**不要新增 dialog / fs 插件**（`tauri-plugin-opener` 已在用，其余保持零新增）。改用一条 Rust 命令：

```rust
#[tauri::command]
fn save_download_file(app: tauri::AppHandle, name: String, bytes: Vec<u8>) -> Result<String, String>
// 1) 清洗 name（去路径分隔符、去 ..、空名回退 download）
// 2) 目标目录：~/Downloads/Studiolo（不存在则创建）
// 3) 重名时追加 (1)(2)…，返回写入后的绝对路径
```

- 前端 `src/services/saveDownload.ts` 桌面分支：读 blob → `Uint8Array` → `invoke('save_download_file', { name, bytes: Array.from(u8) })`（大文件走分块或 base64 均可，注意 IPC 体积上限，>8 MiB 用分块写入命令 `append_download_chunk`）。
- 浏览器预览环境保持现有 `<a download>` 兜底。
- 下载记录 `downloadHistory` 的 `displayPath` 存绝对路径（桌面）。

### C2. 打开已下载文件（P1）

- 新增 Tauri 命令 `open_path(path: String)`：用 `tauri_plugin_opener`（或 `opener` crate）调用系统默认程序；路径不存在返回结构化错误码 `path_missing`。
- `openSavedDownload()` 桌面分支调用它；错误文案与移动端对齐（「文件已被移动或删除」）。
- iOS/Android 分支保持现状不动。

### C3. 「引用工作区文件 @」「斜杠指令 /」入口（P2）

`src/components/chat/AgentChatThread.vue`：把现在只给 `mobile` 的两个按钮（`insertQuickTrigger('@')` / `insertQuickTrigger('/')`）在桌面也渲染（去掉 `v-if="mobile"`），位置放在「选择照片/文件」之后。

---

## D. 约束与验收

### 约束

- 不新增任何**运行时**依赖以外的包（updater/process/dialog/fs/opener 这 5 个是必需的，允许）。
- 不改 `agent-node/`、`backend/`、`design/`。
- 不改已发布的 Android 逻辑（`AndroidDownloads.kt` 不动）。
- 所有新代码要有对应测试或至少 `vue-tsc` 通过；`npm run test:*` 全绿。
- 不执行 `git commit`。

### 验收

1. `npx vue-tsc --noEmit` = 0；`npm run build` 成功。
2. `cargo check --manifest-path src-tauri/Cargo.toml` 通过（macOS 目标即可）。
3. 桌面侧栏底部出现黑色圆形箭头按钮，`update` 状态机可切换（可用 console 触发 available/downloading 状态截图验证）。
4. `node scripts/make-latest-json.mjs --help` 可用；用一个假 `.sig` 能生成结构正确的 `latest.json`。
5. `npm run test:downloads` 等既有测试全绿。
6. Windows 配置里只剩 `nsis`，`installMode` / `installerHooks` 已写入，hooks 文件存在。
