# 任务书：P3a —— 能力协商 + 客户端增量续传（默认关闭）

> 前置：P2 已提交（`9417d0c`），节点与 Core 已提供 `session.snapshot` / `session.events.since`。
> 本轮第一次动客户端，**必须把改动限制在一个可开关的接缝里**，旧路径保持原样。

## 一、目标

让客户端可以「按 `(epoch, seq)` 续传」，而不是靠现在的帧缓冲/快照抢占。但**默认仍走旧路径**，用开关切换。

## 二、Core：能力协商

1. 客户端连 WS 后的首个请求（或 `hello`）里带能力：
   ```json
   { "capabilities": ["session.events.v1"] }
   ```
2. Core 记录该连接是否支持 v1，并通过 `NodeReady`/`Ready` 回执里返回 `serverCapabilities`（含 `session.events.v1`）。
3. 支持 v1 的连接：**不得**再收到 `SessionStreamReplay` 等旧式重放帧（避免双份数据）；不接受 v1 的连接行为完全不变。
4. 加一条测试：**声明 v1 的连接不会收到旧重放帧；未声明 v1 的连接收到的帧与今天逐字段一致**。

## 三、客户端：独立接缝（关键约束）

**不要改 `fleet.ts` 现有的任何逻辑分支**，只做两件事：

1. 新增 `src/services/sessionSync.ts`（纯 TS，可单测），导出：
   ```ts
   export type SyncMode = 'legacy' | 'epoch'
   export interface SessionSync {
     open(sessionKey: string): Promise<void>          // snapshot → 投影
     resume(sessionKey: string): Promise<void>        // events.since(lastSeq) → 投影
     syncAll(): Promise<void>
   }
   export function createSessionSync(opts: {
     mode: SyncMode
     rpc: (method: string, params: unknown) => Promise<unknown>
     apply: (sessionKey: string, snapshot: unknown) => void
     append: (sessionKey: string, events: unknown[]) => void
   }): SessionSync
   ```
2. 在 `fleet.ts` 里**只加一个分支**：当 `syncMode === 'epoch'` 时，`session.subscribe` 改调 `sessionSync.open()`；否则完全走原逻辑。
   - `syncMode` 来源：`localStorage['studiolo.syncMode']`，默认 `'legacy'`；也支持 URL `?syncMode=epoch` 便于真机调试。

3. `sessionSync` 的行为要求：
   - `open`：调 `session.snapshot`；若响应 `replay_incomplete` → **抛错并提示调用方回退 legacy**（该会话降级，不影响其它会话）
   - `resume`：调 `session.events.since(epoch, lastSeq, limit=500)`；按 `hasMore` 循环直到拉完
   - 去重：维护 `lastSeqBySession`，`seq <= lastSeq` 的事件直接丢弃
   - epoch 变化：清空该会话的 lastSeq 并重走 `open`
   - 任何 RPC 失败：抛错，由调用方决定是否回退 legacy（不静默吞掉）

## 四、测试（真跑并贴输出）

`tests/session-sync.test.mjs`（node --test，假 rpc）：

1. open → 快照落到 apply
2. resume → 只 apply `seq > lastSeq`，且按 seq 升序
3. `hasMore` 分页循环（两页）
4. epoch 变化 → 重新 open，lastSeq 归零
5. `replay_incomplete` → 抛错，调用方可捕获回退
6. 重复事件被丢弃（同一 seq 两次）

另外：

- `npx vue-tsc --noEmit` **exit 0**
- `node --test tests/` 全绿
- backend 能力协商测试全绿

## 五、禁止

- 不改 `src/stores/fleet.ts` 里除「新增一个分支」以外的逻辑
- 不删任何现有补丁代码（P3b 才删）
- 不改 `src-tauri/`、不改 UI 组件
- 不 commit、不打包、不重启服务
- 默认必须 `legacy`，**装到手机上不选 epoch 时行为与今天一致**

## 六、交付

改动文件 / 真实测试输出 / 「与任务书不一致 / 没做到 / 有风险」
