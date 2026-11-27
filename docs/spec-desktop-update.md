# 规格：桌面端安装与更新方式

## 现状（实测）

| 项 | 事实 |
|---|---|
| 自动更新 | **完全没有**：`package.json` 无 `@tauri-apps/plugin-updater`，`src-tauri/Cargo.toml` 无 `tauri-plugin-updater`，`tauri.conf.json` 无 `plugins.updater`、无 `createUpdaterArtifacts` |
| macOS 安装 | DMG 拖入 `/Applications`；bundle id `com.isidel.studiolo`（不变即可覆盖，数据在 `~/Library/Application Support/…` 保留） |
| macOS 签名 | 本地 `signingIdentity: "Studiolo Dev"`；**CI 强制改成 ad-hoc（`-`）**（`ci.yml:248`）→ 同一应用在两种签名间切换会重置 TCC 权限（通知、文件访问） |
| Windows 安装 | NSIS `Studiolo_x.y.z_x64-setup.exe`（NSIS 天然支持覆盖升级，不会产生双份）；MSI 同时产出但不在 Release 里 |
| Android | 已有 keystore + 覆盖安装（本次已修好「下载后可打开」） |

## 三个方案

| 维度 | A. Tauri 官方 updater | B. 覆盖安装 + 跳转下载页 | C. B 打底 + A 上线（**推荐**） |
|---|---|---|---|
| 用户操作 | 应用内「检查更新」→ 下载 → 重启，一键 | 点「检查更新」→ 浏览器打开 Release → 拖拽 DMG / 双击 exe | 先 B，A 完成后自动一键 |
| 需要新增依赖 | `tauri-plugin-updater` + JS 插件 | 无 | 同 A |
| 需要 CI 改动 | 生成 updater 密钥、注入 secrets、产出 `.sig` + `latest.json` | 无 | 同 A |
| 需要签名一致 | **是**（否则每次更新后权限重置） | 建议（覆盖安装同样受签名影响） | 是 |
| 平台限制 | macOS 只能走 `.app.tar.gz`；Windows 只能 NSIS（MSI 不支持） | 无 | 同 A |
| 工作量 | 半天 | 1 小时 | 半天 |

## 推荐落地：C

### 阶段 1（1 小时，立即可用，零风险）

1. 设置页加「检查更新」行：
   - 取 `https://api.github.com/repos/zjyzjy0823-hue/Studiolo/releases/latest`（当前仓库 PUBLIC，无需 token）
   - 比较 `tag_name` 与 `app version`；有新版显示「发现 vX.Y.Z」+「去下载」按钮（`opener` 打开 release 页面）
2. 「关于」区显示当前版本与安装方式说明：
   - macOS：拖入「应用程序」覆盖即可，数据与登录态保留
   - Windows：直接运行新的 `setup.exe` 覆盖安装
3. 不做签名改动。

### 阶段 2（半天，一键更新）

