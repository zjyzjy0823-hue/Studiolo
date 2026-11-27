# SPEC：待发消息投递状态机 + 插话（steer）逻辑修复

> 状态：待实现（实施者：agy / Gemini，验证者：riri）
> 范围：仅 Studiolo 前端（Vue 3 + Pinia），不动 agent-node / Core / Hermes。

## 0. 一句话目标

运行中发送的消息，**要么真正发出去，要么明确告诉用户"未确认"**；任何情况下都不允许静默停在「发送中…／待发送」里不动。

---

## 1. 事故复盘（2026-11-26 12:32–12:42）

| 时间 (CST) | 事实 | 证据 |
|---|---|---|
| 12:32:17 | 上一回合正常结束（running=false） | `session_events` seq 12586/12587 |
| 12:32–12:42 | Hermes 与 agent-node 侧**零** `prompt.submit` / `prompt.accepted` | `~/.hermes/logs/agent.log`、`session_events.db` |
| 12:40 | 用户发送「让agy分析一下看看」，UI 显示 `发送中…` + `待发送(1)` | 用户截图 |
| 12:41:07 | 客户端重新拉 SessionHistory（此时回合早已结束） | `studiolo-audit-core.log` |

结论：消息从未落到服务端；客户端把它**永久停在本地 outbox**。

## 2. 已确认根因

1. `src/stores/fleet.ts:3944-3956`：会话被判定为 running 时，`flushOutbox` 会先尝试插话；插话被拒后只清 `transmittingOutbox`，**`attemptedOutboxSteers`（:375）永不清除**，之后每次 flush 都跳过该条 → 永久「待发送」。
2. `agent-node/agent_node/daemon.py:1988-2019`：插话被拒时**带机器可读 code**：
   - `idle` = 当前没有运行中的回合（**语义是"直接正常发送"，不是"稍后重试"**）
   - `unsupported` = 该 provider 不支持插话
   - `not_redirected` = 上游未接受（**可能已排队，重发有重复风险**）
   - `failed` = 抛错
3. `src/stores/fleet.ts:1860-1864` 把上面所有情况一律压成 `finish(false)`，**丢掉了 code**，因此无法区分「该直接发」和「可能已重复」。
4. 投递没有超时：`prompt.send` 写出后没有 Accepted 也不会变状态，`delivery: 'sending'` 可以永远不变；对比 `cancelSessionRun`（:4241-4263）已有 12 秒「代理尚未确认停止」的兜底，发送侧没有。
5. `src/stores/fleet.ts:3936`：`if (!route || wsState !== 'online') return` 静默返回，UI 仍显示绿点 + 「待发送」。

## 3. P0 —— 必须实现（缺一不可）

### P0-1 抽出纯函数决策层（可单测）

新文件 `src/services/outboxPolicy.ts`，无任何 Vue/Pinia 依赖，导出：

```ts
export type BusySendMode = 'auto' | 'queue' | 'interrupt'

export type OutboxWaitReason =
  | 'offline' | 'no-route' | 'node-offline' | 'steer-pending' | 'interrupting'

export type OutboxDecision =
  | { kind: 'send' }
  | { kind: 'steer' }
  | { kind: 'queue'; reason: 'mode-queue' | 'attachments' | 'steer-unsupported' }
  | { kind: 'interrupt' }
  | { kind: 'wait'; reason: OutboxWaitReason }

export interface OutboxPolicyInput {
  online: boolean
  routeReady: boolean
  nodeOnline: boolean
  sessionRunning: boolean
  provider: string
  hasAttachments: boolean
  steerPending: boolean
  steerBlocked: boolean   // 本回合已经试过一次插话（防止死循环）
  busySendMode: BusySendMode
  interruptPending: boolean
}

export function decideOutboxAction(input: OutboxPolicyInput): OutboxDecision
```

判定顺序（必须按此顺序，测试逐条覆盖）：

1. `!online` → `wait('offline')`
2. `!routeReady` → `wait('no-route')`
3. `!nodeOnline` → `wait('node-offline')`
4. `!sessionRunning` → `send`（**空闲时永远直接发**，不再进插话分支）
5. `busySendMode === 'queue'` → `queue('mode-queue')`
6. `busySendMode === 'interrupt'` → `interruptPending ? wait('interrupting') : interrupt`
7. `hasAttachments` → `queue('attachments')`
8. `provider !== 'hermes'` → `queue('steer-unsupported')`
9. `steerPending` → `wait('steer-pending')`
10. `steerBlocked` → `queue('mode-queue')`
11. 否则 → `steer`

