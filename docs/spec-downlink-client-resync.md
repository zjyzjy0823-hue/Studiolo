# SPEC 阶段二：客户端续传状态机（根治「重连后卡在运行中」）

## 现状缺陷（已在阶段一分析中确认）

| 位置 | 缺陷 |
|---|---|
| `src/stores/fleet.ts:2763` | 有 pending 时 `subscribeSession()` 返回 true，缺口帧被**持续丢弃**，不缓存 |
| `src/stores/fleet.ts:1629` | `sequence <= cursor → return`，游标一旦被设高，后续实时帧永久丢弃 |
| `src/stores/fleet.ts:815` / `:2799` | 历史/快照请求**没有超时**；快照请求排在旧历史请求后面，永不发出（今天 Core 侧 7 分钟零 `SessionHistory` 就是它） |
| `src/stores/fleet.ts:1683` | 非 `snapshotRequired` 的 replay 即使 `active=false` 也不校正运行态 |
| `src/stores/fleet.ts:878` / `:936` | 事件处理异常被吞，游标却已推进 → 丢帧且无痕迹 |

## 目标状态（不变量）

1. 客户端收到的每一帧：**应用 或 进有界缓冲**，绝不静默丢弃
2. 每个会话的 `cursor` **单调不减**，且只在帧成功应用后推进
3. 任一请求（subscribe / history）都有超时；超时释放状态并允许重试
4. 快照（历史）与运行态（active/runId）分别对账；「运行中」只由消息 `streaming` 决定
5. 任何路径下，会话不得无限期停留在「重连中 / 运行中」

## 实现要点

### 1. 每会话状态机
```ts
type StreamPhase = 'live' | 'gap' | 'resyncing'
// per sessionKey: { phase, buffer: WsFrame[](cap 1000), retries, timer }
```
- 收到 `sequence > cursor + 1`：进入 `gap`，把**当前帧和之后所有帧**压入 `buffer`（不是 return 丢弃），发一次 `session.subscribe`（带 `afterSequence=cursor`、`streamId`）
- `buffer` 超过 1000 帧：放弃增量，直接请求全量快照

### 2. 超时与重试
- `session.subscribe`：5s 超时，最多重试 2 次（0.5s / 1s 退避），仍失败 → 请求全量快照
- `session.history`：10s 超时 → 清掉 `pendingHistoryPages`、置错误态、允许重试
- **快照请求抢占**：发起快照时必须取消/作废同会话未完成的历史分页请求（否则会继续排队）

### 3. 应用与冲刷
- replay 到达：用 `lastSeq` 设定 `cursor`（取 `max(cursor, lastSeq)`），然后按 `sequence` 升序冲刷 `buffer`
- 去重键：`(streamId, sequence)`；`sequence <= cursor` 的帧直接跳过（此时是**已应用过**，不是缺口）
- 冲刷完成后 `phase='live'`；冲刷过程中再有缺口的帧继续留在 buffer

### 4. 游标推进与异常
- `cursor` 只在帧成功应用后推进
- 事件应用抛异常：写入客户端诊断缓冲（`DiagnosticsSettings` 里那份）+ 触发一次 resync，**不吞**
- Native（Tauri）与 Web 两个入口的异常处理都要覆盖

### 5. 运行态对账
- 所有 replay（含非 `snapshotRequired`）都按 `active` / `runId` 校正 `runningBySession`
- 快照应用完成后：不属于当前 active run 的消息，`streaming` 一律置 false

## 测试（必须真实跑，贴输出）

扩展 `tests/fleet.test.mjs`：

1. **丢帧**：服务端发 1,2,4,5 → 客户端最终消息集合等于服务端
2. **乱序**：3,1,2,4 → 不乱序渲染、不丢
3. **重连**：中途断开 → replay 覆盖缺口 → 最终一致
4. **重试**：subscribe 超时两次、第三次成功 → 恢复
5. **快照抢占**：旧 history 请求挂起时，快照请求仍能发出
6. **无泄漏**：任何路径结束后 `pendingStreamResync` / `pendingHistoryPages` 都为空
7. **不永卡**：注入「永远不会完成的请求」→ 在超时后会话不再是 running/resyncing

## 禁止

- 不改协议字段名、不改 `agent-node/`、不改 `backend/`
- 不 commit、不 push
- 不为让测试变绿而放宽断言

## 交付

- 改动文件清单 + 每处意图
- 真实测试输出
- 单独列出「与 SPEC 不一致 / 没做到 / 有风险」
- 需要重新打 Android 包这一点要在结尾确认（打包由主 agent 负责）
