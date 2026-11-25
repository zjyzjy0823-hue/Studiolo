# 会话事件契约 v1

## 事件信封

| 字段 | 类型与约束 |
|---|---|
| `sessionId` | 必填，非空字符串。日志拥有者内唯一的会话标识。 |
| `epoch` | 必填，非空字符串。日志拥有者的生命周期标识。 |
| `seq` | 必填，正整数。从 1 开始，在每个 `(sessionId, epoch)` 内连续递增。SQLite 存储范围是 1 至 2⁶³−1。 |
| `turnId` | 必填键。回合事件使用非空字符串，同一回合内保持一致。会话级事件可为 `null`，包括 `session.created`、`session.running`、`notice`、`snapshot.ready`。 |
| `participantId` | 必填，非空字符串。单 agent 会话使用当前 provider，例如 `hermes`、`codex`、`opencode`。 |
| `type` | 必填，下表中的事件类型。 |
| `at` | 必填，非负整数。Unix 毫秒，节点日志取节点接收出站帧的时间。排序使用 `seq`。 |
| `payload` | 必填，JSON 对象。字段按事件类型解释。 |

信封只允许上表八个字段。**禁止新增 provider 特有的顶层字段，provider 扩展只能放在 `payload.meta`**。所有事件均可带可选的 `meta: object`。表中的可选字段缺失表示来源未提供该值。

## 事件与折叠规则

计划中的 14 组共 16 个事件类型，同组的思考与审批子类分别列在下表。时间和时长均为整数毫秒，token 数为非负整数。表里的 `JSON` 指任意 JSON 值，附件为 JSON 对象数组。

| 类型 | 必填 payload | 可选 payload | 折叠 |
|---|---|---|---|
| `session.created` | `provider: string` | `title: string`、`cwd: string` | 设置会话元信息，可用于重新打开已有会话。 |
| `turn.started` | `startedAt: integer` | — | 按信封中的 `turnId` 建立回合并记录开始时间。 |
| `turn.ended` | `status: "completed" \| "failed" \| "cancelled"`、`endedAt: integer` | `usage: {in?: integer, out?: integer, tps?: number}` | 更新回合终态。起止时间都存在时产生 `durationMs = endedAt - startedAt`。以最新终态的 usage 为准。 |
| `message.user` | `text: string` | `attachments: object[]` | 新增用户消息，可重放仅带附件的消息。 |
| `message.assistant.delta` | `text: string` | — | 创建该回合的 assistant 消息，按序追加文本。 |
| `message.assistant.completed` | `text: string` | `attachments: object[]` | 用最终文本覆盖增量结果，后续文本 delta 不再修改它。 |
| `thought.delta` | `text: string` | — | 在对应 assistant 消息按序追加思考。 |
| `thought.completed` | `text: string` | — | 用最终思考覆盖增量结果，后续思考 delta 不再修改它。 |
| `tool.call.started` | `callId: string`、`name: string` | `input: JSON`、`output: string`、`deltaOutput: string`、`durationMs: integer` | 在对应 assistant 消息中建立工具卡，初始状态为 `running`。同一 `(turnId, callId)` 复用一张卡。 |
| `tool.call.updated` | `callId: string`、`status: string` | `progress: JSON`、`name: string`、`input: JSON`、`output: string`、`deltaOutput: string`、`durationMs: integer` | 创建或更新工具卡。完整 `output` 覆盖已有输出，仅带 `deltaOutput` 时追加。已完成的卡忽略后续进度。 |
| `tool.call.completed` | `callId: string`、`ok: boolean` | `name: string`、`input: JSON`、`output: string`、`deltaOutput: string`、`durationMs: integer` | 创建或结束工具卡，`ok` 映射为 `completed` 或 `error`。工具的终态、结果和时长来自工具事件。 |
| `approval.requested` | `requestId: string` | `command: string`、`risk: string` | 按 `(turnId, requestId)` 建立审批记录。 |
| `approval.resolved` | `requestId: string`、`decision: string` | — | 设置审批决定，例如 `allow_once`、`allow_session`、`deny`。 |
| `session.running` | `running: boolean` | `runId: string` | 设置会话运行态。停止后快照清除 `runId`。 |
| `notice` | `level: string`、`text: string`、`source: string` | — | 按序追加到 `notices`。系统通知不会进入用户或 assistant 消息。 |
| `snapshot.ready` | `upToSeq: integer`（非负） | — | 记录快照边界。该事件自身的序号仍计入 `lastSeq`。 |

