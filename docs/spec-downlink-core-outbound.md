# SPEC：下行链路「静默丢帧」根治（Core 出站 + 客户端续传）

## 背景（已实测确认，不是猜测）

- 22:22:14–22:29:13 期间，节点与 Core 都在正常收帧（Core 记录 1943 条 ThoughtDelta / 67 条 TextDelta），但手机一条都没渲染
- 同一窗口 Core **完全没有 SessionHistory**（客户端请求快照后从未真正发出）
- 根因链：
  1. `backend/app/fleet/hub.py:409-425` 客户端发送是**内联 await**，失败时**静默 pop**，不关闭 socket、不记日志 → 现象是"Core 有、手机没有、连接还在"
  2. `hub.py:411` 指定 target 不存在时**退化为全量广播**
  3. `src/stores/fleet.ts:2763` 有 pending 时 `subscribeSession()` 直接返回 true → 缺口帧被持续丢弃
  4. `src/stores/fleet.ts:1629` `sequence <= cursor → return`，游标被设高后实时帧永久丢弃
  5. `src/stores/fleet.ts:815/2799` 历史/快照请求**没有超时**，快照请求排在旧的历史请求后面，永不发出

## 总不变量（改动必须满足）

1. 任一节点帧：要么投递给目标客户端，要么让该客户端**被显式断开并记录原因**——不存在静默删除
2. 客户端收到的每一帧：要么被应用，要么进**有界缓存**等待补流——不存在直接丢弃
3. 任一请求（subscribe / history / context / list）都有超时；超时后释放等待状态并允许重试
4. 历史快照与运行态（active/runId）**分别对账**；"运行中"三个点只由消息 `streaming` 决定

## 阶段一（本次只做这个）：Core 出站

文件：`backend/app/fleet/hub.py`、`backend/app/fleet/routes.py`

1. **每客户端有界出站队列**：`asyncio.Queue(maxsize=256)` + 独立 writer task。
   节点接收循环只 `put_nowait`，**绝不再 `await ws.send_json`**（当前 `hub.py:417` 会让一个卡住的客户端阻塞整个节点接收循环和其他客户端）。
2. **发送超时 10 秒**；超时 / 异常 / 队列满 → `logging.warning`（带 client_id、原因、丢弃帧数）→ `await ws.close(code=1011)` → 从 `_clients` 注销。
3. **删除兜底广播**：`target_client_id` 不在 `_clients` 时不再退化为全量广播，改为跳过 + warning。
4. **审计语义修正**：`broadcast_node_event` 在发送前就把 `side=core` 写进审计（`hub.py:389`），导致"审计有 = 已送达"的误判。改为记录 `queued`/`dropped` 结果字段，或把审计挪到入队成功之后。

## 阶段二（本阶段禁止改动，下一轮再做）

`src/stores/fleet.ts` 的续传状态机（gap 缓冲、请求超时、快照抢占、游标单调、运行态对账）。

## 测试（必须自己跑，把结果贴出来）

新增 `backend/tests/test_fleet_hub_backpressure.py`，至少覆盖：

1. 一个"发送永不返回"的假 WS 客户端：**不阻塞**同一 workspace 里其他客户端的投递
2. 该客户端在超时后被 `close` 并从 `_clients` 移除，且产生 warning 日志
3. `target_client_id` 不存在时**不再**广播给所有人
4. 队列满时该客户端被断开，其他客户端不受影响

跑法：`cd backend && python -m pytest tests/test_fleet_hub_backpressure.py -q`（若仓库用别的 runner，按现有惯例来，并说明你用了什么）

## 禁止

- 不改协议字段名、不改帧结构（客户端不需要跟着改）
- 不动 `src/`、`src-tauri/`、`agent-node/`
- 不 commit、不 push、不重启任何服务
- 不为了让测试变绿而放宽断言或删用例

## 交付

- 列出改动文件与每处改动的意图
- 贴测试输出（真实输出，不要总结）
- 单独列出「与 SPEC 不一致 / 没做到 / 有风险」的条目
