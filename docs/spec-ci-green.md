# 任务书 A · 让 main 的 CI 转绿

> 目标：只修 CI 的 4 个红作业，不改产品行为、不加功能。改完 `main` 上 `CI` workflow 应全绿。

## 背景（已核实）

`main` 最近 5 次 CI 全部失败，4 个作业红：

| 失败作业 | 根因 |
|---|---|
| `backend-postgres` | 版本漂移：`backend/tests/postgres_sync_integration.py:29` 读 `package.json`（0.9.9）断言 `/api/health` 的 version，而服务返回 `APP_VERSION=0.8.6` |
| `desktop-windows` | 同一个版本漂移：`scripts/smoke-backend-sidecar.py:123` 断言 sidecar health 的 version == `package.json` 的 version |
| `frontend` | `tests/fleet.test.mjs:788` 的原生通信用例仍假设 macOS 走 Rust channel，但 `src/stores/fleet.ts:305` 已是 `const nativeTransport = desktopPlatform() === 'android'`（e1b0a3e：桌面端回退浏览器 WebSocket，只有 Android 走原生） |
| `desktop-macos`（aarch64 + x64） | `src-tauri/tauri.conf.json:53` 写死 `"signingIdentity": "Studiolo Dev"`，CI runner 没有该证书 → `failed to run command codesign` |

## 范围（严格只改下面三块）

### 1) 版本号对齐到 0.9.9

改这几处（`package.json` / `src-tauri/tauri.conf.json` / `src-tauri/tauri.android.conf.json` 已经是 0.9.9，不要动）：

- `backend/app/main.py:36` `APP_VERSION = "0.8.6"` → `"0.9.9"`
- `src-tauri/Cargo.toml:3` `version = "0.8.6"` → `"0.9.9"`
- `src-tauri/Cargo.lock` 里 `name = "studiolo"` 条目的 `version` → `"0.9.9"`（CI 用 `--locked`，必须一起改）
- `agent-node/agent_node/adapters/codex.py:228` `"clientInfo": {... "version": "0.8.6"}` → `"0.9.9"`
- `agent-node/agent_node/adapters/hermes.py:209` `"clientInfo": {... "version": "0.8.6"}` → `"0.9.9"`
- `deploy/edge-relay/edge_relay.py:118` `version="0.8.6"` → `"0.9.9"`

不要改测试里任何版本断言（本仓库测试不写死版本号，已核实）。

### 2) 更新过期用例 `tests/fleet.test.mjs:788-835`

- 把该子测试里 mock 的 `desktop_platform` 返回值从 `'macos'` 改成 `'android'`，保留原生 channel 路径的覆盖（这是唯一还在测原生通道的用例）。
- 新增一条小用例，断言新不变量：`desktop_platform` 返回 `'macos'` 时，`connectSocket()` **不调用** `fleet_connect`，而是创建浏览器 WebSocket（用现有 `MockSocket` 模式或最小替身），并能正常收发一帧。
- 不改 `src/` 下任何产品代码。

### 3) CI 的 macOS 签名

- `.github/workflows/ci.yml:248` 的构建命令追加配置覆盖，让 CI 用 ad-hoc 签名：
  `node node_modules/@tauri-apps/cli/tauri.js build --target "$(rustc --print host-tuple)" --bundles app --config '{"bundle":{"macOS":{"signingIdentity":"-"}}}'`
- 保留 `src-tauri/tauri.conf.json` 的 `"Studiolo Dev"`（本机固定签名身份要用，不要删）。
- `desktop-windows` 作业里的 `npm run desktop:build` 不要加 macOS 相关参数。

## 验收（必须自己跑，交付里贴原始输出）

1. `npm run test:fleet` → `ℹ fail 0`（注意：子用例失败时父用例会重复计数，只看 fail 数）
2. `grep -rn "0\.8\.6" backend/app/main.py src-tauri/Cargo.toml agent-node/agent_node/adapters/codex.py agent-node/agent_node/adapters/hermes.py deploy/edge-relay/edge_relay.py` → 无输出
3. `grep -n -A2 'name = "studiolo"' src-tauri/Cargo.lock` → 显示 `version = "0.9.9"`
4. `grep -n "tauri.js build" .github/workflows/ci.yml` → 贴出改动后的完整命令
5. `git diff --stat` → 只应包含上面列出的文件（加 `tests/fleet.test.mjs`）

## 禁止

- 不要 `git add` / `git commit` / `git push`
- 不要改产品逻辑、`syncMode` 默认值、`.env*`
- 不要执行 `git checkout` / `git reset` / `rm`
- 不要跑全量后端 pytest（约 12 分钟）或 `postgres_sync_integration.py`（会往数据库写数据）

## 交付格式

最后输出三节：
1. **改动清单**：`文件:行号` + 改了什么
2. **验收输出**：上面 1–5 条命令的原始输出片段
3. **偏离说明**：任何与本任务书不一致的地方及原因（没有就写「无」）