| 步骤 | 内容 |
|---|---|
| 1 | `tauri signer generate -w ~/.hermes/secrets/studiolo-updater.key` → 得到公钥串（写入配置）与私钥文件（**必须备份**，丢了所有已发布客户端就无法再自动更新） |
| 2 | `tauri.conf.json` 增 `bundle.createUpdaterArtifacts: true`、`plugins.updater.pubkey`、`plugins.updater.endpoints: ["https://github.com/zjyzjy0823-hue/Studiolo/releases/latest/download/latest.json"]` |
| 3 | 前端接 `@tauri-apps/plugin-updater`：启动静默检查 → 设置页显示「有新版本 vX.Y.Z（大小 N MB）」→「下载并安装」带进度 → 安装完「重启生效」 |
| 4 | CI 增 `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets；构建产物里带上 `.sig`，并把 `latest.json` 上传到 Release（Windows 与 macOS 各一条记录） |
| 5 | **签名一致**：把 `Studiolo Dev` 证书导出 base64 存 GitHub Secret，CI 导入 keychain（`security import` + `set-key-partition-list`），把 `ci.yml:248` 的 `signingIdentity: "-"` 改回 `Studiolo Dev` |
| 6 | 验收：装 v0.9.10 → 应用内更新到 v0.9.11 → 版本号变化、通知权限仍在、登录态保留 |

### 关键约束（必须写进发版流程）

- **MSI 用户无法自动更新**：updater 只支持 NSIS。要么只发 exe，要么在 MSI 里明示「请用 exe 更新」。
- **macOS 未公证**：CI 产物是 ad-hoc 签名，用户从浏览器下载的 DMG 会带 quarantine，首次打开需右键「打开」。彻底解决要 Developer ID + `notarytool`（需要 Apple 开发者账号，$99/年）。
- **签名变更 = 权限重置**：ad-hoc 与 `Studiolo Dev` 之间切换会被系统视为不同应用，通知/文件访问要重新授权。发版必须固定一把。
- **updater 私钥丢失 = 断更**：私钥只存 `~/.hermes/secrets/` 与 GitHub Secrets 两处，且要写进灾备清单。

## 交付物

1. `docs/spec-desktop-update.md`（本文件）
2. 阶段 1 代码：设置页「检查更新」+ 关于区（改 `SettingsPage.vue`）
3. 阶段 2 代码：updater 插件接入 + CI 签名与密钥注入（改 `ci.yml`、`tauri.conf.json`、`package.json`、`src-tauri/Cargo.toml`）

---

# 追加：Windows 安装体验专项（"必须卸载才能装"）

## 先说结论：这不是 Tauri 的常态

Tauri 的 NSIS 安装包**本身支持就地覆盖升级**（同 installMode 下直接装新版，不弹卸载）。
会强制先卸载的，只有三种情况：

| 触发条件 | 现象 | 依据 |
|---|---|---|
| **曾装过 MSI（WiX）版** | NSIS 检测到 WiX 安装，弹「请先卸载旧版本」 | tauri-bundler #6859：`NSIS installer will now check if a previous WiX .msi installation exist and will prompt users to uninstall it` |
| **两次构建的 `installMode` 不同**（currentUser ↔ perMachine） | 安装目录/注册表根不同，视为「另一份安装」 | NSIS 按 HKCU/HKLM 分别记录卸载项 |
| 安装包与已装版本**架构不同**（x64 vs arm64） | 直接判为不兼容 | MSI 的 UpgradeCode / NSIS 的 arch 检查 |

> 一分钟自查：Windows「设置 → 应用 → 已安装的应用」里找 Studiolo，看卸载命令是
> `msiexec /x {GUID}`（= MSI 装的）还是 `uninstall.exe`（= exe 装的）。前者就是本次问题的根因。

## 六条可选路线

| # | 方案 | 用户操作 | 解决什么 | 代价 | 工作量 |
|---|---|---|---|---|---|
| **1** | **修 NSIS 升级语义**（推荐打底） | 双击新 exe，一路下一步 | 不用先卸载；自动关掉正在运行的旧版 | 加 `installerHooks` + 固定 `installMode: currentUser` | 2 h |
| **2** | **应用内 updater**（推荐目标） | 设置里点「更新」→ 自动下载静默安装 → 重启 | 不用去网页、不用管卸载 | updater 插件 + 签名密钥 + CI secrets | 半天 |
| **3** | **便携版 zip** | 解压覆盖目录 | 完全不装、不写注册表，适合多机/受控环境 | 无开始菜单/文件关联/自启；需单独打包 | 2 h |
| **4** | **Scoop bucket（自建）** | `scoop update studiolo` | 一条命令升级，适合开发者 | 只覆盖 scoop 用户；manifest 每次发版要更新 | 2 h |
| **5** | **winget 上架** | `winget upgrade Studiolo` | 系统级升级入口 | 需向 winget-pkgs 提 PR 审核，每次发版更新 manifest | 3–4 h + 审核 |
| **6** | **自建更新源**（Core 托管 `latest.json`） | 同方案 2 | 不依赖 GitHub、可灰度、可限速 | 发版脚本 + Core 静态目录 + 版本策略 | 1 天 |

> 还有一条不建议：自研「下载替换 exe」的外置更新器 —— Windows 文件锁 + 权限 + UAC 组合坑极多，
> Tauri 的 NSIS updater 已经把这条路走通了。

## 推荐组合：1 → 2（+ 可选 3）

**第 1 步（2 小时，立刻解决你现在的麻烦）**

1. `tauri.windows.conf.json` 显式写死：
   ```json
   "nsis": {
     "installMode": "currentUser",
     "languages": ["English", "SimpChinese"],
     "installerHooks": "windows/hooks.nsh"
   }
   ```
2. `src-tauri/windows/hooks.nsh`：
   ```nsh
   !macro NSIS_HOOK_PREINSTALL
     ; 关掉正在运行的旧版，避免文件占用导致替换失败
     nsExec::Exec 'taskkill /F /IM studiolo.exe'
     Sleep 800
     ; 如果检测到旧的 MSI 安装，先静默卸载它（只做一次，之后都是 NSIS）
     ReadRegStr $0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\{PRODUCT-GUID}" "UninstallString"
     StrCmp $0 "" done
       nsExec::Exec 'msiexec /x {PRODUCT-GUID} /qn'
     done:
   !macroend
   ```
   （`{PRODUCT-GUID}` 用首次 MSI 发布时的 UpgradeCode；没有 MSI 历史可整段省略）
3. 发版纪律：**之后只发 exe，不再发 msi**，避免两条安装链打架。

**第 2 步（半天，做到应用内一键更新）**

- `tauri-plugin-updater` + `plugins.updater.endpoints` → Release 的 `latest.json`
- Windows 侧 updater 调用的就是 NSIS 安装包（`/S` 静默），**会自动结束正在运行的进程再装**，
  所以「开着应用也能更新」这一点由它兜住
- macOS 侧同时获得一键更新（`.app.tar.gz`）

**第 3 步（可选，2 小时）**

- CI 多产一个 `Studiolo_x.y.z_windows-portable.zip`（`target/release/` 里 exe + 资源）
- 给不想安装的人；缺点写清楚：无自启、无文件关联、升级需手动覆盖

## 验收

1. 在**已装旧版且应用运行中**的状态下双击新 exe → 一路下一步装完，无需手动卸载、无需先退出应用。
2. 若机器上有历史 MSI 安装 → 新 exe 能自动静默卸载它并继续安装。
3. 应用内「检查更新」→ 下载 → 重启后版本号变化，登录态与数据保留。