`fold(events)` 接收一个会话、一个 epoch 的事件。它根据 `seq` 排序，同键重复项只应用一次，同键内容应一致。每个回合有一个 assistant 消息投影，可由文本、思考或工具事件建立。空输入得到空消息、空回合、`running=false` 和 `lastSeq=0`。`lastSeq` 为应用过的最大序号。会话级 usage 对每轮最终已知的 `in` 和 `out` 求和。速率保留在各自回合中。

`fold` 无 I/O，回放同一前缀得到相同的投影。一份可继续折叠的快照需要保存折叠状态，包括已完成的文本标记和按回合归属的工具状态。P0/P1 提供对事件全量折叠的视图，快照与续传 API 随 P2 定义。

## 所有权与持久化

| 日志拥有者 | epoch | seq |
|---|---|---|
| Hermes gateway，原生回放 | 由 gateway 的 `replay_epoch` 和可读窗口派生 | 按归一化后的事件顺序连续编号。已使用契约信封的 gateway 保留原有 epoch 和 seq。 |
| 节点，记录兼容出站帧 | 节点进程启动 UUID | 节点按会话分配。同一兼容帧映射的多个事件在一个 SQLite 事务内提交。 |

epoch 切换时客户端丢弃旧游标，从拥有者重新拉快照。SQLite 中的既有 epoch 仍可单独读取。

SQLite 主键 `(session_id, epoch, seq)` 同时提供唯一索引和范围查询索引。重复 `append` 返回 `False`，已提交的事件内容优先。读取以 `seq > last_seq` 为边界，按升序返回默认最多 500 条。清理删除 `at < before_ts` 的事件，不重用已分配的序号。开启记录时，匹配的帧要等事务提交再发送。SQLite 写入运行在线程中。一次事务失败后不发送对应帧。

## P1 兼容出站帧映射

节点启动环境仅在 `STUDIOLO_SESSION_EVENTS=1` 时启用记录，默认数据库路径为 `~/.hermes/studiolo-node/session_events.db`。数据库在首次需要写入时创建。兼容帧保持现有线协议。

| 现有帧或出口上下文 | 事件 | 规则 |
|---|---|---|
| `SessionOpened` | `session.created` | 使用返回的会话元信息。 |
| `Accepted`，附带 daemon 的 prompt 上下文 | `turn.started` → `message.user` → `session.running` | 使用回合 ID 和原始文本。附件保留标识、文件名、MIME 和大小。 |
| `TextDelta` / `TextCompleted` | `message.assistant.delta` / `message.assistant.completed` | 使用文本字段。Hermes 空闲监听的 `idle` 文本映射到 `notice`。 |
| `ThoughtDelta` / `ThoughtCompleted` | `thought.delta` / `thought.completed` | 使用文本字段。 |
| `ToolCall` | `tool.call.started` | 兼容帧带有终态时映射到 `tool.call.completed`。 |
| `ToolCallUpdate` | `tool.call.updated` / `tool.call.completed` | 进行中帧更新状态及进度。终态 `completed` 为成功，`error`、`failed`、`cancelled`、`canceled`、`denied` 为失败。 |
| `PermissionRequest` / `ApprovalRequest` | `approval.requested` | 使用 `callId` 或 `requestId`。 |
| 节点审批决定（内部 `ApprovalResolved`） | `approval.resolved` | 包括节点审批超时的拒绝。在给适配器返回决定前记录。 |
| `TokenUsage`，`scope=turn` | 合入 `turn.ended.payload.usage` | 暂存该回合最后已知的字段。累计值和上下文占用不计入该回合。 |
| `Completed` / 回合内 `Failed` | `turn.ended` → `session.running` | 如果帧有最终文本，先写 `message.assistant.completed`。回合失败还会写 `notice`。 |
| `SessionRunning` | `session.running` | 使用明确的运行态值，当前发送路径也用 `Accepted` 和回合终态发出运行态事件。 |
| `Notice` / 无回合的 `Failed` | `notice` | 使用来源、级别和文本。 |
| `SessionStreamReplay`、历史、文件、传输和控制帧 | — | 旧协议回放和控制响应不进入日志。P1 未产生 `snapshot.ready`。 |

当前 Hermes WS 适配器用原生 `replay_epoch` 和序号处理 gateway 重放，出站兼容帧可能由一条原生事件展开成多帧，也可由 daemon 本地生成。P1 对这些帧使用节点 epoch。Hermes 快照和增量通过下述映射提供契约数据。现有兼容帧没有提供的工具时长、最终文本和回合用量保持缺省。只收到文本 delta 的回合保留以 delta 累积的文字。录制开始前的历史、外部发起的 Hermes 回合、以及未发出独立会话事件的控制或插话动作，不在 P1 的重放覆盖范围内。

