# SPEC · 工作日志显示「本轮用时」而非「工具耗时求和」

- 版本：v1（2026-11-23）
- 实施者：Codex（`gpt-6.2-sol`, effort=high）
- 审查者：Hermes agent

## 1. 问题

聊天里工作日志折叠态显示的是 `工具用时 20 分钟 53 秒`，这个数字是**该轮所有工具 durationMs 的求和**，不含模型思考与生成时间。用户看到它时会误以为"这轮花了这么久"。

实际 `msg.durationMs`（整轮墙钟，从 prompt 发出到 `Completed`）已经在数据里（`src/stores/fleet.ts:2102`），但只在"这条消息只有 1 个 work-log"时才传给 `WorkLog`（`AgentChatThread.vue:2522`），因为一轮多段时每个 WorkLog 都会重复显示同一整轮时长。

## 2. 目标

折叠态默认显示**本轮用时**（整轮墙钟），工具耗时求和退为 fallback。

## 3. 具体改动（只动这两个文件）

### 3.1 `src/components/chat/AgentChatThread.vue`

**(a) `assistantTurns` computed（约 1006-1013 行）**

现在返回 `{ items, singleLog, testResult }`。增加 `lastWorkLogId`：

```ts
const workLogs = items.filter(item => item.type === 'work-log')
return [msg.id, {
  items,
  lastWorkLogId: workLogs.at(-1)?.id,
  testResult: msg.streaming ? undefined : readTurnTestResult(msg.toolCalls),
}]
```

- `singleLog` 若无其他引用则一并删除（当前仅 2522 行使用）。
- 保持 `items` / `testResult` 语义不变。

**(b) 模板 `:duration-ms`（约 2522 行）**

```html
<!-- 改前 -->
:duration-ms="assistantTurns.get(msg.id)?.singleLog ? msg.durationMs : undefined"

<!-- 改后 -->
:duration-ms="assistantTurns.get(msg.id)?.lastWorkLogId === item.id ? msg.durationMs : undefined"
```

语义：一轮里**只有最后一个 work-log** 拿到整轮时长，前面的 work-log 继续用工具求和（不会重复显示同一个整轮数字）。

### 3.2 `src/components/chat/WorkLog.vue`

`label` 的优先级**已经是** `durationMs` 在工具求和之前（43-53 行），不要重排。只需确认两条文案区分清楚：

- 有 `durationMs` → `用时 ${formatTime(durationMs)}`
- 否则 → `工具用时 ${formatTime(sum)}`
- 都没有 → `用时未记录`

若文案已是这样，**此文件不需要改动**（允许零改动）。

## 4. 不改的东西（明令禁止）

1. 不改 `src/services/messageSegments.ts` 的 work-log 分段逻辑
2. 不改 `src/stores/fleet.ts` 里 `durationMs` 的计算（`Completed` 帧时 `Date.now() - promptMeta.startedAt`）
3. 不改 `ToolCallCard.vue`（单个工具耗时继续在展开后的卡片里显示）
4. 不改流式过程中的「思考中 / 回复中 / 工具名」进度显示
5. 不改 `WorkLog` 展开后的时间线结构
6. 不改任何后端 / agent-node 代码
7. 不 commit、不改版本号

## 5. 边界行为（必须保持）

| 场景 | 期望 |
| --- | --- |
| 一轮只有 1 个 work-log | 显示「用时 X」（整轮），与改前一致 |
| 一轮多个 work-log | 中间的显示「工具用时 X」；**最后一个**显示「用时 X」（整轮） |
| 流式中（未 Completed） | 仍显示「思考中 / 回复中 / 当前工具名」，不显示用时 |
| 历史消息无 `durationMs` | 回退「工具用时 X」求和（与改前一致） |
| 纯文字回合（无 work-log） | 不渲染 WorkLog（现状） |
| 工具 `durationMs` 全缺失 | 「用时未记录」（现状） |

## 6. 门禁（自己跑并贴结果）

```bash
npx vue-tsc --noEmit -p tsconfig.json
npm run build
```

## 7. 交付格式

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