### P0-2 插话结果按 code 分流（核心修复）

```ts
export type SteerPlan =
  | { kind: 'accepted' }
  | { kind: 'resend' }                                  // idle：回合已结束，立刻正常发送
  | { kind: 'queue' }                                   // unsupported：退回排队
  | { kind: 'unconfirmed'; message: string }            // 其余：可能已排队，禁止自动重发

export function planSteerOutcome(accepted: boolean, code?: string | null): SteerPlan
```

- `accepted` → `accepted`
- `code === 'idle'` → `resend`
- `code === 'unsupported'` → `queue`
- 其余（`not_redirected` / `failed` / 空 / 超时）→ `unconfirmed`，`message = '插话未确认：上游可能已排队，未自动重发。'`

store 侧改动：

- `pendingSteers` 的 finish 回调由 `(accepted: boolean)` 改为 `(accepted: boolean, code?: string)`；在 `fleet.ts:1860-1864` 把 `frame.code` 透传（`SteerRejected` 帧本来就带 code，`send_back` 会自动补 `requestId`）。
- `flushOutbox` 的插话分支按 `planSteerOutcome` 执行：
  - `accepted` → 出队 + `appendSteerUserMessage`（保留现状）
  - `resend` → **立即**调用正常发送路径 `sendPromptToSession(...)`（同一 item，requestId 不变）
  - `queue` → 从 outbox 移除并 `enqueuePrompt(...)` 进待发队列
  - `unconfirmed` → 标记 item `unconfirmed`、`lastError = message`、不自动重发
- 删除 `attemptedOutboxSteers` 的"永不清理"语义，改为 `steerAttemptedRunId`：
  - `flushOutbox` 判定 `steerBlocked = item.steerAttemptedRunId === runningBySession[key]`
  - 在 `turn.ended`（`runningBySession` 清除处，:3025 与 :3134 两处）和 `reconnect`（:1873 `wsState='online'` 之后）清除该字段
  - 手动「重试」也清除

### P0-3 未确认状态 + 发送看门狗

- `FleetOutboxItem` 增加：`unconfirmed?: { code?: string; at: number }`（`src/stores/fleet.ts` 的类型定义处）。
- `ChatMessage.delivery` 联合类型增加 `'unknown'`；`src/components/chat/AgentChatThread.vue:1108-1114` 的 `receiptStyles` 增加：
  `unknown: { icon: 'alert', label: '发送未确认', statusText: '发送未确认' }`
- 常量：`export const SEND_ACK_TIMEOUT_MS = 30_000`、`export const STEER_ACK_TIMEOUT_MS = 15_000`（放在 `outboxPolicy.ts`，store 引用）。
- 行为：进入 transmitting（`prompt.send` 或 `prompt.steer`）时记录 `startedAt`；超时仍无 Accepted/回执 →
  - 清 `transmittingOutbox`
  - item 标 `unconfirmed`，气泡 `delivery = 'unknown'`
  - `lastError = '发送未确认：连接可能已断开，请重试或还原到输入框。'`
- `flushOutbox` 必须**跳过** `item.unconfirmed` 的条目（永不自动重发，这条是防重复的硬约束）。

### P0-4 不再静默等待 + 待发送面板可操作

- `flushOutbox` 遇到 `wait` 分支时写入新状态 `outboxWaitReason`（`ref<Record<string, OutboxWaitReason | undefined>>`，按 sessionKey），供 UI 显示：
  - `offline` / `no-route` → 「重连后发送（N）」
  - `node-offline` → 「节点离线，等待重连（N）」
  - `steer-pending` → 「等待插话回执…（N）」
  - `interrupting` → 「正在中断当前回合…（N）」
- `AgentChatThread.vue:2964-2975` 的待发送面板：
  - 标题文案改为按 `outboxWaitReason` 映射（无原因时保持「待发送」）
  - 每一行在 `item.unconfirmed` 时显示「未确认」标记，并提供两个按钮：`重试`（清除 unconfirmed + steer 标记后重新 flush）与既有的`还原到输入框`
