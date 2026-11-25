# 任务书：P10b —— 客户端接上 session.older（窗口化后的向上翻页）

## 一、背景

P10（`agent-node` 侧）已经完成：

- `session.snapshot` / `session.history` 默认窗口化（最近 40 轮 / ≤120 条），返回 `hasMoreBefore` 与 `beforeCursor`
- 新增 RPC `session.older`（参数 `{ session_id, before_cursor, limit }`）
- Core 已加透传路由：`POST /api/v1/fleet/nodes/{node_id}/session/older`（body 用 `session_id`，兼容 `sessionId`）

**但客户端"加载更早历史消息"仍在走旧路径**，没有用上窗口化游标。

## 二、要做的（只改 `src/`）

### 1. `src/services/sessionSync.ts`

新增：

```ts
export async function fetchOlder(opts: {
  rpc: (method: string, params: unknown) => Promise<unknown>
  sessionKey: string
  beforeCursor: string
  limit?: number
}): Promise<{ messages: ChatMessage[]; hasMoreBefore: boolean; beforeCursor?: string }>
```

- 调 `session.older`，参数 `{ sessionKey, beforeCursor, limit }`（**先读 `sessionSync.ts` 里现有 `session.snapshot` 的调用风格对齐字段名**，不要自造）
- 返回结构按服务端：`messages` / `hasMoreBefore` / `beforeCursor`

### 2. `src/stores/fleet.ts`

- epoch 模式下用户点「加载更早历史消息」→ 调 `fetchOlder`，把结果**拼接到列表头部**（去重按消息 id）
- 用返回的 `hasMoreBefore` 控制按钮是否还出现
- **legacy 模式完全不变**
- 失败时静默保留现有列表，给出 `lastError` 提示即可（不要清空）

### 3. 不做的事

- 不改服务端、不改 Core
- 不改用户消息/工具卡片渲染
- 不引入依赖

## 三、测试（真跑并贴输出）

1. `fetchOlder` 正常返回 → 解析出 messages/hasMoreBefore
2. 拼接去重：已有 20 条，翻回 30 条其中 5 条重复 → 结果 45 条且顺序正确（旧的在前）
3. `hasMoreBefore: false` → 按钮状态正确
4. 失败 → 列表不变、有错误提示
5. legacy 模式不受影响（调用计数为 0）
6. `node --test tests/` 全绿（现有 253 项，1 项 skip 保持）、`npx vue-tsc --noEmit` exit 0

## 四、硬约束

只改 `src/` 与 `tests/`；不 commit、不打包。

## 五、交付

改动文件与行号 / 真实测试输出末尾 / 「没做到或与任务书不一致的地方」
