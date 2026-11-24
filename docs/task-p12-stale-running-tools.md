# 任务书：P12 —— 永久解决工具卡在「运行中」（照 Hermes Mobile 的思路）

## 一、参考实现（已读源码，照这个思路，不要发明新机制）

Hermes Mobile（Kotlin）核心只有两处：

```kotlin
/** A persisted RUNNING snapshot is not evidence of current tool activity. */
internal val ChatMessage.isToolRunning: Boolean
    get() = toolStatus == ToolStatus.RUNNING && !isHistoricalCache
```

```kotlin
// 权威的 tool-result 行结算缓存里的 tool.start，而不是反过来
if (local?.isHistoricalCache == true && local.toolStatus == ToolStatus.RUNNING) {
    local.copy(toolStatus = ToolStatus.COMPLETED, isHistoricalCache = false)
}
```

**原则：`running` 只是实时态，从持久层读回来的 running 一律不算数。** 没有超时、没有心跳、没有定时巡检。

## 二、本任务做法（比 Hermes Mobile 更省事：直接在数据层降级）

### 1. 缓存读入时降级（**主要修复**）

`src/services/messageCache.ts` 的解码/读取路径（`decodeRecord` 或 `read()` 返回前）：
把每条消息里 `toolCalls` 中 `status === 'running'` 的项改成 `'completed'`；
若 `ToolCallBadge` 类型支持额外字段，可加 `interrupted: true`（不支持就不加，别改类型）。

理由：缓存里的 running 不是证据。这样 `ToolCallCard.vue:111` 与 `WorkLog.vue:62` 都不用改。

### 2. 回合结束时收尾实时态（**当场闭合**）

`src/stores/fleet.ts`：当某会话的回合结束（现有 `Completed` / `Failed` / `running` true→false 的处理点），
把该会话**当前消息列表**里仍为 `running` 的工具改为 `completed`（同样可带 `interrupted`）。

注意：只处理该会话，只处理工具，不要动 `streaming` 的其它逻辑。

### 3. 快照权威（确认即可，可能已成立）

`src/services/epochSnapshot.ts` 应用快照时，服务端给的工具状态必须覆盖本地 running（服务端行优先）。
请自查现有实现：若已是覆盖语义，**不改**，只在交付说明里写「已确认」。

### 4. 不做的事（明确排除）

- 不加超时定时器
- 不加心跳
- 不加定时巡检
- 不改 `ToolCallCard.vue` / `WorkLog.vue` 的渲染条件（数据层已经修好）
- 不改 legacy 同步路径的行为（缓存读入降级对两条路径都生效，这是期望的）

## 三、测试（真跑并贴输出，必须覆盖）

1. 缓存的响应里含 `status:'running'` 的工具 → 读回后为 `'completed'`
2. 缓存里已是 `completed`/`error` 的保持不变
3. 回合结束：该会话 running 工具变 completed；**其它会话不受影响**
4. 回合结束不影响 `streaming` 标记与文本内容
5. 快照应用后，服务端说的 completed 不会被本地 running 覆盖
6. `node --test tests/` 全绿（现有 228 项不得减少）、`npx vue-tsc --noEmit` exit 0

## 四、硬约束

只改 `src/` 与 `tests/`；不动 `src-tauri/`、`backend/`、`agent-node/`；不引入依赖；不 commit、不打包。

## 五、交付

改动文件 + 文件:行号 / 真实测试输出末尾 / 「快照那条是本来就成立还是你改的」/ 「没做到或与任务书不一致的地方」
