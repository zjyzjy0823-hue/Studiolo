# 任务书：P9a（重写版）—— 走 gateway 原生接口，不要解析事件

## 零、先看这一节（上一版任务书作废的原因）

上一版让 `fold()` 从事件里解析 `proc_xxx` / `deleg_xxx`，**方向错了**。
Hermes Mobile 不是这么接的，它直接调 gateway 原生 RPC：

- `process.list` → `{processes: [...]}`，`process.kill` 终止
- `subagent.list` → `{subagents: [...], delegations: [...]}`

已实测可用（下面的形状都是真机抓的，不要改字段名）。

## 一、实测到的调用方式（关键坑）

```
session.resume {session_id: "<UI 会话 id>"}   → 返回 {session_id: "94d958c5", session_key: "<UI id>", ...}
process.list  {session_id: "94d958c5"}        → 用 resume 返回的 session_id，不是 UI id
subagent.list {session_id: "94d958c5"}        → 同上
```

**用 UI 会话 id 直接调会返回 `session not found`**，必须用 resume 返回的运行时 `session_id`。

实测返回：

```json
{"processes": [{"session_id": "proc_b1ac97ab3ee8",
  "command": "cd /Users/zjy/Projects/Nexa-LumaDock && adb install -r ...",
  "cwd": "/Users/zjy/Projects", "pid": 35741, ...}]}
```

```json
{"subagents": [], "delegations": []}
```

## 二、要做的（agent-node 代理）

1. `agent_node/adapters/hermes_ws.py`：
   - 新增 `async def processes(self, session_id: str) -> dict`：先确保 session 已 resume（复用现有 `_session`/`_resume` 拿到运行时 id），再 `conn.call("process.list", {"session_id": <runtime_id>})`
   - 新增 `async def subagents(self, session_id: str) -> dict`：同上，调 `subagent.list`
   - 两者失败时抛 `ProviderError`，**不要**退化成空列表（客户端需要区分"没有"和"取失败"）
2. `daemon.py`：新增两个 RPC
   - `session.processes`（参数 `{session_id}`）→ `{processes: [...], provider: "hermes"}`
   - `session.subagents`（参数 `{session_id}`）→ `{subagents: [...], delegations: [...], provider: "hermes"}`
   - provider 不支持时返回 `{unsupported: true}`，不报错
3. `backend/app/fleet/routes.py`：加两个透传路由（与 `session/snapshot` 同样写法）
   - `POST /api/v1/fleet/nodes/{node_id}/session/processes`
   - `POST /api/v1/fleet/nodes/{node_id}/session/subagents`

## 三、硬约束

- **不许**解析事件文本、不许在 fold() 里加 processes/subagents
- 不许改 `session.snapshot` 现有结构
- 不许改 `src/`
- 不许 commit、不许重启服务

## 四、测试（真跑并贴输出）

1. `processes()` 用运行时 id 调用（用假 connection 断言收到的是 resume 返回的 id，不是 UI id）
2. resume 未就绪时先 resume 再调用
3. `subagents()` 同样断言
4. daemon RPC：`session.processes` / `session.subagents` 正常与失败两条路径
5. provider 不支持 → `{unsupported: true}`
6. Core 路由透传测试（与 snapshot 路由同风格）
7. 全量：agent-node（沙箱端口测试失败需说明）、backend 相关测试

## 五、交付

改动文件 / 真实测试输出 / 一次真实调用结果（用当前会话，把 processes 里的 command 截断到 60 字符）/ 「与任务书不一致 / 没做到 / 有风险」
