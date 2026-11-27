# SPEC：发送即出（取消「待发送」）+ 运行中必插话

> 事故：2026-11-26 18:16，用户在手机端发送「脉冲和流光可以共存吧」。
> 服务端**已经收到并跑完**（Hermes 18:16:44 accepted，18:17:50 turn finished），
> 但客户端气泡一直停在「发送中…」，输入框上方还挂着「待发送 (1)」。
> 用户要求：**点发送就必须发出去**；agent 在跑就插话；**不要再有「待发送」这个东西**。

## 0. 产品目标（唯一验收标准）

1. 点发送 → 气泡**立刻**上屏，输入框立刻清空。**任何情况下文字都不许留在输入框里**。
2. 本地存储/加密/路由/连接状态**不允许**成为发送的前置条件（现在的 `throw new Error('当前环境无法加密保存待发送消息')` 会把草稿还回输入框，这是"永远停在输入框"的直接来源）。
3. agent 正在跑 → 自动插话（hermes）；插话被拒 `idle` → 立刻改正常发送；被拒 `not_redirected` → 静默重试，不弹「待发送」。
4. **删除「待发送」UI 面板**（标题、行、还原按钮全部不要）。用户不应该知道有队列这回事。
5. 发送状态只需两种可见结局：`已发送`（拿到回执或从历史里对账成功）/ `发送失败·重试`（超过重试上限）。中间态不打扰用户。

## 1. 已确认的事实（给分析者，别重复猜）

- 服务端链路正常：`~/.hermes/logs/gui.log` 18:16:44 `tui prompt accepted ... chars=10`；18:17:50 `turn finished`。
- agent-node 也发了回执：`studiolo-audit-node.log` `10:16:44.457Z type=Accepted run=bb9f5a08`（= 客户端 `crypto.randomUUID()` 生成的 requestId）。
- 客户端仍然 `发送中` + outbox 里有条目 ⇒ **回执匹配失败**（或 `Accepted` 分支没走到），不是网络没送达。
- `createRequestId()` = `crypto.randomUUID()`（`src/stores/fleet.ts:180`）。
- `Accepted` 处理：`src/stores/fleet.ts:2510-2526`，用 `frame.requestId || runId` 找 `outbox` 条目（`item.id === requestId && item.sessionKey === sKey`），并 `updatePromptDelivery(sKey, requestId, 'sent')`。
- 发送前置条件：`sendPromptToSpecificSession`（`fleet.ts:4114+`）在 `expectLocal && !storage`、`wsState !== 'online'`、`outbox 满 32`、附件 >20MB 时会 `throw`；调用方 catch 后把草稿还回输入框。

## 2. 必须查清的根因（分析任务）

对 `Accepted` 不匹配这件事，列出**所有**可能，并用代码行号证明哪一个成立：
1. `sKey` 计算差异（`sessionKey(nodeId, provider, sessionId)` 与 outbox item 的 `sessionKey`）——provider 别名/大小写？`hermes` vs `hermes-ws`？nodeId 变化？
2. `frame.requestId` 与 `item.id` 不一致：`flushOutbox` 的 `prompt.send` 是否真的把 `item.id` 作为 `requestId`+`commandId` 发出（`sendPromptToSession` 的 `queued` 参数路径 vs `explicitRequestId` 路径）。
3. `handleWsEvent` 前面的流序列/去重逻辑是否把 `Accepted` 提前 `return` 掉了（seq 缺口、`pendingStreamResync`、`dedup`）。
4. `updatePromptDelivery` 只匹配 `row.requestId === requestId && row.delivery === 'sending'`；如果气泡的 `requestId` 字段被 `drainNextQueuedPrompt` 重建过（新 id），就永远匹配不上。
5. 是否存在**两次发送**（同一文本先后两个 requestId），回执对应的是第二个，而 outbox 里留的是第一个。

**交付要求**：把结论写成 `docs/analysis-send-receipt-mismatch.md`，每条结论都带 `文件:行号`；不确定的明确写"未证实"。

## 3. 实现要求（P0）