## Hermes gateway 原生回放映射

Hermes WS 的 `session.snapshot` 先按 gateway 的行顺序分页读取 `GET /api/sessions/{storedId}/messages`，再以运行时会话 ID 读取 `session.events.since` 的可用窗口。两路数据使用 P1 的 `fold` 投影为快照。响应内外的 `lastSeq` 都取归一化事件窗口的游标，窗口为空时为 0。`session.events.since` 继续只读取并返回事件，旧游标不属于当前窗口时返回 `snapshotRequired: true`。

- 有最终 assistant 行的已完成回合以 transcript 为准。相同回合的事件被剔除，保留会话级事件和原事件游标。发起工具调用的中间 assistant 行归入当前回合。
- 事件窗口中仍在运行或 transcript 未提供终态的回合按事件首次出现的顺序追加。正在运行的回合沿用事件的 `turnId`、`running` 和 `runId`。
- 对齐优先使用显式 `turnId` 或 `turn_id`。无标识的 transcript 回合按最终 assistant 行的顺序生成 `t1`、`t2` 等标识。用工具调用 ID、最终 assistant 文本或窗口中残留的用户消息按顺序查找重叠；完全相同的候选优先取保留窗口后部。时间戳不参与排序或对齐。
- `role="tool"` 或带 `tool_call_id` 的结果行映射为 `tool.call.completed`。快照工具卡缺失的 `durationMs` 为 `null`，明确的 `0` 保留。历史回合缺失的起止时间为 `null`。
- 去重键为 `(turnKey, role, callId|textHash)`，消息文本用 SHA-256，工具使用调用 ID。同键冲突保留 transcript 版本。同一回合内重复出现的 transcript 键保留首次记录。

所有 provider 的快照响应都带 `incomplete`。Hermes 的 `/messages` 不可用时仍返回纯事件快照，并标注 `incomplete: true`。gateway 事件窗口有缺失、或 Hermes 没有 gateway replay epoch 而使用节点旁路事件日志时，也标注 `incomplete: true`。旧协议 `SessionStreamReplay` 沿用原有历史和重放路径。

## P10 传输窗口与 Hermes resume 缓存

- `session.snapshot` 与 `session.history` 默认只传输最近 **40 轮 / 最多 120 条消息**，严格按回合边界裁剪，不删除任何持久数据或 transcript；`session.events.since` 保持不变。
- 运行中的回合始终完整包含在最新窗口内（即使该回合超过 120 条消息）。
- `session.snapshot` 响应顶层新增 `hasMoreBefore: boolean` 与 `beforeCursor: string | null`（指向窗口首条消息的稳定游标，优先 `id:<id>`、其次 `turn:<turnId>`、否则 `idx:<index>`）。`session.history` 默认调用同步返回 `hasMoreBefore` 与 `beforeCursor`（旧客户端 `pagination: true` 模式保留 `beforeCursor` 回显与 `historyCursor` 下一页游标，同时新增 `hasMoreBefore`）。
- 新增 RPC `session.older`（接受 `{session_id, before_cursor, limit}` 或驼峰字段 `{sessionId, beforeCursor, limit}`），按游标向前翻更早一页，返回与 `session.snapshot` 相同结构；游标无效时返回 `code: "invalid_cursor"`。
- Hermes WS 适配器的 `session.resume` 在进程内按连接与会话缓存 **5 分钟**（300s），同一会话并发请求共享同一个在飞 Future 去重；单次 `session.resume` 超时由 30s 降至 **5s**，超时抛出 `ResumeTimeoutError` 并返回明确错误码 `session_resume_timeout`（不静默返回空数据）。

### 信封字段

| 契约字段 | 取值 |
|---|---|
| `sessionId` | 节点 RPC 的会话 ID。gateway 运行时的 `session_id` 仅用于读取原生回放。 |
| `epoch` | 原生回放使用 `hermes-v1:<replay_epoch>`。窗口有前缀或内部缺口时附加缺失区间的摘要。窗口变化会使旧游标触发重拉。 |
| `seq` | 按原生 `seq` 排序，从 1 连续编号。同一原生帧展开的多条事件各占一个序号。分页的 `limit` 按契约事件计数。 |
| `turnId` | 优先取 `admission_id`。缺省时使用当前回合、新回合的 `payload.turn_id` 或 `execution_generation`。仍缺失时，用该回合首条有效帧的原生序号生成 `turn-<seq>`。会话级事件为 `null`。 |
| `participantId` | 固定为 `hermes`。 |
| `at` | 原生 `at` 中有效的 Unix 毫秒。缺失时记为 0。回合的开始或结束时间为 0 时，快照中对应时间为 `null`，只在两端时间都已知时计算时长。 |
| `type`、`payload` | 按下表构造。 |

