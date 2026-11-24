# 任务书：P2 —— 快照与增量 API（节点提供，Core 透传）

> 前置：P0+P1 已提交（`fc7de16`）：`session_events.py`（EventStore + fold）、daemon 出站记录（`STUDIOLO_SESSION_EVENTS=1` 才启用）。
> 本轮目标：把「完整重放」能力暴露成两个 RPC，**hermes 走 gateway 原生序号，其它 provider 读本地库**。
> 仍然**不改客户端**（`src/` 不动），默认关闭。

## 一、要新增的两个 RPC

### 1. `session.snapshot`

请求：`{ sessionId, provider? }`
响应：
```json
{
  "sessionId": "…", "epoch": "…", "lastSeq": 123,
  "snapshot": { "messages": [...], "turns": [...], "notices": [...], "approvals": [...],
                "usage": {...}, "running": false, "runId": null, "lastSeq": 123 }
}
```

### 2. `session.events.since`

请求：`{ sessionId, epoch, lastSeq, limit? }`
响应：`{ sessionId, epoch, events: [信封数组], hasMore: bool }`

## 二、数据来源规则（关键）

| provider | epoch | 事件来源 | 说明 |
|---|---|---|---|
| **hermes** | gateway 的 `replay_epoch` | **直接代理 gateway 的 `session.events.since`** | 透传，不要改写 seq；本地库只作旁路记录 |
| codex / opencode / antigravity / … | 节点进程 epoch | `EventStore.events_since` + `fold` | 本地库是权威 |

实现要求：

- `epoch` 必须由**数据来源**决定，不能一律用节点 epoch。hermes 连接建立时从 `gateway.ready` 的 `replay_epoch` 取；节点重启导致该值为空时，回退到节点 epoch 并在响应里标注 `source: "node"`。
- `snapshot` 对 hermes 也优先走 gateway：若 gateway 提供快照/全量重放能力就用它，否则用「events.since(0) + fold」构造，**不得**从 transcript 反推。
- 两个 RPC 都必须带 `source: "gateway" | "node"` 字段，便于排查。

## 三、Core 侧

- 新增两条 RPC 路由，**原样转发**节点响应，不重新编号、不缓存、不改字段。
- 权限沿用现有 fleet node RPC 校验（node 归属 + workspace）。
- 固化一条约束并加测试：**Core 不得生成/改写会话事件序号**（可以断言响应里的 `epoch/seq` 与节点返回逐字段相等）。

## 四、开关

- 沿用 `STUDIOLO_SESSION_EVENTS=1`：关闭时两条 RPC 返回 `unsupported`（并保持现状行为）。
- 开启时**其余行为不变**，客户端照旧走老路径。

## 五、测试（真跑并贴输出）

agent-node：
1. `session.snapshot` 对三类 provider 都返回非空且 `lastSeq` 一致（用 P1 的 fixture + 临时库）
2. `session.events.since(0)` 后再 `since(lastSeq)` 为空
3. hermes 分支：用假 gateway（mock WS）验证 epoch 取自 `replay_epoch`、事件逐字段透传
4. 关闭开关 → `unsupported`

backend：
5. Core 透传：mock 节点返回值，断言响应与节点返回**逐字段相等**（尤其 epoch/seq）
6. 权限：非本 workspace 调用被拒
7. 既有 media/hub 测试全绿

## 六、禁止

- 不改 `src/`、`src-tauri/`
- 不 commit、不重启服务
- 不为了透传而在 Core 里缓存事件
- 不引入新依赖

## 七、交付

改动文件 / 真实测试输出 / 两类 provider 的重放对照（事件数、消息数、工具数、lastSeq）/ 「与任务书不一致 / 没做到 / 有风险」
