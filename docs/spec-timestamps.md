# 时间戳规格（助手消息 + 工具步骤）v1

## 1. 目标

1. **助手回复**显示时间戳，位置与用户气泡一致（底部操作行最右），格式 `HH:mm`。
2. **工具调用**的时间戳显示在「工作步骤」**展开后**的每一步上，格式 `HH:mm:ss`；鼠标悬停显示该步用时。

参考 hermes Mobile 的做法：`formatTimestamp(ms, is24Hour)` → `HH:mm`；UserBubble 放在 meta 行内（alpha 0.6），ToolBubble 放在展开区右下角（alpha 0.5）；助手正文气泡它没有时间戳（本次是对它的增强）。

## 2. 范围

- 只改 `src/**` 与 `tests/**`。
- **不改** agent-node / backend / Hermes；不新增依赖；不动无关代码；**不要 commit**。
- 缺失数据一律显示 `—`，**禁止**用「消息时间 + 累计耗时」推算（会编造时间）。

## 3. A · 助手消息时间戳

- 位置：`src/components/chat/AgentChatThread.vue` 中 **assistant 气泡底部的操作行**（与 copy / branch 图标同一排），追加
  ```html
  <span v-if="row.msg.createdAt" class="num msg-time">{{ formatMsgTime(row.msg.createdAt) }}</span>
  ```
  `formatMsgTime` 已存在，直接复用（不要另写格式化）。
- 样式（scoped）：
  - `.msg-time { font-size: calc(11px * var(--fs)); color: var(--text-3); }`
  - 桌面端默认隐藏、hover 气泡显示：`.msg .msg-time { opacity: 0; transition: opacity .12s; } .msg:hover .msg-time { opacity: 1; }`
  - 移动端常显：`.mmsg .msg-time { opacity: .7; }`
- 视觉要求：不改变现有行高与对齐；用户气泡不受影响。

## 4. B · 工具步骤时间戳（展开里）

- 位置：`src/components/chat/WorkLog.vue`，`<ol class="work-log-timeline">` 里的 `<li>`，在 `ToolCallCard` 之后追加一个右对齐的时间元素：
  ```html
  <span v-if="step.type === 'tool'" class="step-time num" :title="step.tool.durationMs ? `用时 ${formatWorkLogDuration(step.tool.durationMs)}` : undefined">
    {{ step.tool.startedAt ? formatClockTime(step.tool.startedAt) : '—' }}
  </span>
  ```
  `formatWorkLogDuration` 从 `../../services/chatHelpers` 导入（已存在，勿重写）。
- 布局：`<li>` 已是 flex/grid 行结构时，把时间放在该行末尾（`margin-left: auto`），不换行、不挤压工具标题；窄屏（< 380px）可隐藏秒（`HH:mm`）——用 CSS `@media` 或截断字符串实现，二选一即可。
- 样式：`font-size: calc(10.5px * var(--fs)); color: var(--text-3); opacity: .75; font-variant-numeric: tabular-nums;`
- 只有展开时才渲染（即在 `v-if="isOpen"` 的 `<ol>` 内），收起时完全不显示。

## 5. C · 补 `startedAt`（客户端打点）

`src/types/fleet.ts` 的 `ToolCallBadge` 已有 `startedAt?: number`，无需改类型。

在 `src/stores/fleet.ts` 处理工具帧的位置（`ThoughtDelta` / `TextDelta` / `ToolCall` / `ToolCallUpdate` 附近，约 2570–2630 行）：

1. 新建 `ToolCall`：`startedAt: tool.startedAt ?? Date.now()`。
2. `ToolCallUpdate` 合并到已有条目时：**保留原有 `startedAt`**（`next.startedAt ?? prev.startedAt`），不要用更新时间覆盖。
3. 历史消息（transcript/snapshot）里已有 `startedAt` 的原样保留；没有的保持 `undefined`（UI 显示 `—`）。

## 6. 格式化函数

在 `src/services/chatHelpers.ts` 新增并导出：

```ts
export function formatClockTime(ts?: number | null, options: { seconds?: boolean } = {}): string {
  if (!ts) return ''
  const { seconds = true } = options
  return new Date(ts).toLocaleTimeString('zh-CN', {
    hour12: false, hour: '2-digit', minute: '2-digit',
    ...(seconds ? { second: '2-digit' } : {}),
  })
}
```

## 7. 测试

新增 `tests/timestamps.test.mjs`（顶层 test 块，不要塞进别的 suite）：

1. 传入毫秒时间戳 → 命中 `^\d{2}:\d{2}:\d{2}$` 且小时数正确（用固定时间戳，注意用本地时区构造：`new Date(2026, 10, 27, 9, 41, 3).getTime()`）。
2. `seconds: false` → `^\d{2}:\d{2}$`。
3. 传入 `undefined` / `0` → 返回 `''`。
4. 不抛异常（负数时间戳、`null`）。

`package.json` 增加脚本 `test:timestamps`：`node --experimental-strip-types --test tests/timestamps.test.mjs`。

## 8. 验收标准

- `npm run test:timestamps`、`test:fleet`、`test:worklog`、`test:attachment`、`test:font-scale` 全绿。
- `npx vue-tsc --noEmit` 0 报错。
- `git status` 只出现本次相关文件；不 commit。
- 交付说明里给出改动文件清单 + 关键行号（文件:行号），并说明 `WorkLog` 里时间元素的具体插入位置。