- `sendWsCommand` 失败（返回 false）时不能再只抛异常后静默：必须落到 `lastError` 或 `unconfirmed`。

### P0-5 重连后先校正再 flush

- `:3612` `reconcileRuntime(sKey, { type: 'SessionHistory', active: snapshot.running, ... })` 之后，若该会话 `running=false` 且 outbox 有未确认以外的条目 → 调一次 `flushOutbox()`。
- 目的：不允许"历史说空闲、outbox 还躺着"的状态持续存在。

## 4. P1 —— 可选（P0 全绿后再做，做不完就在交付里说明）

- 显式 `busySendMode`（`auto` / `queue` / `interrupt`），持久化到 `localStorage`（key 形如 `studiolo:busy-send-mode`），默认 `auto`。
- composer 发送按钮旁一个小下拉（不是大改版）：自动 / 排队 / 中断。`interrupt` 选中时，运行中发送 = 先 `prompt.cancel`，收到 `turn.ended` 后再发（复用 P0 的 `interrupting` 等待态）。
- 若认为 UI 风险大，可只做 store + 本地存储、UI 留 TODO，但**必须在交付里写明**。

## 5. 测试要求（必须自己先跑）

新增 `tests/outbox-policy.test.mjs`（纯函数，node:test + assert/strict）：

- `decideOutboxAction` 的 11 条判定顺序逐条断言（含边界：空闲 + 离线 → wait('offline') 优先于 send）
- `planSteerOutcome`：accepted / idle / unsupported / not_redirected / 空 code 五种
- `deliveryTimedOut(startedAt, now, timeoutMs)` 边界（相等、超 1ms）

`tests/fleet.test.mjs` 增加至少 2 个 store 级用例（沿用现有 MockSocket + `t.mock.timers` 风格）：

- 插话被拒 `code='idle'` → 随后必须发出 `prompt.send`
- 插话被拒 `code='not_redirected'` → **不得**自动发 `prompt.send`，且 outbox 条目仍在（unconfirmed）

`package.json` 增加：
```json
"test:outbox": "node --experimental-strip-types --test tests/outbox-policy.test.mjs"
```

验收门槛（缺一不可）：
1. `npm run test:outbox` 全绿
2. `npm run test:fleet` 全绿（原有 20+ 用例不得回归）
3. `npx vue-tsc --noEmit` 无报错
4. 不得新增运行时依赖

## 6. 明确不做（越界即返工）

- 不改 `agent-node/**`、`core/**`、Hermes 任何代码（code 字段已经存在，前端透传即可）
- 不改协议帧结构、不改 Core 路由、不改加密/上传链路
- 不做 UI 大改版（配色/布局/新页面）
- 不提交 git、不打 tag、不改版本号、不动 `package-lock.json` 以外的依赖文件
- 不重排/格式化无关代码（diff 只应包含本 spec 涉及的行）

## 7. 交付格式（结尾必须给）

1. 改动文件清单 + 每条改动的 `文件:行号`
2. `npm run test:outbox`、`npm run test:fleet`、`npx vue-tsc --noEmit` 的真实输出摘要（通过/失败数）
3. 若对 spec 有合理偏离，逐条说明原因并指出依据的代码行
4. 未完成项（尤其 P1）单独列出

---

## 8. 实施后修订（riri 复核 2026-11-26）

agy 实现后复核发现三处必须补齐，已由 riri 直接修正：

1. **`flushOutbox` 需从 store 导出**：新用例要直接驱动 flush，store 的 return 中补齐 `flushOutbox`（`src/stores/fleet.ts` return 块）。否则 `TypeError: fleet.flushOutbox is not a function`。
2. **`planSteerOutcome` 增加第 5 种结果 `retry-later`**：`not_sent`（socket 不可用，帧根本没发出）与 `pending`（同会话已有插话在途）不属于"未确认"，不能标 unconfirmed（否则要人工重试）。语义：清 `steerAttemptedRunId`，留在 outbox 等下次 flush / 重连。`steerPromptToSession` 相应地在这两种情况下返回 `not_sent` / `pending`。
3. **测试里不能用 `setTimeout` 等异步**：`fixture(t)` 用 `t.mock.timers.enable({ apis: ['setTimeout'] })` 冻结了定时器，`await new Promise(r => setTimeout(r, 0))` 会永久挂起（父用例 20s 超时）。改用未被 mock 的 `setImmediate`。
