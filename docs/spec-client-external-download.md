# SPEC：客户端支持大文件外链下载（0.8.8 第一片）

## 现状（已提交 54aa075）

- 节点：>32MB 附件发布到 AList，`resolve` 的结果带 `external: true / url / expiresAt / sizeBytes / fileName`
- Core：`POST /api/v1/fleet/media/redeem` 遇到外链型返回 **307 + Location + Cache-Control: no-store**；外链过期返回 **410**
- **客户端还没改**，所以现在 `redeem` 会拿到 307，`response.blob()` 直接把重定向页当附件

## 目标

点「下载」时，大文件**不再经过 fetch + blob**（现在是先把整个文件读进内存再 base64 传原生，大文件必炸），而是把 AList 直链交给系统下载器。

## 一、TS：识别外链

`src/services/fleet.ts` 的 `fetchHermesMedia`：

1. `redeem` 请求必须**不自动跟随重定向**：`fetch(..., { redirect: 'manual' })`
2. 如果返回 `307`：
   - 读 `Location` 头；为空则抛错（不要静默回退）
   - 返回外链结果，**不要** `response.blob()`
3. `410` 保持现有语义：重新 `resolve` 再试一次（现有逻辑已如此）
4. 返回值改成判别联合，例如：
   ```ts
   type HermesMedia =
     | { kind: 'blob'; blob: Blob }
     | { kind: 'external'; url: string; fileName?: string; sizeBytes?: number }
   ```
   所有调用点都要跟着改，**不允许**用 `any` 绕过类型检查

## 二、TS：交给系统

1. `src/stores/fleet.ts` 的 `downloadArtifactToBrowser` / `readHermesAttachment` 调用点分流：
   - `kind === 'blob'` → 现有 `saveBlobToDevice`
   - `kind === 'external'` → 调新的 `openDownloadUrl(url)`（见下）
2. 新增 `openDownloadUrl(url: string)`：
   - Android（`isAndroidLocal()`）→ invoke 新命令 `android_open_download_url`
   - 桌面 → `window.open(url, '_blank', 'noopener')`
3. 预览（`purpose: 'preview'`）仍然只走 blob；万一返回外链，按“无法预览”处理并提示，不要打开浏览器

## 三、Rust：新增命令

`src-tauri/src/android.rs`（或合适的模块）+ `lib.rs` 注册：

```rust
#[tauri::command]
async fn android_open_download_url(app: tauri::AppHandle, url: String) -> Result<(), String>
```

- 校验 URL：只允许 `http` / `https`，拒绝其他 scheme（防 `file://`、`javascript:`）
- 用已经在依赖里的 `tauri-plugin-opener`：`app.opener().open_url(url, None::<&str>)`
- 桌面端同名命令可复用同一实现（跨平台都能用），TS 侧就不必分叉
- 在 `invoke_handler` 里注册

## 四、UI（最小改动）

`src/components/chat/ArtifactPill.vue`：

- 外链下载成功交给系统后，状态文案改成「已交给下载器」
- 按钮在请求中保持 disabled（现有 `downloading` 已够，别新增并发）
- **不要**在这一片做下载列表 UI（下一片单独做）

## 五、测试（必须真跑并贴输出）

1. `tests/*.test.mjs` 新增：
   - 307 → 解析出 external（用假的 fetch 返回 `{status:307, headers:{Location}}`）
   - 307 但缺 Location → 抛错
   - 410 → 重新 resolve 一次（沿用现有用例风格）
   - blob 路径不变
2. `npx vue-tsc --noEmit` 必须 **0 错误**
3. `node --test tests/` 全绿

## 六、禁止

- 不改 `backend/`、`agent-node/`
- 不打包 APK、不 `cargo build`（太慢，我后面自己打）
- 不用 `any` / `@ts-ignore` 压类型错误
- 不 commit、不 push

## 七、交付

改动文件与理由 / 真实测试输出 / “与 SPEC 不一致 / 没做到 / 有风险”
