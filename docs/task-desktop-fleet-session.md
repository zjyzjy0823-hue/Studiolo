# 任务书：桌面端 Fleet 会话持久化 + 建连观测（B 方案）

> 目标仓库 `/Users/zjy/Projects/Nexa-LumaDock`，分支 `feat/reconnect-follow`。
> 只改下面点名的文件。**不要 commit、不要重启任何服务、不要碰版本号。**

## 背景（已由诊断确认）

1. 桌面端每次启动都要重新「登录 Core 对话」，因为 Core 会话只存在内存：
   `src/stores/fleet.ts:176` 的 `coreSession` 是 `ref(...)`，`:219` 赋值后再无持久化。
2. 桌面端启动后 Fleet WebSocket 从未在 Core 侧留下握手记录，且所有失败分支都静默：
   `connectNative`（`src/stores/fleet.ts:1341`）里 `invoke('fleet_connect')` 的失败只写
   `lastError`，Rust 侧 `connect_async` 失败只回 `Reconnecting`，错误原因被丢弃。
3. `watch(() => auth.token, ...)`（`src/stores/fleet.ts:814`）在 token 变化时无条件清空
   `coreSession`，会把「刚恢复的会话」也清掉。

## 要实现的五件事

### 1. 新增 `src/services/coreSessionStore.ts`

纯函数 + 可注入 storage，便于单测：

```ts
export interface CoreSessionRecord {
  origin: string; token: string; localToken: string; workspaceId: string; coreUrl: string
}
export const CORE_SESSION_STORAGE_KEY = 'studiolo:core-fleet-session'
export interface StorageLike { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

export function isCoreSessionRecord(value: unknown): value is CoreSessionRecord
export function loadCoreSession(storage?: StorageLike | null): CoreSessionRecord | null
export function saveCoreSession(session: CoreSessionRecord | null, storage?: StorageLike | null): void
export function clearCoreSession(storage?: StorageLike | null): void
export function coreSessionMatches(
  session: CoreSessionRecord | null | undefined,
  context: { localToken: string | null | undefined; workspaceId: string | null | undefined; coreUrl: string | null | undefined },
): session is CoreSessionRecord
```

要求：
- 五个字段必须都是非空字符串才算合法；不合法时 `load` 顺手清掉脏数据并返回 `null`
- `JSON.parse` 失败不抛异常
- storage 不可用（隐私模式 / `setItem` 抛错）时静默降级，绝不抛
- 默认参数用 `typeof localStorage === 'undefined' ? null : localStorage`

### 2. `src/stores/fleet.ts` 接入持久化

- `coreSession` 初始值改成 `ref<CoreSessionRecord | null>(loadCoreSession())`（同时删掉原来的内联类型）
- `fleetRoute` 里那串三重判断替换为 `coreSessionMatches(session, { localToken: auth.token, workspaceId: core.workspaceId, coreUrl: core.coreUrl })`
- `signInToCoreFleet` 成功赋值后追加 `saveCoreSession(coreSession.value)`
- 三处清空 `coreSession.value = null` 的位置同步调用 `clearCoreSession()`：
  1. `watch(() => auth.token, ...)`（约 `:814`）
  2. `loadNodes` 的 401 分支（`if (linkedCore.value && err instanceof ApiError && err.status === 401)`）
  3. `connectionLost` 的 4401 分支

### 3. 修掉启动误清

`watch(() => auth.token, ...)` 现在的条件是 `if (!nextToken || nextToken !== prevToken)`。
改成：
- `nextToken === prevToken` 直接 return
- 只有「登出（`!nextToken`）」或「`coreSession.localToken !== nextToken`」才清 `coreSession`
- `clearSessionMemory()` 与 `nodes.value = []` 保持原有触发条件（登出 / 有旧 token 的切换），避免启动时把刚恢复的会话冲掉

### 4. 登录后显式建连

- `src/components/chat/FleetCoreSignIn.vue:18`：`await fleet.signInToCoreFleet(...)` 成功后立刻 `fleet.connectSocket()`
- `connectSocket` 已在 store 返回对象里（约 `:5324`），不需要新增导出

### 5. 让失败原因可见（关键，别再静默）

- 新增模块级函数（放在 `createRequestId` 之后）：

```ts
let lastRouteTrace = ''
export function traceFleetRoute(reason: string, detail: Record<string, unknown> = {}): void {
  const signature = `${reason}|${JSON.stringify(detail)}`
  if (signature === lastRouteTrace) return
  lastRouteTrace = signature
  console.info(`[fleet] 路由不可用：${reason}`, detail)
}
```

- `fleetRoute` 两个 `return null` 分支分别调用它，带上原因与关键字段
  （`localToken` 是否存在、`coreConnection` 是否存在、`session/core` 的 workspaceId、localToken 是否一致）
- `connectNative`：`invoke('fleet_connect', ...)` 前打印 `console.info('[fleet] 发起原生连接', { url, id })`；
  `.catch` 里打印 `console.error('[fleet] fleet_connect 失败', error)` 并把原因写进 `lastError`（保持现有中文文案风格）
- `src-tauri/src/fleet.rs`：给 `FleetEvent::Reconnecting` 增加 `reason: Option<String>`（`#[serde(tag = "event", rename_all = "snake_case")]` 保持不变），
  在 `connect_async` 的分支里捕获错误文本：
  - 超时 → `handshake timeout`
  - `Ok(Err(e))` → 按 `tungstenite::Error` 分类给出短文本（TLS / IO / HTTP 状态 / 其他 `e.to_string()`）
  并在 `Disconnected::Retry` 分支发送 `FleetEvent::Reconnecting { reason }`
- 前端 `NativeFleetEvent`（`src/stores/fleet.ts:131`）改成
  `{ event: 'frame'; frame: FleetWsEvent } | { event: 'reconnecting'; reason?: string | null } | { event: 'unauthorized' }`，
  收到带 `reason` 的 reconnecting 时把 `lastError.value` 设成 `Fleet 重连中：<reason>`（无 reason 维持现状）

## 约束

- 不要动 UI 布局、不要改文案风格、不要新增依赖
- 不要碰 `package.json` / `tauri*.conf.json` 的版本号（已有改动是别人的）
- localStorage 里保存的是 Core JWT：只存本模块定义的五个字段，**不要**附加任何用户信息
- Rust 改动只允许 `src-tauri/src/fleet.rs`，不要动 Cargo.toml

## 验收（必须自己跑并贴真实输出）

1. `node --test tests/core-session-store.test.mjs`（新增，≥8 个用例）
   覆盖：合法读写、脏 JSON、字段缺失、storage 抛错、`coreSessionMatches` 的四种不匹配
2. `npm test`（或仓库现有前端全量测试命令）全绿
3. `npx vue-tsc --noEmit` exit 0
4. `cargo check --manifest-path src-tauri/Cargo.toml` 通过
5. 交付时单列：改了哪些文件、每个改动的 `文件:行号`、与任务书不一致之处及原因

## 明确不做

- 不改 `nativeTransport` 的判定（是否回退浏览器 WS 由后续决定）
- 不加超时/心跳/巡检
- 不处理 sidecar 的 409 workstation setup 历史遗留
