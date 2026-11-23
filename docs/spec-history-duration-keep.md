# SPEC · 节点重启后保留历史消息的「用时」

- 版本：v1（2026-11-23）
- 实施者：Codex（`gpt-6.2-sol`, effort=high）
- 审查者：Hermes agent

## 1. 问题

`msg.durationMs`（整轮墙钟）只在前端收到 `Completed` 帧时计算（`src/stores/fleet.ts:2102`），节点从不保存。

节点重启后 WS 重连会触发 `loadSessionHistory(k, true)` 强制重拉历史；agent-node 回放 ACP 历史时用 `run_id=None` 记录（`agent-node/agent_node/adapters/hermes.py:831`），所以历史消息**没有 `runId`/`requestId`**。

前端合并历史时靠这两个字段匹配本地消息以保留本地字段（`src/stores/fleet.ts:1355-1370` 的 `live`），匹配不上就用节点版本整条替换 → `durationMs` 丢失，所有历史消息的「用时」归零。

## 2. 目标

节点重启 / 历史重拉后，**只要内容一致，就保留本地已有的 `durationMs`**，不依赖 `runId`。

## 3. 改动一：`src/services/chatHelpers.ts` 新增纯函数

```ts
/**
 * 内容指纹：历史回放不带 runId/requestId 时，用内容判断是否为同一条消息。
 * 只用于「保留本地计算字段」，不用于身份判定。
 */
export function sameTurnContent(local: ChatMessage, remote: ChatMessage): boolean {
  if (local.role !== remote.role) return false
  if ((local.text ?? '').trim() !== (remote.text ?? '').trim()) return false
  const localCalls = (local.toolCalls ?? []).map(call => call.callId || call.id).filter(Boolean)
  const remoteCalls = (remote.toolCalls ?? []).map(call => call.callId || call.id).filter(Boolean)
  if (localCalls.length !== remoteCalls.length) return false
  return localCalls.every((id, index) => id === remoteCalls[index])
}
```

要求：

- 用 `text` 全等（trim 后）+ `toolCalls` 的 `callId` 顺序全等作为指纹
- **不要**把 `thought` 纳入指纹（历史回放的思考内容可能被截断或合并，会导致永远匹配不上）
- 纯函数、无副作用、不依赖 store

## 4. 改动二：`src/stores/fleet.ts` 的历史合并处

位置：`SessionHistory` 分支里的 `const live = ...`（约 1355-1362 行）。

改前：

```ts
const live = (m.runId || m.requestId) && existing.find(row => row.role === m.role && (
  Boolean(m.runId && (row.runId === m.runId || row.requestId === m.runId)) || Boolean(m.requestId && row.requestId === m.requestId)
))
```

改后：

```ts
const live = (m.runId || m.requestId)
  ? existing.find(row => row.role === m.role && (
      Boolean(m.runId && (row.runId === m.runId || row.requestId === m.runId)) || Boolean(m.requestId && row.requestId === m.requestId)
    ))
  // 历史回放没有 runId/requestId：退回内容指纹，从最近的消息往前找
  : [...existing].reverse().find(row => sameTurnContent(row, m))
```

其余逻辑**不要动**：

- 保留 `live.text.length >= m.text.length` 等长度守卫（本地内容更短时仍用节点版本，这是正确行为）
- 保留 `live.delivery === 'sending' ? { ...live, delivery: 'sent' } : live` 的返回
- 保留 `hasLiveHistory` / `forced` / `beforeCursor` 等替换条件
- 保留 `cachedHistoryKeys.delete(k)`、分页游标、`historyStateBySession` 逻辑

导入：在 `fleet.ts` 的 chatHelpers 导入列表里加 `sameTurnContent`。

## 5. 改动三：测试

在 `tests/fleet.test.mjs` 增加用例（导入 `sameTurnContent`）：

| 用例 | 期望 |
|---|---|
| 同 role + 同 text + 同 toolCalls callId 顺序 | `true` |
| text 只差首尾空白 | `true` |
| text 不同 | `false` |
| toolCalls 数量不同 | `false` |
| toolCalls callId 顺序不同 | `false` |
| role 不同 | `false` |
| thought 不同但 text/toolCalls 相同 | `true`（thought 不参与指纹） |
| 两边 toolCalls 都为空、text 都为空 | `true` |

## 6. 不改的东西（明令禁止）

1. 不改 agent-node（`hermes.py` / `daemon.py`）任何代码
2. 不改 `durationMs` 的计算位置与公式（`fleet.ts:2102`）
3. 不改工具级 `durationMs` 的来源（`ToolCallUpdate`）
4. 不改 `session.history` 请求参数、分页游标、`MAX_MESSAGES_PER_SESSION`
5. 不改 `WorkLog.vue` / `AgentChatThread.vue`
6. 不改 `FleetLocalStore` 的持久化格式
7. 不 commit、不改版本号

## 7. 边界行为

| 场景 | 期望 |
| --- | --- |
| 节点重启后重拉历史，内容一致 | 保留本地 `durationMs` → 仍显示「用时 X」 |
| 节点历史内容更长（本地只收到部分流式） | 用节点版本（`durationMs` 丢失，可接受） |
| 同一会话有两条文字完全相同的 assistant 消息 | 从最近往前匹配，可能张冠李戴；`durationMs` 属于哪条影响很小，**不要求特殊处理** |
| 首次打开从未加载过的会话 | 无本地消息，无 `durationMs`，行为不变 |
| 工具级耗时 | 仍然会丢（本次不修，见 SPEC 外说明） |

## 8. 门禁（自己跑并贴结果）

```bash
npx vue-tsc --noEmit -p tsconfig.json
npm run test:fleet
npm run build
```

## 9. 交付格式

```markdown
## 改动文件
- path:line — 一句话

## 门禁结果
- 命令 → 实际输出摘要

## 与 SPEC 的不一致
- 无 / 逐条说明

## 手动验证建议
1. …
```
