# Nexa → Studiolo 改名执行清单

> 状态：**未执行**，等 JY 发话。
> 目标名：`Studiolo`（文艺复兴私人书房；`studio` 的意大利语指小形式）
> 产物：本清单 + 4 类改动批次。**不要一次性 sed 全库替换**，identifier 变更会移动用户数据目录。

## 0. 现状基线（2026-11-17 实测）

| 指标 | 数值 |
|---|---|
| `nexa` 命中 | **432 处 / 约 100 文件**（ripgrep 计数，不含 node_modules/.venv/dist） |
| 分布 | backend 167/44 · agent-adapters 122/12 · src 90/24 · src-tauri 31/8 · scripts 18/8 · tests 4/4 |
| 最热文件 | `src/desktop/desktop.css` 38 · `openclaw.plugin.json` 35 · `catalog.json` 30 · `src-tauri/src/lib.rs` 17 |
| 已发布版本 | v0.6.0（dmg + exe，SHA-256 已写进 release notes） |

## 1. 批次 A —— 品牌层（零风险，可先合）

| 文件 | 位置 | 改动 |
|---|---|---|
| `src-tauri/tauri.conf.json` | `productName` | `Nexa` → `Studiolo` |
| 同上 | `mainBinaryName` | `Nexa` → `Studiolo` |
| 同上 | `app.windows[0].title` | `Nexa` → `Studiolo` |
| 同上 | `bundle.externalBin` | `binaries/nexa-backend` → `binaries/studiolo-backend`（**与批次 B 同步**） |
| `src-tauri/tauri.macos.conf.json:7` | `title` | 同上 |
| `src-tauri/Cargo.toml:4,5` | `description`, `authors` | 品牌文案 |
| `src-tauri/src/lib.rs` | 149,155,161,169,184,209,237 | 中文错误提示里的「Nexa」→「Studiolo」 |
| 同上 | 245,246,250,272-284,328 | 菜单项 / tooltip / About / Hide / Quit 文案 |
| `index.html`, `package.json:2` | `name`, `<title>` | 品牌名 |
| `README.md`, `docs/*.md`（新文档） | — | 说明性文字；**历史 release notes 不改**（改了会误导） |

## 2. 批次 B —— 代码标识层（内部保持一致即可）

| 对象 | 现名 | 新名 | 涉及位置 |
|---|---|---|---|
| Cargo crate | `nexa-desktop` / `nexa_desktop_lib` | `studiolo-desktop` / `studiolo_desktop_lib` | `src-tauri/Cargo.toml:2,9`、`Cargo.lock`、`src-tauri/src/main.rs:1` |
| sidecar 二进制 | `nexa-backend` | `studiolo-backend` | `lib.rs:165`、`tauri.conf.json`、`scripts/build-backend-sidecar.py`、`scripts/desktop.mjs`、`scripts/smoke-backend-sidecar.py` |
| 环境变量前缀 | `NEXA_*` | `STUDIOLO_*` | `backend/desktop_entry.py:54,58,59`、`scripts/desktop.mjs:22`、backend 配置读取、相关测试 |
| CSS class 前缀 | `.nexa-*` | `.studiolo-*` | `src/desktop/desktop.css`(38) + `src/styles/main.css`(4) + 模板里的 class 引用（**必须全局配对替换**） |
| openclaw plugin id | `nexa-tools` | `studiolo-tools` | `openclaw.plugin.json:2` |
| openclaw 工具名 | `nexa_status`, `nexa_ledger_*`, `nexa_website_*`, `nexa_data_*`（约 30 个） | `studiolo_*` | `openclaw.plugin.json:29+`、`catalog.json`(30)、`src/client.ts`、`tests/client.test.mjs` |
| 安装标识 | `NEXA_INSTALLATION_ID` | `STUDIOLO_INSTALLATION_ID` | `desktop_entry.py:58` + 迁移时从旧值读一次 |

> ⚠️ openclaw 工具名是**对外契约**：任何已经配好调用这些工具的 agent 都会失效。要么一次改完并同步更新调用方，要么这一项单独押后。

## 3. 批次 C —— 破坏性：identifier + 用户数据迁移

### 3.1 变更点
- `src-tauri/tauri.conf.json` → `identifier`: `com.isidel.nexa` → `com.isidel.studiolo`

### 3.2 为什么危险
Tauri 用 identifier 定位 app data 目录，改完用户数据会被"遗忘"：

| 平台 | 旧目录 | 新目录 |
|---|---|---|
| macOS | `~/Library/Application Support/com.isidel.nexa/` | `~/Library/Application Support/com.isidel.studiolo/` |
| Windows | `%APPDATA%\com.isidel.nexa\` | `%APPDATA%\com.isidel.studiolo\` |

目录里有 `nexa.db`（Ledger / Websites / Data / Automation 全在里面）+ `logs/`。

### 3.3 迁移方案（在 Rust 启动早期，启动 sidecar 之前）
1. 取新旧两个 `app_data_dir`
2. 若**新目录不存在**且**旧目录存在** → `copytree(旧 → 新)`（复制不是移动，保留回滚）
3. 把 `新目录/nexa.db` 重命名为 `studiolo.db`（若批次 B 改了 DB 文件名）
4. 写一行 `logs/migration.log` 记录时间与来源
5. 旧目录**至少保留一个版本周期**再考虑清理
6. 失败时不能静默：走 `set_status` 报错并拒绝启动 sidecar（否则会用空库覆盖用户认知）

### 3.4 验收
- 在已有数据的机器上升级 → 账本条目数不变、Automation 定义还在、Conflict Center 无假冲突
- 全新安装 → 直接建新目录，不触发迁移
- 迁移中途断电/杀进程 → 下次启动能重试（幂等）

## 4. 批次 D —— 外部资产（需 JY 决策，我不擅自做）

| 项 | 影响 | 建议 |
|---|---|---|
| GitHub repo `zjyzjy0823-hue/Nexa-LumaDock` | 改名后旧 URL 会 301，但已发布的 release 直链可能失效 | 改名 + 发一个说明 release；或保留 repo 名只改产品名 |
| 已发布 v0.6.0 的 installer 文件名与 SHA-256 | release notes 与本地产物不一致 | 下一个版本号（v0.7.0）随改名一起发，别改历史 |
| 域名 | JY 已明确不作为门槛 | 用 `studiolo.isidel.com` 或后续再定 |
| 端口 17800 | — | 不变 |

## 5. 执行顺序建议

```
分支 rename/studiolo
 ├─ commit 1: 批次 A（纯文案，跑通 build）
 ├─ commit 2: 批次 B（crate/二进制/env/CSS/plugin，跑全量测试）
 └─ commit 3: 批次 C（identifier + 迁移 + 新增迁移测试）
        → 本机造旧数据 → 升级 → 验证；Windows 侧同样验一遍
```

**不要在一次 commit 里同时动 A+B+C**：迁移 bug 混在字符串替换里最难查。

## 6. 容易踩的地方

- `src-tauri/src/lib.rs:237` 的错误提示直接提到 `nexa.db` 文件名 —— 改 DB 名时这行文案要跟着改
- CSS class 是 38 处定义 + 模板里的引用，只改 CSS 文件会静默丢样式（**不用 sed 单文件替换**）
- `catalog.json`(30 处) 与 `openclaw.plugin.json`(35 处) 必须同批改，否则插件加载后工具列表对不上
- `Cargo.lock` 里也有 crate 名，改 `Cargo.toml` 后要 `cargo build` 让它自更新，别手改
- 测试文件（backend 44 个文件里有 167 处）多为断言字符串，改完要重跑，不要"看着像测试就不用改"
