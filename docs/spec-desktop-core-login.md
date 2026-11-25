# 诊断任务：桌面端 Core 登录不持久 + Fleet WebSocket 从未建立

> 只做**只读分析**。不要修改任何文件、不要重启任何服务、不要提交。禁止打印 token / 密码 / 密钥内容。

## 环境事实

- 仓库：`/Users/zjy/Projects/Nexa-LumaDock`，分支 `feat/reconnect-follow`
- 桌面端已从 0.8.1 升级到 0.9.8（`/Applications/Studiolo.app`，bundle id `com.isidel.studiolo`）
- Core 后端在本机 `127.0.0.1:8000`（LaunchAgent `ai.riri.studiolo-core`），公网入口 `https://studiolo.isidel.com`（frp → 本机）
- agent-node 在本机 `127.0.0.1:18910`（LaunchAgent `ai.riri.studiolo-agent-node`）

## 实测现象（均已复现，不是推测）

1. **服务端是好的**。用真实账号 JWT 从命令行连接：
   - `ws://127.0.0.1:8000/ws/fleet/client` → 首帧 `{"type":"FleetSnapshot","nodes":[{"nodeId":"6f72f30f...","name":"Mac mini","status":"online"}...]}`
   - `wss://studiolo.isidel.com/ws/fleet/client` → 同样返回 `FleetSnapshot`
   - 首帧鉴权要求 `{"type":"auth","token":...}` 或 `Authorization: Bearer`；无 token 时 close 4401 "Missing auth frame"

2. **桌面端界面表现**：
   - 登录 Core 弹窗（`登录 Core 对话`，地址 `https://studiolo.isidel.com`）填账号密码后登录"成功"：会话列表出现节点 `zjydeMac-m…`，输入框 placeholder 变成「向 Mac mini 描述任务…」
   - 但顶部仍显示 `Fleet WebSocket 通道: disconnected`，会话区显示 `正在建立到 Core Relay 的连接，请稍候重试`，并出现系统气泡「无法连接到 Studiolo 后端」
   - **重启 App 后回到「登录 Core 以恢复连接」** → 登录态没有持久化

3. **Core 侧日志**（`~/.hermes/logs/studiolo-core.log`）在桌面端登录/重连期间**没有任何来自该客户端的 `/ws/fleet/client` 连接记录**，只有我手动探测的三条。也就是说桌面端**连握手都没发出**。

4. 本机 `~/Library/Application Support/com.isidel.studiolo/` 下：
   - `core-connections/1/connection.json`：`coreUrl=https://studiolo.isidel.com`、`clientId=09c7707d-…`、`workspaceId=bf909a76-…`、`appVersion=0.7.0`、`connectedAt=2026-11-20`
   - `core-connections/1/credential`（加密文件，配合 `secret.key` / 钥匙串 `com.apple.WebKit.WebCrypto.master+com.isidel.studiolo`）
   - `studiolo.db`（本地库）
   - 升级后首次启动时弹出过钥匙串授权「Studiolo WebCrypto Master Key」，已点「始终允许」

## 要回答的问题（每条都必须给 `文件:行号`）

1. 登录成功后，Core 的 JWT 存在哪里？写入代码路径是哪几行？为什么重启后读不回来？
   - 重点看：`core-connections/*/credential` 的加解密、`secret.key` / WebCrypto master key 的关系、写入是否在 `actor`/`credential` 未就绪时静默失败
2. 桌面端的 `fleet_connect` 在什么条件下才会被调用？`src/stores/fleet.ts` 里 `fleetRoute` / `nativeTransport` / `token` 分别从哪里来？
   - 登录成功后是否真的把 token 写进了 `fleetRoute`？若没有，`connectSocket()` 会走哪条分支？
3. `sendWsCommand` 报「正在建立到 Core Relay 的连接」时，真实状态机是什么？`wsState` 为何一直停在 connecting/reconnecting 而没有产生任何网络连接？
4. `src-tauri/src/fleet.rs` 的 `fleet_url()` 校验是否可能让本机/云端 URL 直接被拒（scheme/path/query/host 规则），从而**不发握手**？
5. 「无法连接到 Studiolo 后端」这条气泡是哪段代码产生的（前端还是 sidecar），触发条件是什么？
6. 0.8.1 → 0.9.8 之间（`git log` 里 fetch 相关改动）有没有改过登录/凭据/`fleet_connect` 触发链？如果怀疑是新引入的回归，指出可疑 commit 与行。

## 交付格式

```
## 结论（一句话）
## 证据链（问题 → 文件:行 → 代码摘录）
## 根因（最可能 1 个 + 备选 1 个，各自说明如何证伪）
## 最小修复方案（改哪几行、为什么、风险）
## 建议加的日志（观测点清单）
```

## 边界

- 只读：`read_file` / `grep` / `git log` / `git diff` 可以；**不要写文件、不要跑测试、不要重启服务**
- 不要尝试连接生产 Core、不要读取或输出任何密钥内容
- 如果 30 分钟内无法收敛，直接给「已确认部分 + 未确认部分 + 下一步建议」
