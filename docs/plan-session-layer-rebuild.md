# 会话层重建计划（v1，待拍板）

> 目标：把「会话事件的所有权」重新划定，让状态只有一份、可重放、可投影。
> 范围：客户端状态层 + agent-node + Core。**不动 UI 组件、Rust 壳、鉴权、下载链路、多节点支持。**
> 执行方式：交给 Codex（gpt-6.2-sol / high）实现，主 agent 逐阶段 review 与真机验收。不按人日排期，按阶段交付。

---

## 一、五条不变量（所有工作围绕这五条验收）

1. **唯一编号者**：`(session_id, epoch, seq)` 只由日志拥有者生成，单调、无空洞。
2. **先落库再发出**：事件持久化成功后才转发；消费端幂等（重复帧不产生重复消息）。
3. **快照 = 折叠**：任何客户端拿到「快照 + seq>N 的增量」必须重建出完全相同的视图。
4. **显示态只能来自事件**：用时、工具状态、运行中、token 用量，一律由事件携带；客户端不得自行计算或推断。
5. **系统消息独立通道**：`notice` 类型永不进入 user/assistant 消息流。

---

## 二、契约草案（P0 产出物）

### 2.1 事件信封

```json
{
  "sessionId": "…",
  "epoch": "…",          // 日志拥有者的进程生命周期标识
  "seq": 12345,          // 该 epoch 内单调递增
  "turnId": "…",         // 一次用户请求 → 一轮回复
  "participantId": "hermes|codex|opencode|…",
  "type": "tool.call.completed",
  "at": 1795590000123,
  "payload": { }
}
```

`participantId` **第一天就要有**（多 agent 协作的地基），单 agent 会话里恒为当前 provider。

### 2.2 事件类型（最小集合）

| 类型 | 关键字段 | 用途 |
|---|---|---|
| `session.created` | title, provider, cwd | 会话元信息 |
| `turn.started` | turnId, participantId, startedAt | 一轮开始（用时的起点） |
| `turn.ended` | turnId, status, endedAt, usage{in,out,tps} | 一轮结束（用时/token 的终点） |
| `message.user` | text, attachments | 用户消息 |
| `message.assistant.delta` | text | 流式增量 |
| `message.assistant.completed` | text | 终态（替代 delta 折叠结果） |
| `thought.delta` / `thought.completed` | text | 思考内容 |
| `tool.call.started` | callId, name, input | 工具调用开始 |
| `tool.call.updated` | callId, status, progress | 进度 |
| `tool.call.completed` | callId, ok, output, durationMs | 结束（**工具卡片的唯一来源**） |
| `approval.requested` / `approval.resolved` | requestId, decision | 审批 |
| `session.running` | running, runId | 运行态（插话依据） |
| `notice` | level, text, source | 系统通知（后台完成、重连、错误） |
| `snapshot.ready` | upToSeq | 快照边界 |

字段命名一旦定下，**所有 provider 共用**；provider 特有的信息只能进 `payload.meta`，不得新增顶层字段。

### 2.3 epoch 语义

| 拥有者 | epoch 取值 | 何时更换 |
|---|---|---|
| gateway（hermes 透传） | gateway 的 `replay_epoch` | gateway 重启 |
| 节点（CLI 类 provider） | 节点进程启动 UUID | 节点重启 |

换 epoch 的唯一后果：客户端**丢弃本地游标、重新拉一次快照**。快照来自库，所以不丢数据。

---

## 三、阶段计划

### P0 · 契约与测试骨架

- 写 `docs/spec-session-events.md`（上面第二节的正式版）
- 纯函数 `fold(events) → snapshot`，配套**契约测试**（事件序列 → 期望快照）
- 产出 3 份真实会话 fixture（hermes / codex / opencode 各一）

**验收**：`fold` 的测试全绿；三种 provider 的 fixture 都能折叠出包含工具调用的完整视图。
**回滚**：纯新增，无影响。

### P1 · 节点事件库

- SQLite 表 `session_events(session_id, epoch, seq, turn_id, participant_id, type, payload, at)`
- 所有适配器产出的事件先落库再转发（写点在 daemon 的统一出口，不在每个 adapter 里）
- 幂等：`(session_id, epoch, seq)` 唯一索引

**验收**：跑一轮真实对话（含工具），直接查库能 replay 出完整 turn；杀节点重启，库里的数据完整。
**回滚**：只加写入，不影响现有链路。

### P2 · 快照与增量 API

- 节点提供：`session.snapshot(sessionId)` / `session.events.since(sessionId, epoch, lastSeq)`
- hermes 适配器：直接代理 gateway 的 `session.events.since`
- CLI 类适配器：从本地库读
- Core：透传这两个方法，不改语义

**验收**：用脚本从 `(epoch, 0)` 拉完整个会话，与真实会话逐事件比对一致。
**回滚**：新增 API，旧路径不变。

### P3 · 序号归一

- Core 停止生成 fleet 自己的 stream/seq；客户端改用 `(epoch, seq)` 续传
- **双协议**：Core 同时保留旧 stream（供 ≤0.9.0 客户端），按能力协商分流
- 客户端：删除帧缓冲/游标对账/快照抢占三套补丁，改为「拉快照 + 追增量」

