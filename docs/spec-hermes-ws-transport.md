# SPEC · Hermes 适配器从 ACP 换到 gateway WebSocket（/api/ws）

- 版本：v1（2026-11-23）
- 实施者：Codex（`gpt-6.2-sol`, effort=high）
- 代号：`hermes_ws`
- 目的：解决 ACP 通道的三个结构性问题——主动消息推不出、运行中插话要 redirect 黑魔法、断流无自愈

## 0. 背景（已确认的事实）

- Hermes gateway 在 `127.0.0.1:9119` 暴露 WebSocket 端点 `/api/ws`（`hermes_cli/web_routers/chat_ws.py:650` → `tui_gateway/ws.py`）
- 该通道使用 **JSON-RPC 2.0**（`{"jsonrpc":"2.0","method":...,"id":...,"params":{...}}`）
- 流式事件类型：`message.delta`、`reasoning.delta`、`thinking.delta`（`tui_gateway/ws.py:129`）
- 支持 `session.transcript`（完整对话拉取，`ws.py:104` 允许并发读）
- **Hermes Mobile（`~/.hermes/workspace/hermes-mobile`，Kotlin）用的就是这条通道**，是现成的参考实现
- 现有 Studiolo 走的是 `hermes acp` 子进程 + stdio JSON-RPC（`agent-node/agent_node/adapters/hermes.py`）

## 1. 目标

新增 `agent-node/agent_node/adapters/hermes_ws.py`，实现与现有 `HermesAdapter` **完全相同的对外接口**：

```python
class HermesWsAdapter(BaseAdapter):
    async def send_prompt(self, *, session_id, text, request_id, emit, request_approval, attachments=None, options=None) -> None
    async def steer(self, *, session_id, text) -> bool
    async def cancel(self, *, session_id, request_id=None, run_id=None) -> None
    # 会话管理：list/create/load/history/compact 等，按 daemon 实际调用的方法逐个对齐
```

**硬要求：接口签名、emit 事件类型、审批回调语义必须与 `hermes.py` 一致**——daemon / Core / 前端一行都不用改。

## 2. 调研清单（先读，再写）

按顺序读，产出「协议映射表」：

1. `~/.hermes/hermes-agent/tui_gateway/ws.py`（763 行，JSON-RPC 传输层、流式事件集合、并发读白名单）
2. `~/.hermes/hermes-agent/tui_gateway/server.py`（dispatch 路由 + 方法清单，重点找：发消息、取消、审批应答、会话列表/恢复/transcript）
3. `~/.hermes/hermes-agent/hermes_cli/web_routers/chat_ws.py:650` 起（握手、鉴权、sidecar 限制）
4. `~/.hermes/workspace/hermes-mobile/app/src/main/java/com/m57/hermescontrol/`（Kotlin 客户端：怎么连、怎么发消息、怎么解析 delta、怎么做重连）
5. `agent-node/agent_node/adapters/hermes.py`（现有 ACP 实现，要照抄的接口与事件映射）
6. `agent-node/agent_node/adapters/jsonrpc.py`（现有 JSON-RPC 传输工具，能复用就复用）

**鉴权**：先确认 `/api/ws` 在本机 dashboard（无 token）下的连接方式；如果要求 ticket，读 `hermes_cli/web_routers/chat_ws.py` 的 `_close_unless_sidecar_allowed` / `_ws_auth_reason`，找出本机可用的最小凭证路径，写进 SPEC 的映射表。

### 2.1 协议映射

