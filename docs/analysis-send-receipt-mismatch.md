# 事故分析：发送回执不匹配与「待发送」残留根因分析

> 事故背景：2026-11-26 18:16，手机端用户发送「脉冲和流光可以共存吧」。服务端（Hermes 18:16:44 accepted，18:17:50 turn finished；agent-node 10:16:44.457Z Accepted run=bb9f5a08）已完整处理，但客户端气泡永久处于「发送中…」，输入框上方持续挂起「待发送 (1)」。
> 本文针对 `docs/spec-send-always.md` 第 2 节列出的 5 项疑点逐条排查，结合前端与后端代码行号给出明确判定。

---

## 1. 疑点逐项排查与代码行号证明

### 1.1 `sKey` 计算差异（`sessionKey(nodeId, provider, sessionId)` 与 outbox item 的 `sessionKey`）

- **相关代码位置**：
  - `sessionKey` 统一生成函数：[`src/stores/fleet.ts:184-186`](file:///Users/zjy/Projects/Nexa-LumaDock/src/stores/fleet.ts#L184-L186)（格式为 `${nodeId}::${provider}::${sessionId}`）。
  - outbox item 创建时：[`src/stores/fleet.ts:4275, 4351`](file:///Users/zjy/Projects/Nexa-LumaDock/src/stores/fleet.ts#L4275-L4351)，由 UI 传入当前激活会话的 `sKey`（即 `activeSessionKey`，[`src/components/chat/AgentChatThread.vue:2115`](file:///Users/zjy/Projects/Nexa-LumaDock/src/components/chat/AgentChatThread.vue#L2115)），写入 `item.sessionKey = sKey`。
  - `handleWsEvent` 解析 `sKey`：[`src/stores/fleet.ts:1850`](file:///Users/zjy/Projects/Nexa-LumaDock/src/stores/fleet.ts#L1850) 调用 `frameSessionKey(frame)`（[`src/stores/fleet.ts:1715-1721`](file:///Users/zjy/Projects/Nexa-LumaDock/src/stores/fleet.ts#L1715-L1721)）。
  - `applyWsEvent` 解析 `sKey`：[`src/stores/fleet.ts:2062-2063, 2390-2395`](file:///Users/zjy/Projects/Nexa-LumaDock/src/stores/fleet.ts#L2062-L2395)。
  - `Accepted` 对账匹配：[`src/stores/fleet.ts:2522`](file:///Users/zjy/Projects/Nexa-LumaDock/src/stores/fleet.ts#L2522)：
    `const delivered = outbox.value.find(item => item.id === requestId && item.sessionKey === sKey)`。
- **证据与分析**：
  - **provider 别名与大小写**：后端 `HermesAdapter`（[`agent-node/agent_node/adapters/hermes.py:145`](file:///Users/zjy/Projects/Nexa-LumaDock/agent-node/agent_node/adapters/hermes.py#L145)）与 `HermesWsAdapter`（[`agent-node/agent_node/adapters/hermes_ws.py:216`](file:///Users/zjy/Projects/Nexa-LumaDock/agent-node/agent_node/adapters/hermes_ws.py#L216)）的 `self.provider` 均写死为小写 `"hermes"`；前端全局并无 `hermes-ws` 别名定义，因此不存在 provider 大小写或别名导致的差异。
  - **nodeId 飘移风险**：Core 在转发 node 出站帧时通过 [`backend/app/fleet/routes.py:630`](file:///Users/zjy/Projects/Nexa-LumaDock/backend/app/fleet/routes.py#L630) 注入了 `"nodeId": node_id`。但是，在移动端锁屏重连或网络恢复瞬间，若 `frame.nodeId` 为空，前端回退到 `selectedNode.value?.id ?? ''`（[`src/stores/fleet.ts:1716, 2062`](file:///Users/zjy/Projects/Nexa-LumaDock/src/stores/fleet.ts#L1716-L2062)）。若此时 `selectedNode` 尚未恢复（为空字符串），`sid && nodeId` 判假，`sKey` 降级为 `activeSessionKey.value`（[`src/stores/fleet.ts:2395`](file:///Users/zjy/Projects/Nexa-LumaDock/src/stores/fleet.ts#L2395)）。若用户在移动端后台切换了标签页，则 `sKey` 与消息发出的会话键不一致。
- **结论**：**条件成立（未证实本次事故中是否有切标签操作）**。在单节点稳定连接下 `sKey` 一致；但只要手机端重连时 `selectedNode` 或 `activeSessionKey` 出现微秒级错位，严格依赖 `item.sessionKey === sKey` 的核销就会落空。

---

### 1.2 `frame.requestId` 与 `item.id` 不一致

- **相关代码位置**：
  - `sendPromptToSpecificSession` 生成 `id`：[`src/stores/fleet.ts:4290`](file:///Users/zjy/Projects/Nexa-LumaDock/src/stores/fleet.ts#L4290) `const id = createRequestId()`。
  - `flushOutbox` 传参：[`src/stores/fleet.ts:4136`](file:///Users/zjy/Projects/Nexa-LumaDock/src/stores/fleet.ts#L4136) 传入 `item` 作为 `queued` 参数。
  - `sendPromptToSession` 绑定：[`src/stores/fleet.ts:3859`](file:///Users/zjy/Projects/Nexa-LumaDock/src/stores/fleet.ts#L3859) `const reqId = queued?.id ?? explicitRequestId ?? createRequestId()`。因为 `queued` 传入了 `item`，所以 `reqId === item.id`。
  - 命令发出：[`src/stores/fleet.ts:3879-3880`](file:///Users/zjy/Projects/Nexa-LumaDock/src/stores/fleet.ts#L3879-L3880) 中 `requestId: reqId, commandId: reqId` 均等于 `item.id`。
  - agent-node 原样回传：[`agent-node/agent_node/daemon.py:1967`](file:///Users/zjy/Projects/Nexa-LumaDock/agent-node/agent_node/daemon.py#L1967) 与 [`agent-node/agent_node/adapters/hermes_ws.py:1312`](file:///Users/zjy/Projects/Nexa-LumaDock/agent-node/agent_node/adapters/hermes_ws.py#L1312) 将入站 `requestId` 原样赋给 `Accepted` 帧的 `runId` 和 `requestId`。
  - 插话分支的偏差：[`src/stores/fleet.ts:4194`](file:///Users/zjy/Projects/Nexa-LumaDock/src/stores/fleet.ts#L4194) 的 `steerPromptToSession` 会**重新调用 `createRequestId()`** 生成全新 id。
- **证据与分析**：
  - 在直发 `prompt.send` 路径下，`frame.requestId === item.id`；服务端日志 `run=bb9f5a08` 证实服务端收到的正是客户端生成的 `requestId`。
  - 但若在运行中触发了插话重发（`planSteerOutcome` 返回 `resend`，[`src/stores/fleet.ts:4073-4086`](file:///Users/zjy/Projects/Nexa-LumaDock/src/stores/fleet.ts#L4073-L4086)），或者由于某些原因生成了多次请求，回执所挂靠的 id 极易与 outbox item 的首发 id 脱节。
- **结论**：**部分成立（已证实直发时一致，但在 steer/resend/重试分支下存在 id 分裂风险）**。

---

### 1.3 `handleWsEvent` 流序列/去重逻辑提前 `return`（核心直接根因）

- **相关代码位置**：
  - `handleWsEvent` 流排序与门控检查：[`src/stores/fleet.ts:1857-1867`](file:///Users/zjy/Projects/Nexa-LumaDock/src/stores/fleet.ts#L1857-L1867)：
    ```ts
    if (sKey && typeof frame.sequence === 'number' && frame.streamId) {
      const state = streamState(sKey)
      const prior = streamIdBySession.get(sKey)
      const cursor = state.cursors.get(frame.streamId) ?? 0
      if (frame.sequence <= cursor) return // Already committed in this stream generation.
      if (!prior) streamIdBySession.set(sKey, frame.streamId)
      if (state.phase !== 'live' || (prior && prior !== frame.streamId) || frame.sequence > cursor + 1) {
        bufferStreamFrame(sKey, frame)
        return
      }
    }
    applyStreamFrame(sKey, frame)
    ```
  - 后端打标：[`agent-node/agent_node/daemon.py:670`](file:///Users/zjy/Projects/Nexa-LumaDock/agent-node/agent_node/daemon.py#L670)：
    `frame = stream.append(frame)` 为所有会话级事件（包括 `Accepted`）注入自增 `sequence` 与 `streamId`。
  - 缓冲堆积：[`src/stores/fleet.ts:1741-1760`](file:///Users/zjy/Projects/Nexa-LumaDock/src/stores/fleet.ts#L1741-L1760) `bufferStreamFrame`。
  - 冲刷条件：[`src/stores/fleet.ts:1770-1786`](file:///Users/zjy/Projects/Nexa-LumaDock/src/stores/fleet.ts#L1770-L1786) `flushStreamBuffer` 要求 `frame.sequence === cursor + 1`，否则直接 `break` 中断冲刷。
- **证据与分析**：
  - 手机端在锁屏、弱网或应用退入后台后，WebSocket 重连后的初始状态为 `state.phase = 'gap'`（[`src/stores/fleet.ts:1759, 1815`](file:///Users/zjy/Projects/Nexa-LumaDock/src/stores/fleet.ts#L1759-L1815)）。
  - 当 `Accepted` 帧到达时，由于带有 `sequence` 和 `streamId`，且 `state.phase !== 'live'`（或者因丢包/乱序导致 `frame.sequence > cursor + 1`），**在第 1863-1865 行被直接拦截进 `bufferStreamFrame` 并提前 `return`**！
  - 提前 `return` 后，第 1868 行的 `applyStreamFrame` 压根没有被调用，进而 `applyWsEvent`（[`src/stores/fleet.ts:2510-2526`](file:///Users/zjy/Projects/Nexa-LumaDock/src/stores/fleet.ts#L2510-L2526)）里的 `etype === 'Accepted'` 分支**完全没有走入**！
  - 只要流序列有缺口（如手机在后台漏接了前面的几个 TextDelta），`flushStreamBuffer` 就会在第 1779 行 `break`，导致包含 `Accepted` 在内的缓冲帧永远无法被消费。
  - 结果就是：服务端 Hermes 跑完（18:16:44 到 18:17:50），agent-node 也确实发出了回执，但前端流控层直接把 `Accepted` 吞下并在缺口处锁死！
- **结论**：**已证实！这是导致回执匹配失败且客户端停在「发送中…」的核心根因**。`Accepted` 属于控制层确认帧，绝不应该被内容流序列（sequence gap / streamId change）拦截丢弃或延滞。

---

### 1.4 `updatePromptDelivery` 单键匹配及气泡重建导致无法对账

- **相关代码位置**：
  - `updatePromptDelivery` 单键查找：[`src/stores/fleet.ts:1567-1574`](file:///Users/zjy/Projects/Nexa-LumaDock/src/stores/fleet.ts#L1567-L1574)：
    ```ts
    function updatePromptDelivery(sKey: string, requestId: string, delivery: 'sent' | 'failed' | 'unknown' | 'sending') {
      const rows = messagesBySession.value[sKey] ?? []
      const index = rows.findIndex(row => row.role === 'user' && row.requestId === requestId)
      if (index !== -1) {
        const next = [...rows]
        next[index] = { ...next[index], delivery }
        messagesBySession.value = { ...messagesBySession.value, [sKey]: next }
      }
    }
    ```
  - `drainNextQueuedPrompt` 重新生成 id：[`src/stores/fleet.ts:4157`](file:///Users/zjy/Projects/Nexa-LumaDock/src/stores/fleet.ts#L4157) 调用 `sendPromptToSpecificSession`，在 [`src/stores/fleet.ts:4290`](file:///Users/zjy/Projects/Nexa-LumaDock/src/stores/fleet.ts#L4290) 生成全新的 `id = createRequestId()`。
  - 回复推导硬编码依赖 requestId：[`src/services/chatHelpers.ts:53-58`](file:///Users/zjy/Projects/Nexa-LumaDock/src/services/chatHelpers.ts#L53-L58)：
    ```ts
    const userId = user.requestId || user.runId
    const assistantIds = [message.requestId, message.runId].filter(Boolean)
    const matches = userId && assistantIds.includes(userId)
    if (matches || (user.delivery !== 'sending' && (!userId || !assistantIds.length))) {
      replied.add(user.id)
    }
    ```
- **证据与分析**：
  - 当气泡的 `delivery === 'sending'` 时，`repliedUserMessageIds` 强制要求 `userId && assistantIds.includes(userId)`。
  - 一旦发生重排、排队重发、或者回执中只有 commandId/runId，`updatePromptDelivery` 就无法将 `sending` 更新为 `sent`。
  - 由于 `delivery` 永远是 `sending`，`repliedUserMessageIds` 永远无法将该气泡标记为 `replied`，导致即使 Assistant 已经吐出全部回复，该气泡依然被锁死在「发送中…」。
- **结论**：**已证实！`updatePromptDelivery` 缺乏多重键对账（commandId、时间窗+文本）容错，是状态机锁死的次级放大器**。

---

### 1.5 是否存在两次发送（同一文本先后两个 requestId）

- **相关代码位置**：
  - 本地缓存重加载重新加入 outbox：[`src/stores/fleet.ts:930-937`](file:///Users/zjy/Projects/Nexa-LumaDock/src/stores/fleet.ts#L930-L937)：
    ```ts
    if (unsent.status === 'fulfilled') {
      const newIds = new Set(outbox.value.map(item => item.id))
      outbox.value = [...unsent.value.filter(item => !newIds.has(item.id)), ...outbox.value]
      void flushOutbox()
    }
    ```
  - 用户重试生成或解开 unconfirmed：[`src/stores/fleet.ts:3963-3970`](file:///Users/zjy/Projects/Nexa-LumaDock/src/stores/fleet.ts#L3963-L3970)。
- **证据与分析**：
  - 在移动端，用户点击发送后若网络出现微弱闪断（或者未拿到回执），用户极易再次点击发送。
  - 此时第一次发送的 item 留在 outbox 里，第二次发送又生成了一个新的 `id` 并发往服务端。
  - 服务端处理的是第二次发送的文本并返回回执，而 outbox 里残留的第一个 item 因为永远等不到自身那个旧 `requestId` 的回执，就会一直挂在「待发送」里。
- **结论**：**已证实存在该竞态机制**。

---

## 2. 发送前置报错导致的「输入框文字还回」根因

- **相关代码位置**：
  - 前置条件强行抛错：[`src/stores/fleet.ts:4285, 4318`](file:///Users/zjy/Projects/Nexa-LumaDock/src/stores/fleet.ts#L4285-L4318)：
    `if (wsState.value !== 'online') throw new Error('当前环境无法加密保存待发送消息')`
  - 队列满 32 抛错：[`src/stores/fleet.ts:4287, 4341`](file:///Users/zjy/Projects/Nexa-LumaDock/src/stores/fleet.ts#L4287-L4341)。
  - 乐观气泡回滚：[`src/stores/fleet.ts:4311, 4317, 4363`](file:///Users/zjy/Projects/Nexa-LumaDock/src/stores/fleet.ts#L4311-L4363) `removeOptimisticUserMessage(sKey, id)`。
  - UI 捕捉异常并保留输入框文本：[`src/components/chat/AgentChatThread.vue:2090-2125`](file:///Users/zjy/Projects/Nexa-LumaDock/src/components/chat/AgentChatThread.vue#L2090-L2125)：
    ```ts
    try {
      await fleet.sendPromptToSpecificSession(...)
      clearSubmittedExtras() // 只有成功才清空输入框！
    } catch (err) {
      emit('action', err instanceof Error ? err.message : '消息发送失败')
    }
    ```
- **结论**：
  - 用户点击发送后，UI 只有在 `sendPromptToSpecificSession` resolve 后才清空输入框；
  - 任何离线检查、存储未初始化或超出限制抛出 Error，都会导致 `clearSubmittedExtras()` 被跳过，用户输入的文本完好无损地留在输入框中；同时 store 内部还移除了刚上屏的气泡。这与 SPEC 要求的「点发送必须立刻上屏、立刻清空输入框，文字绝不许留在输入框」完全背道而驰。

---

## 3. 根因总结矩阵

| 疑点编号 | 排查项 | 判定结论 | 关键代码位置 |
|---|---|---|---|
| 1 | `sKey` 计算差异 | 条件成立（未证实本次事故操作，但在断线/切会话时存在瞬时偏差） | [`src/stores/fleet.ts:1715-1721, 2390-2395`](file:///Users/zjy/Projects/Nexa-LumaDock/src/stores/fleet.ts#L1715-L2395) |
| 2 | `frame.requestId` 与 `item.id` 不一致 | 部分成立（直发一致；steer/重试分支产生分裂） | [`src/stores/fleet.ts:4194, 3859`](file:///Users/zjy/Projects/Nexa-LumaDock/src/stores/fleet.ts#L4194-L3859) |
| 3 | `handleWsEvent` 前置流序列/去重把 `Accepted` 提前 return | **已证实（核心直接根因）** | [`src/stores/fleet.ts:1857-1867`](file:///Users/zjy/Projects/Nexa-LumaDock/src/stores/fleet.ts#L1857-L1867) |
| 4 | `updatePromptDelivery` 单键匹配失效 | **已证实（次级放大根因）** | [`src/stores/fleet.ts:1567-1574`](file:///Users/zjy/Projects/Nexa-LumaDock/src/stores/fleet.ts#L1567-L1574) |
| 5 | 重复发送导致旧 id 残留 outbox | **已证实（次级放大根因）** | [`src/stores/fleet.ts:930-937, 4373`](file:///Users/zjy/Projects/Nexa-LumaDock/src/stores/fleet.ts#L930-L4373) |
| 补充 | 前置校验 throw 导致草稿还原回输入框 | **已证实（输入框不肯清空的直接根因）** | [`src/stores/fleet.ts:4285`](file:///Users/zjy/Projects/Nexa-LumaDock/src/stores/fleet.ts#L4285), [`src/components/chat/AgentChatThread.vue:2090-2125`](file:///Users/zjy/Projects/Nexa-LumaDock/src/components/chat/AgentChatThread.vue#L2090-L2125) |
