# 规格：修复「回合结束后仍显示运行中」

## 现象

- 会话的回合已经结束（审计日志有 `Completed`），Android 端 composer 仍然显示「停止」键，即 `isStreaming === true`。
- 实测时间线：`14:32:12 Completed run=cd9b0b38`，14:34 截图里按钮仍是停止态。

## 根因（已定位到代码）

1. `src/stores/fleet.ts:730` `isSessionStreaming(sKey)` = 该会话**任意一条**消息 `streaming === true`。
2. `streaming: true` 由增量帧写入（`ThoughtDelta` / `TextDelta` / `ToolCall|ToolCallUpdate`，见 `fleet.ts:2674/2696/2722`）。
3. 只有两处清零：`Completed`（`fleet.ts:3113`）和 `Failed`（`fleet.ts:3263`），二者都走 `updateAssistantMessage(...)`，只更新**一条**消息（按 `runId` 命中，命中不到退化为最后一条）。
4. 结果：一个回合里出现多条带 `streaming` 的消息时（插话、epoch 快照重建都会造成），总会留下孤儿标记。
5. 没有任何「整会话清零」，也没有前后台对账：WebView 后台会暂停 JS，后台期间的 `Completed` 直接丢失，回到前台不会重新对账。

## 目标（验收标准）

- G1 回合结束后，该会话内**不可能**残留 `streaming === true`（不论 runId 是否匹配、不论有几条消息）。
- G2 App 回到前台、或 WS 重连后，如果服务端没有活回合，UI 必须立刻退出「运行中」。
- G3 孤儿标记（无活回合 + 长时间无帧）不得让 UI 永久卡在运行中。
- G4 不误杀：真有活回合、且持续有帧时，必须保持「运行中」。

## 实现要求

### A. `settleSessionStreaming(sKey)`

- 位置：`src/stores/fleet.ts`，紧邻现有 `reconcileRunMessages`（`fleet.ts:1235`）。
- 逻辑：把该会话**所有**消息的 `streaming` 置 `false`，同时清掉 `liveProgress`；保持现有不可变更新风格（`messagesBySession.value = {...}`）。
- **幂等**：若该会话没有任何 `streaming === true` 的消息，直接返回，不产生新数组（避免无谓重渲染）。
- 调用点（缺一不可）：
  1. `Completed` 分支，在现有 `updateAssistantMessage(...)` 之后；
  2. `Failed` 分支，同上；
  3. `RunStopStatus` 且 `frame.status === 'accepted'`，且 `runningBySession[sKey]` 不存在时；
  4. `clearTransportRequests` / `connectionLost` 路径中，`runningBySession[sKey]` 已不存在的那次循环。

### B. 前台恢复对账

- 在 store 中注册 `visibilitychange` 监听（浏览器/Tauri 环境都要，`onScopeDispose` 里移除）。
- 变为 `visible` 时：
  - 若 `wsState.value !== 'online'`，或激活会话距最后一帧 > 30s，则对**激活会话**触发一次快照同步（复用已有路径：优先 `sessionSync.open(sKey)`，不可用时退回 `requestSnapshotHistory(sKey)`）。
  - 无激活会话时什么都不做。
- 需要能判断「距最后一帧多久」：新增 `lastFrameAtBySession`（`Map<string, number>` 或 `ref<Record<string, number>>`），在 `handleWsEvent` 处理每个流帧时更新；切换会话不影响。

### C. 过期保护

- 新增常量：`export const STREAM_STALE_MS = 90_000`（放 store 或 `src/services/` 均可，需可被测试引用）。
- `isSessionStreaming(sKey)` 语义改为：
  - `runningBySession[sKey]` 存在 → 有 streaming 消息即为 `true`；
  - `runningBySession[sKey]` 不存在 → 仅当存在 streaming 消息**且** `now - lastFrameAtBySession[sKey] < STREAM_STALE_MS` 时为 `true`，否则 `false`（并且顺手 `settleSessionStreaming(sKey)`，让 UI 立刻恢复）。
  - 没有帧时间记录（`undefined`）视为过期。

## 测试（新增 `tests/streaming-state.test.mjs`，并在 package.json 加 `test:streaming`）

沿用 `tests/fleet.test.mjs` 的既有 mock 方式（不要新造一套 harness）：

1. 一个会话两条 assistant 消息都 `streaming: true`，收到 `Completed`（runId 命中第一条）→ 两条都变 `false`。
2. `Completed` 的 runId 与任何消息都不匹配 → 仍然全部清零。
3. `Failed` 同样全部清零。
4. 无活回合 + 最后一帧 120s 前 + 仍有 streaming 消息 → `isSessionStreaming() === false`（且消息被 settle）。
5. 无活回合 + 最后一帧 5s 前 → `isSessionStreaming() === true`（不误杀）。
6. 有活回合（`runningBySession[sKey]` 存在）+ streaming 消息 → `true`。
7. `visibilitychange` → `visible` 且 `wsState !== 'online'` 时，对激活会话触发至少一次快照同步（用 spy 断言，不绑定内部实现细节）。

## 约束

- 只改：`src/stores/fleet.ts`（主）、必要时 `src/services/*.ts`、`tests/**`、`package.json`。
- **不要**改 `design/`、`src-tauri/`、`agent-node/`、`backend/`、`docs/`。
- 不新增任何依赖，不执行 `git commit`。
- 现有测试必须全绿：`test:fleet`、`test:outbox`、`test:worklog`、`test:timestamps`、`test:attachment`、`test:font-scale`、`test:cors`、`test:downloads`；`npx vue-tsc --noEmit` 必须 0 报错。

## 交付物

完成后输出：

1. 改动文件清单（文件:行号）与每个调用点位置；
2. `npm run test:streaming` 的真实输出；
3. 上面 8 个既有测试 + `vue-tsc` 的真实输出。