### 原生类型与 payload

| 原生 type | 契约 type | 字段对应关系 |
|---|---|---|
| `session.info` | `session.created` | 有字符串 `cwd` 或 `title` 时输出会话元信息，`provider` 为 `hermes`。节点暂存 `pending` 中按 `admission_id` 索引的原始提示词，等对应回合开始时使用。 |
| `message.start` / `turn.started` | `turn.started` → 可选 `message.user` → `session.running` | `started_at` → `startedAt`，缺失时用 `at`。仅 `message.start` 可同时输出用户消息，优先用当前帧的 `text`，其次用前序 `session.info.pending` 中与本次 `admission_id` 匹配的 `text`。运行态写入 `running: true`、`runId: turnId`。 |
| `message.user` | `message.user` | 取 `text` 和附件。附件保留契约字段 `artifactId`、`fileName`、`mime`、`mimeType`、`size`、`sizeBytes`，其中小驼峰字段也接受对应的下划线字段。 |
| `message.delta` / `message.token` / `message.interim` | `message.assistant.delta` | 取非空的 `text`，跳过 `already_streamed` 和空分段边界。 |
| `reasoning.delta` / `thinking.delta` / `reasoning.available` | `thought.delta` / `thought.completed` | 取非空的 `text`。仅 `reasoning.available` 映射为完成。 |
| `message.complete` / `turn.ended` | 可选 `message.assistant.completed` → 可选 `thought.completed` → `turn.ended` → `session.running` | `message.complete` 的 `text`、附件按消息字段处理，`response_reused` 或 `response_previewed` 时跳过最终文本。`reasoning` → 思考 `text`。`ended_at` → `endedAt`，缺失时用 `at`。`status` 或 `outcome` 归为 `completed`、`cancelled` 或 `failed`。`turn_usage.input/output` → `usage.in/out`。最后写入 `running: false`。 |
| `tool.start` | `tool.call.started` | `tool_id` 或 `tool_call_id` → `callId`，`name` 或 `tool_name` → `name`，`args` → `input`。 |
| `tool.progress` | `tool.call.updated` | 同样映射工具标识、名称和参数。`progress` → `progress`，`message` → `deltaOutput`，`status` 为 `running`。 |
| `tool.complete` | `tool.call.completed` | 同样映射工具标识、名称和参数。用 `result_text`、`result` 或 `summary` 依次确定 `output`，非字符串结果序列化为 JSON 文本。`error`、`is_error` 或 `result.error` 为真时 `ok` 为 false。`duration_s` → 整数 `durationMs`。 |
| `approval.request` / `approval.settled` | `approval.requested` / `approval.resolved` | `prompt_id` → `requestId`。请求只取字符串 `command`、`risk`。结算取 `choice` 或 `decision`，`once` / `session` → `allow_once` / `allow_session`。 |
| `notice` | `notice` | `text` 或 `message` → `text`，默认 `level: "info"`、`source: "hermes"`。 |
| `todo.updated`、`session.usage` 和其他未列出的控制帧 | — | 不产生契约事件。会话累计用量不计作回合用量。 |

## 契约样本

`agent-node/tests/fixtures/session_events/` 中的三份 JSONL 各取一轮已完成的历史会话。来源分别为 Hermes `state.db`、Codex rollout JSONL 和 OpenCode `opencode.db`。生成时把历史记录归一成兼容帧，经 daemon 出站口写入临时数据库，再用 `events_since` 导出。会话及调用 ID 已替换，正文与工具输出已脱敏，信封的 `at` 为样本时间。原始历史没有保留流式分块，也没有统一提供工具时长。样本保留可读取的回合时间、工具调用数量、工具名及已知时长。

`agent-node/tests/fixtures/session_events/hermes-native.json` 来自 Hermes `3b42157858` 的 `AuthorityConnection` 真正执行 `session.events.since` 的响应。采集时使用隔离状态目录和确定性的回复回调，由原生 authority 发出回合事件并使用 gateway 的工具事件构建函数。样本使用测试文字，回放与入队 ID 已固定。该样本的原生帧没有时间戳，也没有工具时长。

`agent-node/tests/fixtures/session_events/hermes-transcript.json` 取自本机 Hermes `state.db` 的一个真实回合，保留 user、assistant、tool 的行顺序、结束原因和工具引用关系。ID、时间戳、消息正文、工具名、参数和结果使用脱敏样本值。测试通过 HTTP 和 WebSocket 替身验证分页、合并和降级行为。
