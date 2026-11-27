# 下载体验：圆形进度 + 打开方式 + 完成打勾 v1

## 1. 目标（用户原话）

1. 「下载的时候加个圆形的进度条，**聊天和下载页都要**」
2. 「点击的时候没有跳出打开方式」→ 点下载记录（以及聊天里已下载的附件）应弹出系统「打开方式」
3. 「下载完成之后也没有一个下载完成的提示，就**下载完给文件打个勾**吧」

## 2. 范围

- 前端 `src/**`、`tests/**`、`package.json`
- Android 原生：`src-tauri/android/AndroidDownloads.kt`（源文件）与 `src-tauri/src/android.rs` / `lib.rs` 的命令注册
- **不改** agent-node / backend；不新增 npm/cargo 依赖；不 commit

## 3. A · 圆形进度条

### 3.1 进度来源

`src/services/fleet.ts` 的 `fetchHermesMedia()` 目前 `await response.blob()`，无进度。改为：

```ts
export interface MediaProgress { loaded: number; total: number | null }

async function readWithProgress(response: Response, onProgress?: (p: MediaProgress) => void): Promise<Blob>
```

- 有 `response.body` 时用 `getReader()` 循环 `read()`，逐块累加 `loaded`，`total` 取 `Content-Length`（没有则 `null`）
- 每收到一块调用 `onProgress({ loaded, total })`；**节流到 ~10 次/秒**（用时间戳判断，不要每块都 setState）
- 无 `body`（老浏览器）时退化为 `response.blob()`，只发一次 `{loaded: sizeBytes, total: sizeBytes}`

`fetchHermesMedia` 增加可选参数 `onProgress`，向下透传到 `blobResult(...)` 那条路径；`externalResultFromPayload`（外链）分支不报进度。

### 3.2 进度状态

新增 `src/services/downloadProgress.ts`（纯状态，无 UI）：

```ts
export type DownloadPhase = 'downloading' | 'saving' | 'done' | 'failed'
export interface DownloadProgressState { phase: DownloadPhase; percent: number | null; loaded: number; total: number | null }
export function createDownloadProgressStore() { ... }  // set/clear/subscribe
export function percentOf(loaded: number, total: number | null): number | null  // null=不确定态
```

- `percentOf` 规则：`total` 为空或 ≤0 → `null`；否则 `Math.min(100, Math.max(0, Math.floor(loaded / total * 100)))`
- 保存阶段（`saveBlobToDevice`）置 `phase='saving'`（百分比保持 100）

### 3.3 UI

新增 `src/components/chat/DownloadRing.vue`：

- props: `percent: number | null`、`phase`、`size`（默认 22px）
- SVG 双圆：底环 `--border`，进度环 `--accent`，`stroke-dasharray` + `stroke-dashoffset` 随百分比变化，`transform: rotate(-90deg)` 从 12 点开始
- `percent === null` 时进度环用 `stroke-dasharray: 8 6` + `animation: spin 1s linear infinite`（不确定态）
- `phase === 'done'` 渲染 ✓（`--ok` 颜色）；`failed` 渲染 ✕（`--warn`）
- 尺寸用 `calc(<n>px * var(--fs))` 或固定 px 都可，但**禁止**裸 `font-size: <n>px`（有守卫测试），文字若用则 `calc(9px * var(--fs))`

接入点：

1. `src/components/chat/InlineAttachmentCard.vue`：点「下载」后，按钮位置显示 `DownloadRing`，完成后切成 ✓（保留原下载按钮的 aria-label 与 title）
2. `src/components/settings/DownloadHistory.vue`：每条记录的左侧图标位在下载中显示 `DownloadRing`，完成后显示 ✓（现在 status='saved' 即完成）

### 3.4 完成后打勾

- 下载记录 `status` 语义已存在（`saved`），无需改结构；下载页对 `saved` 显示 ✓ 图标 + `title="已保存"`
- 聊天附件卡下载成功后保持 ✓ 状态（组件内 state，不新增持久化）
- 成功时仍走现有 `emit('action', '已保存到 Download/Studiolo')`

## 4. B · 点击弹「打开方式」

### 4.1 Android 原生（`src-tauri/android/AndroidDownloads.kt`）

新增命令 `openDownload(invoke)`：

- 入参：`name`（文件名）或 `displayPath`（`Download/Studiolo/xxx`）
- Android Q+：用 `MediaStore.Downloads` 查询 `RELATIVE_PATH='Download/Studiolo'` 且 `DISPLAY_NAME=name` 的最新一条 → 得到 `content://` Uri
- Q 以下：`File(Environment.DIRECTORY_DOWNLOADS, "Studiolo/<name>")` → `FileProvider.getUriForFile(host, "${packageName}.fileprovider", file)`（FileProvider 已在 `AndroidMedia.kt` 用过，authorities 已存在于 manifest）
- `Intent(ACTION_VIEW).setDataAndType(uri, mime).addFlags(FLAG_GRANT_READ_URI_PERMISSION or FLAG_ACTIVITY_NEW_TASK)` → `host.startActivity(Intent.createChooser(intent, "打开方式"))`
- 找不到文件 → `invoke.reject("文件不存在", "download_missing")`；无应用可打开 → catch `ActivityNotFoundException` 并 reject `no_viewer`
- 成功 `invoke.resolve(JSObject().put("opened", true))`

### 4.2 Rust（`src-tauri/src/android.rs` + `lib.rs`）

- 新增 `#[tauri::command] pub(crate) async fn android_open_download(state, name: String, display_path: Option<String>) -> CommandResult<bool>`，走同一个 `AndroidDownloads` 插件句柄调用 `openDownload`
- 在 `lib.rs` 的 `invoke_handler` 里注册（**必须确认这一行，交付时给出 文件:行号**）

### 4.3 TS

`src/services/saveDownload.ts` 新增：

```ts
export async function openSavedDownload(record: { name: string; displayPath?: string }): Promise<void>
```

- Android：`androidInvoke('android_open_download', { name, displayPath })`；失败把错误码转成人话（`download_missing` → 「文件已被移动或删除」，`no_viewer` → 「没有能打开这种文件的应用」）
- 非 Android：保持现有行为（用 `Blob` URL 打开不了历史文件，直接提示「仅 Android 支持打开已下载文件」）

接入：`DownloadHistory.vue` 行点击 → `openSavedDownload(record)`；`InlineAttachmentCard` 已下载（✓）状态点击同样调用。

## 5. 测试

新增 `tests/download-progress.test.mjs`（顶层 test 块）：

1. `percentOf(0, 1000) === 0`、`percentOf(500, 1000) === 50`、`percentOf(1000,1000) === 100`
2. 超出范围钳制：`percentOf(2000,1000) === 100`、`percentOf(-5,1000) === 0`
3. 未知总长：`percentOf(123, null) === null`、`percentOf(123, 0) === null`
4. 进度 store：set → 订阅者收到；clear → 收到 undefined；重复 set 相同值不重复通知
5. 节流函数（若抽成纯函数 `shouldReport(now, lastAt)`）：间隔 < 100ms 不报，≥100ms 报

`package.json` 增加 `test:downloads`。

## 6. 验收

- `npm run test:downloads`、`test:fleet`、`test:timestamps`、`test:cors` 全绿；`npx vue-tsc --noEmit` 0 报错
- `node scripts/android-prepare.mjs` 成功（把 Kotlin 源同步到 gen）
- 交付说明必须给出：改动文件清单 + `android_open_download` 在 `lib.rs` 的注册行号 + Kotlin `openDownload` 的行号
- 不 commit
