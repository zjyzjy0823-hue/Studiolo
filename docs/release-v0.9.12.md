# Studiolo v0.9.12 — 桌面分发与更新体系

> 本版相对 v0.9.11 的增量：**修正更新源地址**。v0.9.11 内嵌的是
> `releases/latest/download/latest.json`，而仓库的「latest」指针停在旧版本（v0.7.0），
> 客户端会 404。现改为固定滚动源 `releases/download/updater-feed/latest.json`，
> 每次发版覆盖该资产即可。装过 v0.9.11 的机器需手动装一次本版，之后可自动更新。

> 预发布（pre-release）。本版重点是把桌面端的「安装 → 升级」链路做对，并补齐桌面端此前缺的三处功能。

## 主要变化（自 v0.9.10）

### Windows 安装：不再要求先卸载
- NSIS 显式固定 `installMode: currentUser`（此前依赖默认值，历史安装会被当成「另一份」）
- 新增安装前 hook：自动结束正在运行的 `Studiolo.exe` 与 `studiolo-backend.exe`，避免文件占用导致「装完还是旧版」
- 发版只出 **exe（NSIS）**，不再发 msi —— 两条安装链会在机器上互相要求先卸载
- 新增 `windows-portable.zip`（解压即用，适合受控环境）

### 应用内一键更新（Windows / macOS）
- 接入 `tauri-plugin-updater`：启动后静默检查，发现新版可在应用内下载并安装，重启生效
- 桌面入口：侧栏底部版本号右侧的**黑色圆形箭头按钮**（有新版亮蓝点 / 下载中显示环形进度 / 就绪换重启箭头）
- 手机入口：设置 → 关于 → 检查更新（行内显示「已是最新 / 发现 vX / 下载中 N% / 重启生效」）
- 更新源：GitHub Release 的 `latest.json`，由 `scripts/make-latest-json.mjs` 从各平台 `.sig` 生成
- **macOS 签名统一为 `Studiolo Dev`**（CI 与本地一致）：此前 CI 是 ad-hoc，每次更新会被系统当成另一个应用，通知与文件权限重置

### 桌面端功能补齐（对齐移动端）
- **下载落到可预期位置**：`~/Downloads/Studiolo/`，重名自动加 `(1)(2)`，下载记录保存真实绝对路径
- **打开已下载文件**：点击附件走系统默认程序打开（此前桌面直接报「仅 Android 支持」）
- 下载记录里的路径可再次打开；文件被移动或删除时提示「文件已被移动或删除」
- 附件菜单补齐「引用工作区文件 `@`」「调用斜杠指令 `/`」（原来只有移动端有）

### 安全与实现细节
- `save_download_file_b64`：大文件走 base64 而非 `number[]`（后者会被序列化成 JSON，20MB 文件约 60MB 文本，会卡死 WebView）
- `open_saved_path` 只允许打开下载目录内的文件（canonicalize 前缀校验），避免退化成任意文件打开器
- 文件名清洗：剥离路径分隔符、`..` 与 Windows 保留字符

## 产物

| 平台 | 文件 |
|---|---|
| macOS Intel | `Studiolo_0.9.11_x64.dmg` |
| macOS Apple Silicon | `Studiolo_0.9.11_aarch64.dmg` |
| Windows | `Studiolo_0.9.11_x64-setup.exe`（覆盖安装，无需卸载） |
| Windows 便携版 | `Studiolo_0.9.11_x64-portable.zip` |
| Android arm64 | `Studiolo_0.9.11_arm64-release.apk` |
| 更新源 | `latest.json`（macOS x64/aarch64 + Windows x64） |

`SHA256SUMS.txt` 包含全部产物的校验和（按 GitHub 服务端 digest 生成）。
