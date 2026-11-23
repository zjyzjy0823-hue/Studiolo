# SPEC · 消息回执双勾：思考或工具调用即算「Agent 已响应」

- 版本：v1（2026-11-23）
- 实施者：Codex（`gpt-6.2-sol`, effort=high）
- 审查者：Hermes agent

## 1. 问题

用户消息气泡下方的回执图标目前只有三种"已响应"条件：assistant 有 `text` / `forms` / `media` / `artifacts`。

当 Agent **只思考、只调工具、没写文字**（例如"跑一下测试"然后只返回工具卡片）时，用户消息永远停在单勾「已发送」，看起来像没被响应。

## 2. 目标

**assistant 一开始思考、或产生任何工具调用，就判定为「Agent 已响应」→ 双勾（`checks`，蓝色）。**

## 3. 改动点（单文件）

`src/services/chatHelpers.ts` 的 `repliedUserMessageIds`（约 19-39 行），把 `hasReply` 从：

```ts
const hasReply = message.text.trim() || message.forms?.length || message.media?.length || message.artifacts?.length
```

改为：

```ts
const hasReply = Boolean(
  message.text.trim()
  || message.thought?.trim()          // 新增：已有思考内容
  || message.toolCalls?.length        // 新增：有任何工具调用（含 running）
  || message.forms?.length
  || message.media?.length
  || message.artifacts?.length,
)
```

字段来源（`src/types/fleet.ts:456-466`）：`thought?: string`、`toolCalls?: ToolCallBadge[]`。

其余判定逻辑（`user.delivery === 'failed'` 跳过、`requestId`/`runId` 配对、老历史按顺序配对）**保持不变**。

## 4. 不改的东西（明令禁止）

1. 不改 `AgentChatThread.vue` 的 `receiptStyles`（图标/文案/颜色）
2. 不改 `messageReceipts` 的优先级（`replied` > `delivery` > 默认 `sent`）
3. 不改 `delivery` 状态机（`sending` / `sent` / `failed` 的赋值位置）
4. 不改模板、样式、aria-label
5. 不改 `messageSegments.ts`、`fleet.ts`、任何后端 / agent-node 代码
6. 不 commit、不改版本号

## 5. 边界行为（必须成立）

| 场景 | 期望 |
| --- | --- |
| assistant 只有工具调用、无文字 | 双勾 ✅（本次修复目标） |
| assistant 只有思考、无文字无工具 | 双勾 ✅ |
| assistant 刚开始流式、`thought` 和 `toolCalls` 都还空 | 仍单勾（等第一个思考块/工具帧到达才变双勾） |
| assistant 回复失败 / 空消息 | 单勾（不变） |
| user 消息 `delivery === 'failed'` | 感叹号，不参与 replied（不变） |
| 历史消息能配对到 assistant | 按新规则判定（历史里带 thought/toolCalls 的也变双勾） |

## 6. 门禁（自己跑并贴结果）

```bash
npx vue-tsc --noEmit -p tsconfig.json
npm run test:fleet
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
