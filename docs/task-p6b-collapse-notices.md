# 任务书：P6b —— 系统通知折叠成一行

## 一、背景

P6（`e21e4eb`）已经把这些通知从「用户气泡」改成了 `role: 'system'`，但**整段原文仍然直接铺开**：

```
[IMPORTANT: Background process proc_c68e9eebbd91 completed normally (exit code 0).
Command: cd /Users/zjy/Projects/Nexa-LumaDock && export VITE_SYNC_MODE=epoch ...
```

一条就占大半屏。目标：**默认一行，点开看全文**。

## 二、要做的

### 1. 新增摘要函数（`src/services/systemNotices.ts`）

在现有 `classifySystemNotice` 基础上增加：

```ts
export interface SystemNoticeSummary {
  title: string        // 例：后台任务已完成
  detail?: string      // 例：exit 0 · proc_c68e9eebbd91
  failed: boolean      // exit code 非 0，或文本含 failed/失败
  command?: string     // 从 Command: 后面取，截断到 60 字符
}
export function summarizeSystemNotice(text?: string | null): SystemNoticeSummary | null
```

要求：

- 仍只对**已识别为通知**的文本返回（复用 `classifySystemNotice` 的判定，避免扩大误判面）
- 提取 `exit code (\d+)`；`0` → `failed: false`，非 0 → `failed: true`；没有 exit code 时 `failed: false`
- 提取 `proc_[A-Za-z0-9]+` / `deleg_[A-Za-z0-9]+` 放进 `detail`
- `Command:` 之后的内容取第一行、截断 60 字符（不足不加省略号）

### 2. 渲染（`src/components/chat/AgentChatThread.vue`）

在现有 system 消息分支（约 `:2512`，`msg.role === 'system' && !msg.systemEvents?.length`）内部区分：

- `summarizeSystemNotice(msg.text)` 有值 → 渲染**折叠行**：

```
🔧 后台任务已完成 · exit 0 · proc_c68e…        ﹀
```

  - 默认收起，**只占一行**
  - 点一下展开，显示完整原文（等宽字体、可复制）
  - `failed: true` → 红色文字 + 「失败」标识
  - 子代理批次通知用 `🤖`，后台任务用 `🔧`

- 没有命中的 system 消息 → 保持现状，**一行都不要改**

### 3. 不做的事

- 不改 P6 的分类逻辑与三处接入点
- 不改节点/Core
- 不加"全局隐藏"开关（后续再说）
- 不动用户气泡与助手消息的样式

## 三、测试（真跑并贴输出）

1. `summarizeSystemNotice`：exit 0 → 不失败；exit 1 → failed；无 exit code → 不失败
2. 命令截断到 60 字符；`proc_`/`deleg_` 提取正确
3. 非通知文本 → 返回 null
4. 渲染：折叠行默认存在，完整原文默认**不在** DOM 里（展开后才出现）（用现有 Vue SSR 测试方式）
5. 普通 system 消息渲染不受影响
6. `node --test tests/` 全绿（现有 249 项，含 1 项 skip，不得新增失败）、`npx vue-tsc --noEmit` exit 0

## 四、硬约束

只改 `src/` 与 `tests/`；不引入依赖；不 commit、不打包。

## 五、交付

改动文件与行号 / 真实测试输出末尾 / 「没做到或与任务书不一致的地方」
