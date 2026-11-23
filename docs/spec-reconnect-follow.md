# SPEC · 重连快照后恢复「跟随最新」

- 版本：v1（2026-11-23）
- 实施者：Codex（`gpt-6.2-sol`, effort=high）
- 依据：`~/.hermes/workspace/logs/codex-analyze-reconnect-compact.log`（第 7409–7457 行分析）

## 1. 问题

节点重启 / WS 断线后，`fleet.ts` 走快照分支（`snapshotRequired=true`），插入「已重连 · 切换至快照」系统行并 `loadSessionHistory`。重载期间布局变化让 `AgentChatThread.vue:932 trackMessageScroll` 测到离底 ≥32px，把 `followLatest` 写成 `false`。之后所有新回复只累加 `unseenBelowCount`，不自动滚动，用户必须大退重进。

## 2. 目标

重连完成且历史落地后，**仅对「重连前在底部、期间没有主动上翻」的视图**恢复跟随并滚到底；用户主动上翻的视图保持不动。

## 3. 改动一：`src/stores/fleet.ts`

新增按会话的「快照恢复」状态机（模块级，不进 store 暴露给组件之外）：

```ts
// 快照恢复意图：仅在重连快照路径上使用
type SnapshotFollowIntent = {
  followBefore: boolean      // 进入重连时是否在底部（由组件上报）
  cancelled: boolean         // 期间用户主动上翻 / 跳转 / 切会话
  requestId: string | null   // 本次快照对应的 history 请求
  settled: boolean
}
const snapshotFollowIntent = new Map<string, SnapshotFollowIntent>()
```

### 3.1 进入重连时记录

在 `wsState` 变为 `reconnecting`/`disconnected` 的分支（找到实际处理 WS close 的位置）里，为当前所有已打开会话登记 `{ followBefore: <由组件维护的最近一次状态>, cancelled: false, requestId: null, settled: false }`。

- 组件上报方式：在 `fleet.ts` 增加 `reportFollowIntent(sKey: string, follow: boolean)`，组件在 `trackMessageScroll` 里每次变化时调用。
- 若某会话从未上报，默认 `followBefore: true`（与组件初始值一致）。

### 3.2 快照分支（`fleet.ts:1499-1527`）接线

- 进入 `snapshotRequired` 分支时：把 `requestId` 记为本次 `loadSessionHistory(sKey, true)` 发出的 request id（该函数返回/登记 id，按现有实现取）。
- `followBefore === false` 时直接 `settled = true` 并删除记录（无需恢复）。

### 3.3 历史提交后发布完成标记

在 `SessionHistory` 最新页消息提交之后（分析定位的 `fleet.ts:1441-1444` `mergeHistoryBoundaries` 之后），若该会话存在未 settled 的 intent 且 `frame.requestId === intent.requestId`：

- `settled = true`
- 删除记录
- 触发一次组件回调：复用现有事件总线 / `appendSystemEvent` 之外的轻量机制（例如 store 内 `snapshotRestoreTick` 计数器 + 按会话的递增版本号），**不要新增消息**

空快照提前分支（分析定位的 `fleet.ts:1366`）同样结束该 intent（`settled=true`），按现有列表处理。

### 3.4 用户主动操作取消恢复

- 新增 `cancelSnapshotFollow(sKey: string)`：把 intent 标记 `cancelled=true` 并 `settled=true`。
- 调用时机（由组件调用）：
  - `scrollToMessage`（搜索/书签跳转）
  - 用户触摸/滚轮/键盘导致的真实上翻（见 4.2）

## 4. 改动二：`src/components/chat/AgentChatThread.vue`

### 4.1 上报跟随意图

在 `trackMessageScroll` 里当 `followLatest` 值变化时调用 `fleet.reportFollowIntent(effectiveKey.value, followLatest.value)`。

### 4.2 区分「布局导致的离底」和「用户主动上翻」

在快照恢复窗口内（组件知道当前会话有未 settled intent —— 通过 store 暴露的只读 `snapshotRestorePending(effectiveKey)`），`trackMessageScroll` 只接受**用户手势来源**的离底：

- 监听 `touchstart` / `wheel` / `keydown`（PageUp/ArrowUp/Home）时置一个 `userScrollIntentUntil = Date.now() + 1200`
- `trackMessageScroll` 判定离底时，若 `Date.now() > userScrollIntentUntil` 且快照恢复窗口内 → **不写 `followLatest`**（视为布局抖动）
- 窗口外行为完全不变

### 4.3 恢复跟随

监听 store 的快照完成信号（按 `sKey` 的版本号），在 `nextTick` 后校验：

- 当前 `effectiveKey` 仍匹配
- intent 未 `cancelled`
- 用户期间未主动上翻（`userScrollIntentUntil` 已过期且无新意图）

满足则调用现有 `scrollToBottomInstant()`。**不要**新增任何消息或系统行。

### 4.4 移动端按钮

**不改** `unseenBelowCount` 的展开条件（分析结论：保持现状；有计数时已自动展开为文字按钮）。

## 5. 不改的东西（明令禁止）

1. 不改 `scrollToMessage` 的既有行为（只加 `cancelSnapshotFollow` 调用）
2. 不改「新回复 (n)」的渲染与展开条件
3. 不改 `loadSessionHistory` 的分页/向上加载逻辑
4. 不改 agent-node、Core（backend/）任何代码
5. 不改 `mergeHistoryBoundaries` / `sameTurnContent` 的匹配语义
6. 不 commit、不改版本号

## 6. 边界行为

| 场景 | 期望 |
|---|---|
| 重连前在底部，期间无操作 | 历史落地后自动回到底部，新回复直接可见 |
| 重连前已上翻阅读 | **不**恢复，位置不动，「新回复」按钮照常 |
| 重连期间用户主动上翻 | 取消恢复，尊重用户 |
| 重连期间用户搜索跳转 | 取消恢复 |
| 重连后切换会话再切回 | 不重复恢复（intent 已 settled） |
| 正常历史刷新 / 向上分页 | 不触发恢复（必须只走快照路径） |
| 连续两次重连 | 第二次覆盖第一次的 intent，不叠加 |

## 7. 门禁

```bash
npx vue-tsc --noEmit -p tsconfig.json
npm run test:fleet
npm run build
```

补 2-3 个 `tests/fleet.test.mjs` 用例覆盖状态机（无 DOM 依赖的部分）：

- 快照 + followBefore=true + 无取消 → 产出恢复信号
- 快照 + followBefore=false → 不产出
- 快照 + 取消 → 不产出

## 8. 交付格式

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