### 3.1 发送路径重写（取消 outbox 作为发送前置）
- `sendPromptToSpecificSession` / `sendPrompt`：**先上屏、先清输入框**，再异步做"保存到本地 / 上传附件 / 发送"。
- 任何本地存储失败只降级为"不持久化"，不得 throw 到 UI。
- `wsState !== 'online'` 时不 throw：进内存队列，重连后自动重投（同一 requestId，幂等）。
- 删除或彻底隐藏 `outbox` 的 UI 展示（`AgentChatThread.vue` 里的 `.follow-queue` 待发送块、`outboxTitle`、`未确认/重试/还原到输入框` 全部移除）。可以保留一个极简的「重试」入口挂在失败气泡上（`messageReceipts` 的 failed 状态已有）。

### 3.2 运行中必插话
- 运行时发送 → 直接 `prompt.steer`；`idle` → 立刻 `prompt.send`；`not_redirected`/超时 → 静默重试（最多 2 次，指数退避），仍失败才在气泡上显示"发送失败·重试"。
- 不允许静默停住；不允许把消息挂在"待发送"。

### 3.3 回执对账（容错，不再依赖单一路径）
- `Accepted` 匹配改为多重键：`requestId` → `commandId` →（sessionKey + 文本 + 60s 时间窗）兜底。
- 会话重连/拉 history 后，把本地仍为 `sending` 且历史里已存在同文本 user 行的消息，直接标 `sent`。
- 30s 无回执仍走 watchdog（上一轮已实现），但**只标记、不阻塞后续发送**。

## 4. 测试要求

- `tests/fleet.test.mjs` 新增：
  1. 离线点发送 → 气泡立刻存在、草稿清空、不抛错；重连后自动发出且只发一次。
  2. `Accepted` 的 `requestId` 与 outbox id 不一致时，用文本+时间窗兜底把气泡标成 `sent`（不允许永久发送中）。
  3. 运行中发送 → 发 `prompt.steer`；`idle` 回执 → 自动 `prompt.send`。
- 原有 62 个用例不得回归；`npm run test:outbox` 保持全绿；`npx vue-tsc --noEmit` 0 报错。

## 5. 边界

- 只改前端（`src/**`、`tests/**`、`package.json`）；不改 agent-node / Core / Hermes。
- 不要新增依赖；不要格式化无关代码；不要 commit。
- 如果删掉 outbox 会牵连太多（本地加密队列、断网续传），可以保留其**内部**能力，但 UI 上必须不存在「待发送」三个字。

## 6. 交付格式

1. 根因分析文档 `docs/analysis-send-receipt-mismatch.md`（结论 + 文件:行号 + 未证实项）。
2. 改动清单（`文件:行号`）+ 三条命令的真实输出。
3. 与 spec 的偏离及理由。

---

## 7. 复核补充：一个强候选根因（riri 18:3x）

`handleWsEvent`（`src/stores/fleet.ts:1857-1867`）把**所有带 `sequence`+`streamId` 的帧**先过流序号闸门：
`state.phase !== 'live'` 或出现缺口 → `bufferStreamFrame()` 入缓冲，**包括 `Accepted` 这种控制帧**。

`bufferStreamFrame`（`:1741-1762`）在缓冲超上限（`STREAM_BUFFER_CAP`）时：
清历史 → 请求快照 → **丢弃最老的增量帧**（`state.buffer.splice(...)`）。
被丢掉的如果正好是 `Accepted`，客户端就再也不会知道这条消息已送达：气泡永远「发送中」、outbox 永远留着，
而历史快照里那条用户消息看起来是"已发"的——和 18:16 的现象完全一致。

因此实现必须包含：
1. `Accepted / Completed / SteerAccepted / SteerRejected / RunStopStatus` 这类**控制帧不参与流序号缓冲**，收到即处理（幂等）。
2. 历史/快照应用后，用 `(sessionKey, 文本, 时间窗)` 对账本地 `sending` 气泡与 outbox 条目，命中的直接标 `sent` 并删除。
3. 缓冲溢出丢弃帧时，必须记录并触发一次对账（不能静默丢回执）。