**验收**：随机断网 30 次（脚本），每次重连后视图与真实会话一致；不重复、不缺失。
**回滚**：客户端加开关 `projection=off` 回到旧路径。

### P4 · 客户端投影 + 本地库

- 客户端持久化：IndexedDB（Tauri WebView 支持）存 `messages/turns/toolCalls/usage`
- 启动流程：**先渲染本地库** → 再拉增量 → 静默校正
- 用时、工具卡片、运行态全部读事件折叠结果，不再算
- `fleet.ts` 拆三块：`transport`（连接/重连/游标）、`projection`（事件→状态）、`outbox`（发送队列）

**验收**：冷启动 1 秒内出历史；杀进程重进，工具调用与用时完整。
**回滚**：开关切回内存投影。

### P5 · 连接健康

- 心跳 15s（应用层 ping）、60s 无活动判陈旧、换网络先 5s 活性探测
- 「重连中」仅在真断时出现；恢复后不闪屏

**验收**：手机 WiFi ↔ 5G 反复切换 10 次，不出现「重连」提示，消息不丢。
**回滚**：心跳可单独关。

### P6 · 系统通知独立

- 网关侧：后台任务完成等系统消息改写成 `notice` 事件（不再以 user 角色入库）
- 客户端：`notice` 渲染为系统条（灰底、居中、无头像）

**验收**：后台任务完成，客户端显示系统条而不是用户气泡。
**回滚**：客户端按类型降级渲染。

### P7 · 插话归一

- 直接 `session.steer`（hermes）/ provider 原生中断语义
- 删除 `_active_runs` 自建运行态；运行态只信 `session.running` 事件
- 失败回执语义化：`unsupported` / `idle` / `not_redirected`

**验收**：后台任务发起的长回合中插话成功；空闲时插话降级为普通发送且不报错。
**回滚**：保留旧分支，按 provider 开关。

### P8 · 删补丁与回归

- 删除：帧缓冲、快照抢占、`sameTurnContent` 指纹回退、`external-` 合成 runId、`_active_runs`
- 回归：前端全量测试、后端测试、真机三件套

**验收**：代码量净减少；测试全绿；真机验收表全过。

---

## 四、里程碑（你什么时候能看到效果）

| 里程碑 | 覆盖阶段 | 你能观察到 |
|---|---|---|
| **M1** | P0–P1 | 后台已能完整重放会话（行为暂不变） |
| **M2** | P2–P3 | 断网重连不丢消息（真机上可测） |
| **M3** | P4–P5 | 杀进程重进：工具调用、用时都在；不再乱显示重连 |
| **M4** | P6–P8 | 系统通知不再冒充用户；插话可靠；补丁代码删除 |

---

## 五、你的抱怨 → 验收对照

| 你遇到的问题 | 由哪个阶段修 | 真机验收动作 |
|---|---|---|
| 工具调用不显示 | P1 + P4 | 杀进程重进同一会话，工具卡片仍在 |
| 用时「未记录」 | P4 | 冷启动打开历史会话，用时完整 |
| 老是显示重连 | P5 | WiFi ↔ 5G 切换 10 次，无重连提示 |
| 不该出现的消息 | P6 | 后台任务完成 → 系统条，非用户气泡 |
| 插话丢对话 | P7 | 长任务中插话成功 |
| 退出回来记录没了 | P4 + 服务端下载记录表（P4 附带） | 清 App 数据后重新登录，记录仍在 |
| 丢对话 | P3 + P4 | 随机断网脚本 30 轮，视图一致 |

---

## 六、分工建议

| 工作 | 谁做 |
|---|---|
| 契约文档、`fold`、节点事件库、API、Core 透传、客户端投影 | **Codex（gpt-6.2-sol / high）** 按阶段任务书实现 |
| 契约与 diff 复核、测试复跑、真机验收 | 主 agent（我） |

**关键纪律**：每阶段先写测试再改代码；每个 PR 必须附「不变量对照」（哪条不变量被这条改动影响）。

---

## 七、明确不做（防范围蔓延）

1. 不重做 UI/视觉；不动 Rust 壳与打包。
2. 不改鉴权、下载链路、AList 集成、多节点路由策略。
3. 不在本轮实现「C 模式（同会话多 agent 并发写）」——**只在契约里留 `participantId` 位置**。
4. 不做跨节点会话合并。
5. 不为兼容旧客户端无限期保留双协议：**双协议最多保留两个版本周期**。

---

## 八、主要风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 客户端 `fleet.ts` 重写引入回归 | 高 | 投影层与旧逻辑**并行跑**一版（双读比对），一致后再删旧 |
| 双协议期数据不一致 | 中 | 只允许一个写入者；旧路径只读不写 |
| CLI 类 provider 事件保真度低 | 中 | 契约字段 optional；UI 优雅降级，不显示「未记录」 |
| 迁移期用户（你）感知到抖动 | 中 | 每阶段带开关；先在自己手机上灰度一周 |
| 需求漂移（又想顺手做别的） | 高 | 本文第七节为硬边界；新需求走 backlog |

---

## 九、下一步（等你一句话）

1. 认可这份计划 → 我出 P0 的正式契约文档（不改代码）。
2. 契约你审完 → 我先做 `fold` + 契约测试（纯新增，零风险）。
3. 之后按 M1→M4 推进，每个里程碑给你一个可装的包。
