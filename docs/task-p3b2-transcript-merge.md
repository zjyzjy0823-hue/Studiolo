# 任务书：P3b-2 —— hermes 快照 = transcript + 事件尾巴（去重合并）

## 一、真机证据（2026-11-24 19:1x，0.9.3 epoch）

| 项 | 结果 |
|---|---|
| 「用时未记录」占位 | 0（P3b-1 修好了） |
| 助手文本 | ✅ 有 |
| **用户消息气泡** | ❌ 0 |
| **工具调用卡片** | ❌ 0 |

结论：**归一化对了，但数据源不够**。`session.events.since` 是重连重放缓冲，不是完整历史；
超出窗口的用户消息与工具行拿不回来。

## 二、目标

hermes 的 `session.snapshot` 改为**双源合并**：

```
transcript（gateway /api/sessions/{id}/messages，完整历史）
   + events.since(lastSeq)（实时尾巴）
   → 去重 → 契约 Snapshot
```

`session.events.since`（增量接口）保持不变：只返回事件，供断线续传使用。

## 三、合并规则（必须按这个来，避免重复/错序）

1. **已完成回合以 transcript 为准**
   transcript 里出现过的 `turn`（有对应 assistant 完成行）→ 该 turn 的消息与工具**只取 transcript 版本**，忽略事件流里同一 turn 的事件。
2. **运行中的回合以事件为准**
   transcript 里没有、或该 turn 仍在 `running` 状态 → 用事件流折叠出来的结果。
3. **turn 标识对齐**
   transcript 行没有 `turnId` 时，用「同一会话内 assistant 完成行的顺序」生成稳定 turn 序号（如 `t1,t2,…`），并让事件流里未完成 turn 追加在其后。**不得**用时间戳排序。
4. **工具调用**
   transcript 的工具行（`role="tool"` / `tool_call_id` 存在）映射为 `tool.call.completed`；
   缺 `durationMs` 时字段留空（**不要填 0**，UI 需要区分"没记录"和"0 毫秒"）。
5. **去重键**
   以 `(turnKey, role, callId|textHash)` 为键；同一键保留 transcript 版本。

## 四、实现位置

- `agent-node/agent_node/adapters/hermes_replay.py` 增加「transcript 折叠」能力（可复用 `hermes_ws.py` 里已有的 `_transcript_history`，但**不要**改动 legacy 路径行为）
- `daemon.py` 的 `session.snapshot` 分支：hermes → 先取 transcript，再取事件尾巴，按上面规则合并
- gateway 不支持 messages 接口时：退化为纯事件版，并标注 `incomplete: true`

## 五、测试（真跑并贴输出）

1. **transcript 折叠**：给定含 user/assistant/tool 行的真实样本 → 快照里用户消息数、工具数正确
2. **合并去重**：transcript 与事件流含同一个已完成 turn → 结果只出现一次
3. **运行中回合**：transcript 无、事件流有 → 该 turn 出现在末尾且 `running: true`
4. **工具缺 durationMs** → 字段为 `null` 而不是 0
5. **messages 接口不可用** → `incomplete: true` 且仍返回 transcript 之外的事件内容
6. 回归：agent-node 全量（沙箱端口测试失败需说明）

## 六、禁止

- 不改 `src/`、不改 legacy 重放路径的行为（`SessionStreamReplay` 相关）
- 不改契约字段
- 不 commit、不重启服务

## 七、交付

改动文件 / 真实测试输出 / 合并规则实现说明（特别是去重键）/ 「与任务书不一致 / 没做到 / 有风险」
