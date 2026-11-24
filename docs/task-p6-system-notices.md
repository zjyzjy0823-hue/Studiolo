# 任务书：P6 —— 系统通知不再冒充用户消息

## 一、问题

后台任务完成、子代理批次完成时，Hermes 会把通知**以 user 角色写进会话历史**：

```
[IMPORTANT: Background process proc_124cc9eaa190 completed normally (exit code 0).
Started by subagent sa-0-b5c77b61 of delegation deleg_0327ec68. Task: "..."]

[IMPORTANT: 2 background processes completed. ...]

[ASYNC DELEGATION BATCH COMPLETE — deleg_0327ec68]
A background fan-out unit you dispatched earlier — 4 subagent(s) — has finished; ...
```

结果：客户端把它渲染成**用户气泡**，看起来像"我说了这句话"。

## 二、做法（客户端分类，同时修历史与实时）

在客户端把这类文本**归类为系统消息**（`role: 'system'`），沿用现有 system 渲染（`AgentChatThread.vue:2512` 已有 system 分支，灰底、无头像）。

**优点**：历史里的旧消息也会一起被纠正，不需要改数据库、不需要节点配合。

### 1. 新增 `src/services/systemNotices.ts`

```ts
export type SystemNoticeKind = 'process' | 'delegation' | 'batch'
export function classifySystemNotice(text: string): { kind: SystemNoticeKind; title: string } | null
```

识别规则（正则锚定开头，**不要做宽松匹配**）：

| 文本开头 | kind | title |
|---|---|---|
| `[IMPORTANT: Background process proc_… completed` | `process` | `后台任务已完成` |
| `[IMPORTANT: N background process(es) completed` | `batch` | `N 个后台任务已完成` |
| `[ASYNC DELEGATION BATCH COMPLETE — deleg_…]` | `delegation` | `子代理批次已完成` |

要求：

- 必须匹配**整段文本的开头**（`^`），避免把正常对话误判
- 只对 `role === 'user'` 的消息做判定
- 命中后整条消息转成 `role: 'system'`，**正文保留原文**（用户要能点开看细节）

### 2. 接入点（两处，都要）

- `src/services/epochSnapshot.ts`：快照消息映射时分类
- `src/stores/fleet.ts`：历史消息映射（`messagesBySession` 写入路径）分类

**注意**：不要改缓存里的原始 role（缓存应该存原始数据，分类在渲染前的映射层做），避免二次转换。

### 3. 不做的事

- 不改节点、不改 Core、不改数据库
- 不删消息内容（只改 role 与展示）
- 不动 P11 的实时转发映射

## 三、测试（真跑并贴输出）

1. 三种通知文本 → 分类正确、title 正确
2. 正常用户消息（含以 `[` 开头但不是通知的）→ 不误判
3. 快照映射：user + 通知文本 → `role: 'system'`，正文不变
4. 历史映射：同上
5. 已经是 system 的消息不被二次处理
6. `node --test tests/` 全绿（现有 231 项不得减少）、`npx vue-tsc --noEmit` exit 0

## 四、硬约束

只改 `src/` 与 `tests/`；不引入依赖；不 commit、不打包。

## 五、交付

改动文件与行号 / 真实测试输出末尾 / 「没做到或与任务书不一致的地方」
