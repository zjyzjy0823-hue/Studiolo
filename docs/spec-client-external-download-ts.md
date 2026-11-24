# SPEC（缩小版）：客户端识别外链下载 —— 只做 TS 部分

上一轮同类任务在“读代码”阶段卡死过一次，所以这轮**只做 TypeScript**，Rust 命令我自己写。

## 目标

点「下载」时，大文件不再经过 `fetch → blob → base64`，而是把服务端给的 AList 直链交给系统。

## 现状

- Core：`POST /api/v1/fleet/media/redeem` 对外链型返回 **307 + Location + Cache-Control: no-store**；外链过期 **410**
- 客户端现在会 `response.blob()`，把重定向页当附件存下来

## 一、`src/services/fleet.ts`

`fetchHermesMedia`：

1. `redeem` 请求必须 `redirect: 'manual'`
2. 返回 `307` → 读 `Location` 头 → 返回外链结果；**Location 为空要抛错**
3. `410` → 保持现有逻辑（重新 resolve 再试一次）
4. 返回值改成判别联合：
   ```ts
   export type HermesMediaResult =
     | { kind: 'blob'; blob: Blob }
     | { kind: 'external'; url: string; fileName?: string; sizeBytes?: number }
   ```
   不允许 `any` / `@ts-ignore`

## 二、`src/stores/fleet.ts`

- `readHermesAttachment`：预览仍只要 blob；如果服务端返回外链，**不要**返回 blob，按错误抛出（提示“该附件需要下载后在浏览器中查看”）
- `downloadArtifactToBrowser`：`kind === 'external'` 时调用 `openDownloadUrl(url)`；`kind === 'blob'` 走现有 `saveBlobToDevice`
- 新增 `openDownloadUrl(url: string)`：
  - 校验 `new URL(url).protocol` 必须是 `http:` / `https:`，否则抛错
  - **直接复用已有的 `src/utils/openExternal.ts` 的 `openExternal(url)`**（它已经做了同样校验，并且在 Android 上调用已注册的 `open_external_url` 命令）——不要再新增任何原生命令，不要改 `src-tauri/`

## 三、`src/components/chat/ArtifactPill.vue`

- 外链下载成功 → 状态文案「已交给下载器」
- 不要新增并发控制，沿用现有 `downloading`

## 四、测试（真跑并贴输出）

`tests/` 下用现有 `node --test` 风格新增：

1. 307 + Location → 返回 `{kind:'external', url}`
2. 307 但没有 Location → 抛错
3. 410 → 重新 resolve 一次
4. blob 路径行为不变

另外必须跑：
- `node --test tests/`
- `npx vue-tsc --noEmit`（必须 0 错误）

## 五、禁止

- 不碰 `src-tauri/`、`backend/`、`agent-node/`
- 不 commit、不 push、不打包
- 不改动无关文件

## 六、交付

改动文件 / 真实测试输出 / 与 SPEC 不一致处