| Studiolo 事件/方法 | /api/ws 方法/事件 | 备注 |
| --- | --- | --- |
| 连接、探活 | `event(gateway.ready)`、`gateway.ping`、`client.capabilities` | 单条 JSON-RPC 帧，事件在 `params.type/payload`。`gateway.ping` 直接返回 `{"ok":true}`。`session_authority` 区分 canonical 与独立 dashboard。声明 `server_requests:true`。 |
| 鉴权 | `POST /api/auth/ws-ticket` → `hermes-gateway-v1`、`hermes-gateway-ticket.<ticket>`；本机 `?token=` | 9119 匿名升级返回 HTTP 403，根页面跳转登录。部署可用凭证路径为现有 `hermesMedia.tokenFile`，launchd 配置指向 `~/.hermes/dashboard-token.txt`。登录模式用 Bearer 换 30 秒一次性票据，重连重签；普通本机 dashboard 可使用 `?token=`，无固定配置时从同源首页的 `__HERMES_SESSION_TOKEN__` 读取。两种模式均受 embedded chat、客户端地址和 Host/Origin 限制。 |
| `list_sessions` | `session.list` | Canonical 合并 `scope:"stored"` 和 `scope:"live"`（`picker:true`，每次最多 200 行）；独立 dashboard 使用 `limit`，缺失的目录及模型从同源 `GET /api/sessions` 补读，节点按原接口切页。 |
| `open_session` | `session.create` / `session.resume` | 对外用持久 `stored_session_id`，独立 dashboard 的会话 RPC 用返回的运行时 `session_id`。创建传 `cwd`、`source:"acp"`；本地继续校验 allowedRoots。 |
| `get_history`、断线补状态 | `session.transcript` / `session.history`、`session.events.since` | Canonical transcript 按 `order:"latest"` 分页，每页仍按时间正序。独立 dashboard 用 `session.history`。重连恢复订阅、检查 epoch 和 seq、拉取 transcript，再处理重放和未决审批。 |
| `send_prompt` → `Accepted` | `prompt.submit` | `session_id`、`text`，canonical 再传 `submission_id`。RPC 是接收回执，canonical 事件按 `admission_id` 归属。附件沿用 ACP 文本封装。 |
| `TextDelta` / `ThoughtDelta` | `message.delta`、`message.token`、`message.interim` / `reasoning.delta`、`thinking.delta`、`reasoning.available` | 读取 `payload.text`。终态或接收回执可补上断流或未流式返回的末尾文本，历史读取从 transcript 返回持久行。 |
| `ToolCall` / `ToolCallUpdate` / `TodoUpdated` | `tool.start`、`tool.progress`、`tool.complete`、`todo.updated` | 使用 `tool_id`、`args`、`result`、`duration_s`、`todos`；历史工具行使用 `tool_call_id`。 |
| `PermissionRequest` 及应答 | Canonical `approval.request` → `approval.respond`；独立 dashboard `approval` 请求 → 同 ID 的 JSON-RPC 响应，旧通知 → `approval.respond` | 通过原审批回调发事件。Canonical 携带 `prompt_id` 和 `execution_generation`，旧通知携带 `request_id`。`allow_once → once`、`allow_session → session`（可用时）、`deny`／超时 → `deny`。响应限于当前审批，`request.cancel` 或 `approval.settled` 清理等待。 |
| `TokenUsage` / `ContextUsage` | `message.complete.usage`、`session.usage`、`session.stats` / `session.context_breakdown` | Gateway 完成事件中的用量通常是会话累计值，回合计数使用已知起止快照之差，canonical 丢帧恢复可用 `prompt.receipt` 的回合用量。 |
| `Completed` / `Failed` | `message.complete`；恢复时 `prompt.receipt` | `complete` → 完成，`interrupted` / `cancelled` → `Failed(cancelled)`，`error` → 失败；每个本地回合最多一个终态。 |
| `steer` | `session.steer(session_id,text[,execution_generation])` | 使用原生工具间插话，`queued` 表示已接收。忙时再次 `prompt.submit` 的队列行为与插话不同。 |
| `cancel` | `session.interrupt`；canonical 尚在队列的 admission 用 `prompt.cancel` | Canonical 中断带 `execution_generation`，队列取消带 `admission_id`。本地按 `run_id` / `request_id` 校验归属。 |
| 模型、思考强度 | `model.options`、`session.info`，canonical `session.mutate`，独立 dashboard `config.set` | Canonical mutation 使用 revision/generation 栅栏；独立 dashboard 设置指定会话的 `model` / `reasoning`。 |
| 重命名、删除、压缩 | Canonical `session.mutate`；独立 dashboard `session.title`、`session.close` + `session.delete`、`session.compress` | 保持既有节点返回结构。Cron 和附件中转继续使用既有 REST 契约。 |

## 3. 实现要求

### 3.1 连接与生命周期

- 连接 `ws://127.0.0.1:9119/api/ws`（端口从现有 agent-node 配置或环境变量读，写死 9119 作为默认值）
- 断线自动重连，指数退避（1s → 30s 上限），重连后拉一次 `session.transcript` 补状态
- 进程退出时优雅关闭

### 3.2 发消息与流

- `send_prompt`：发对应的 JSON-RPC 方法（调研确定）→ 把 `message.delta` / `reasoning.delta` / `thinking.delta` 映射成现有 `TextDelta` / `ThoughtDelta` 事件
- 工具调用、审批请求、用量、上下文占用等事件：从 transcript 或对应通知里提取，映射到现有事件类型（`ToolCall` / `ToolCallUpdate` / `PermissionRequest` / `TokenUsage` / `ContextUsage` …）
- run 结束判定：与 ACP 对齐（现有 `Completed` / `Failed` 语义）

### 3.3 steer（插话）

- 调研该通道运行中再发一条消息的行为；如果原生支持（第二条消息被当作 steer/redirect），直接复用
- 不支持则用「取消 + 带上下文重发」降级，但要在映射表里写明

### 3.4 审批

- 审批请求映射到 `PermissionRequest`；用户的批准/拒绝通过该通道的应答方法回传
- 语义必须和现有一致（含超时）

### 3.5 配置切换（重要：保留回滚）

`agent-node/config.json`（及配置加载处）新增：

```json
{ "hermes": { "transport": "ws" } }
```

- `transport: "ws"`（默认）→ 用 `HermesWsAdapter`
- `transport: "acp"` → 用现有 `HermesAdapter`（**代码保留，不删**）
- 环境变量 `STUDIOLO_HERMES_TRANSPORT` 可覆盖配置

daemon 按配置实例化对应 adapter，其余逻辑不动。

## 4. 交付门禁

```bash
cd agent-node && python -m pytest -q
cd .. && npx vue-tsc --noEmit -p tsconfig.json
npm run test:fleet
```

另加一个**真实连通冒烟**（可跳过但必须尝试）：

```bash
cd agent-node && python - <<'PY'
import asyncio, json, websockets
async def main():
    async with websockets.connect("ws://127.0.0.1:9119/api/ws") as ws:
        # 发一个最小 JSON-RPC（具体方法名按调研结果）
        await ws.send(json.dumps({"jsonrpc":"2.0","id":1,"method":"gateway.ping","params":{}}))
        print(await asyncio.wait_for(ws.recv(), 10))
asyncio.run(main())
PY
```

## 5. 禁止事项

1. 不删 `adapters/hermes.py`（ACP 路径必须保留可回滚）
2. 不改 daemon / Core / 前端的任何逻辑（只换 adapter 实现）
3. 不改 Hermes 本体（`~/.hermes/hermes-agent` 只读）
4. 不 commit、不改版本号

## 6. 交付格式

```markdown
## 协议映射表
| Studiolo 事件/方法 | /api/ws 方法/事件 | 备注 |

## 改动文件
- path:line — 一句话

## 冒烟结果
- 实际输出

## 门禁结果
- 命令 → 实际输出摘要

## 与 SPEC 的不一致 / 已知缺口
- 无 / 逐条说明

## 回滚方法
- …
```
