# SPEC：工作日志跨消息合并（方案 A，渲染层）

> 背景：重进会话后，同一轮对话被拆成多条只有工具的 assistant 消息，每条渲染一张「工作步骤」卡，彼此不合并。
> 目标：**纯展示层**把相邻的、中间没有正文的 assistant 消息折叠成一个工作步骤组；不动消息数据、不动同步、不动回执。

## 1. 合并规则（必须逐条实现）

对 `effectiveMessages` 单次扫描，把**连续**的 assistant 消息归为一组，前提是：

| 情况 | 处理 |
|---|---|
| 相邻 assistant，且除第一条外**成员都没有 text / media**（只有 tool/thought/parts 里的工具） | ✅ 合并 |
| 中间夹 user / system 消息 | ❌ 断开 |
| 任一成员有正文 text（哪怕一句「我查一下」）或 media | ❌ 断开（正文单独成气泡） |
| 成员有 `error`、`interrupted`、未决 `approvals`、`forms` | ❌ 断开（保留可操作性） |
| 两条都有 `runId` 且不相等 | ❌ 断开 |
| 正在流式的最后一条 | ✅ 可合并，保留 `streaming` / `progress` |

第一条（anchor）有正文时，它自己单独成一个普通消息气泡，**从它之后**开始尝试合并。

## 2. 纯函数契约（新代码）

在 `src/services/messageSegments.ts` 新增：

```ts
export interface ThreadRow {
  msg: ChatMessage        // 渲染用；合并组是"合成消息"，否则是原消息
  sourceIndex: number     // 在 effectiveMessages 里的原始下标（fork/branch/regenerate 依赖它）
  memberIds: string[]     // 合并组包含的消息 id（单条时为 [msg.id]）
  stepCount: number       // 组内工具步骤数（单条时为其工具数）
}

export function groupThreadTurns(messages: ChatMessage[]): ThreadRow[]
```

合成消息的构造（合并组）：
- `id` / `createdAt` / `nodeId` / `provider` / `role`：取 anchor
- `parts`：按成员顺序拼接
- `toolCalls`：按成员顺序拼接
- `thought`：按成员顺序拼接
- `text` / `media`：空（合并规则已保证成员无正文；anchor 若有正文则 anchor 不进组）
- `durationMs`：成员 `durationMs` 求和（忽略非有限值）
- `streaming`：任一成员为 true
- `runId` / `requestId` / `error` / `interrupted` / `approvals` / `forms`：取**最后一条成员**（操作按钮作用在最后一轮）
- `epochSnapshot`：任一成员为 true

## 3. UI 改动

### 3.1 `src/components/chat/AgentChatThread.vue`
- 新增 `const threadRows = computed(() => groupThreadTurns(effectiveMessages.value))`
- 模板 `v-for="(msg, msgIdx) in effectiveMessages"` → `v-for="row in threadRows"`，内部统一用 `row.msg`；**所有 `msgIdx` 用法改成 `row.sourceIndex`**（共 10 处：`is-deferred-msg`×3、`switchBranch`×2、`handleForkAt`×2、`switchModelAndRetry`、`handleRegenerate` 等）。
  ⚠️ 这是本次最容易出错的地方：隐藏消息后若仍用循环下标，分支/重试/重新生成会作用到错误的消息上。
- `assistantTurns` 继续按 `row.msg.id` 建 Map（合成消息照样走 `buildThreadRenderItems`）。
- `<WorkLog :steps>` 增加 `:step-count="row.stepCount"`（仅当 >1 时显示）。
- 组的「复制/重试/分支」按钮天然挂在 anchor 渲染行上，但数据取合成消息的 `runId/requestId`（即最后一轮）。

### 3.2 `src/components/chat/WorkLog.vue`
- 新增可选 prop `stepCount?: number`
- 标题：`isEpoch` 且 `stepCount > 1` → `工作步骤 · ${stepCount} 步`；否则保持现有 `formatWorkLogDuration(durationMs) || '工作步骤'`
- 其它（流光、脉冲、展开/折叠、思考）保持不变

## 4. 测试（必须新增）

`tests/worklog-grouping.test.mjs`（node:test，纯函数，不需要浏览器）：

1. 相邻 3 条 tool-only assistant → 1 个 `ThreadRow`，`parts` 合并，`stepCount === 3`，`sourceIndex` 指向第一条。
2. 中间夹 user → 2 个 row。
3. 中间某条有 text → 断开，text 单独成行。
4. 有 `error` / `interrupted` / 未决 `approvals` → 断开。
5. 两条都有 `runId` 且不同 → 断开。
6. streaming 的最后一条 → 合并且 `msg.streaming === true`。
7. `durationMs` 求和正确；单条时 `stepCount` 等于其工具数。
8. `sourceIndex` 在合并后仍指向 `effectiveMessages` 的正确下标（用 5 条消息造数据断言）。

`package.json` 增加 `"test:worklog": "node --experimental-strip-types --test tests/worklog-grouping.test.mjs"`。

## 5. 验收

1. `npm run test:worklog` 全绿
2. `npm run test:fleet`（65）/ `test:outbox`（14）/ `test:font-scale`（3）不回归
3. `npx vue-tsc --noEmit` 0 报错
4. 只改 `src/services/messageSegments.ts`、`src/components/chat/AgentChatThread.vue`、`src/components/chat/WorkLog.vue`、`tests/worklog-grouping.test.mjs`、`package.json`
5. 不新增依赖、不改 store/网络/缓存、不 commit

## 6. 交付格式

1. `groupThreadTurns` 的实现位置（文件:行号）
2. 模板里 `msgIdx → row.sourceIndex` 的 10 处改动逐条列出（文件:行号）
3. 三条命令真实输出（test:worklog / test:fleet / test:font-scale）+ `vue-tsc`
4. 偏离说明
