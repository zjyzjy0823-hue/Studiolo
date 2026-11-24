# 任务书：P0 + P1 —— 会话事件契约与节点事件库

> 给 Codex（gpt-6.2-sol / high）。先读 `docs/plan-session-layer-rebuild.md` 的「五条不变量」和「契约草案」，再动手。
> 本轮**只改 agent-node**，不碰 `src/`、`backend/`。默认关闭，不影响现有行为。

## 一、交付物

### 1. `docs/spec-session-events.md`（正式契约）

把计划文档第二节落成正式规格，必须包含：

- 事件信封字段与类型约束（`sessionId/epoch/seq/turnId/participantId/type/at/payload`）
- 事件类型清单（计划里那 14 种）与每种的 `payload` 字段、必填/可选
- `epoch` 语义（gateway 透传用 `replay_epoch`；节点自有时用进程启动 UUID）
- 幂等规则：`(session_id, epoch, seq)` 唯一
- 折叠规则：每种事件如何影响快照（新增消息 / 更新工具状态 / 累加 usage / 设置 running）
- **明确禁止**：provider 特有信息不得新增顶层字段，只能进 `payload.meta`

### 2. `agent-node/agent_node/session_events.py`

- `EventStore`：SQLite 实现
  - 表：`session_events(session_id TEXT, epoch TEXT, seq INTEGER, turn_id TEXT, participant_id TEXT, type TEXT, payload TEXT, at INTEGER, PRIMARY KEY(session_id, epoch, seq))`
  - 索引：`(session_id, epoch, seq)`
  - 方法：`append(event) -> bool`（重复返回 False，不抛错）、`events_since(session_id, epoch, last_seq, limit=500)`、`max_seq(session_id, epoch)`、`prune(before_ts)`
  - 默认路径 `~/.hermes/studiolo-node/session_events.db`，可通过构造参数覆盖（测试用 tmp_path）
- `fold(events) -> Snapshot`：**纯函数，不碰 IO**
  - 输出：`messages`（含 `text/thought/toolCalls/attachments`）、`turns`（含 `startedAt/endedAt/usage`）、`running`、`lastSeq`
  - 折叠规则必须能处理：乱序输入（按 seq 排序）、重复事件、`delta` 累积后与 `completed` 对齐（以 completed 为准）

### 3. `agent-node/tests/test_session_events.py`

至少覆盖：

1. 信封校验：缺字段 / seq 非正 / 未知 type → 拒绝
2. 幂等：同一 `(session, epoch, seq)` 写两次，库内 1 条
3. `events_since` 边界：`last_seq=0` 全量、等于 max 时为空、跨 epoch 不串
4. fold：一轮带 2 个工具调用的完整对话 → 工具卡片的 name/status/output/durationMs 正确
5. fold：`delta` 拼接 + `completed` 覆盖（completed 优先，不重复）
6. fold：`notice` 不进 messages，单独进 notices
7. fold：`turn.started/ended` 生成用时（endedAt - startedAt）
8. fold：乱序 + 重复输入结果与有序输入一致
9. epoch 切换：`max_seq` 分 epoch 独立

### 4. 接入（默认关闭）

- 环境变量 `STUDIOLO_SESSION_EVENTS=1` 时才启用
- 写入点放在 **daemon 的统一出站出口**（所有 provider 的帧都经过那里），不要在 5 个 adapter 里各写一遍
- 把现有帧（`TextDelta` / `ToolCall` / `ToolCallUpdate` / `ApprovalRequest` / `SessionRunning` 等）**映射**成契约事件；映射表写进 spec 文档
- 关闭时（默认）**不得有任何行为变化**，也不得创建数据库文件

## 二、硬约束

- 不改 `src/`、`backend/`、`src-tauri/`
- 不改现有测试断言来迁就新代码
- 不 commit、不重启服务、不打包
- 不引入新依赖（SQLite 用标准库 `sqlite3`）
- 性能：`append` 单次 < 1ms（本地 SSD 量级），不得在事件循环里做同步大写入——用 `asyncio.to_thread` 或独立写入队列

## 三、验收（必须真跑并贴输出）

```
cd agent-node && ../.venv/bin/python -m pytest tests/ -q
```

- 新增用例全绿
- 既有 106 项全绿（已含 alist / media / steer）
- 一次真实会话验证：开启 `STUDIOLO_SESSION_EVENTS=1` 跑一轮带工具的对话，然后写个临时脚本从库里 `events_since` 全量读出并 `fold`，打印出的消息数与工具调用数要和实际一致（把输出贴出来；脚本放 `/tmp`，不要进仓库）

## 四、交付说明

用中文列出：

1. 改动/新增文件与理由
2. 真实测试输出
3. 帧 → 事件的映射表
4. 「与任务书不一致 / 没做到 / 有风险」
