# 附件预览（internet inbox preview）规格 v1

## 1. 问题

用户发图后，`agent-node/agent_node/adapters/base.py` 的 `merge_prompt_with_attachments()` 会把附件拼成一段纯文本追加到 prompt：

```
[附带文件]
- [已解密附件] photo-20261126-122032.jpg (image/jpeg): /Users/zjy/Projects/.studiolo-inbox/ea846c52-....jpg
```

这段文本被当作**用户消息正文**保存并同步回客户端，于是：

1. 聊天气泡里显示的是路径文字（用户看不到图片）；
2. 重新进入会话后没有任何 artifact 可用于渲染缩略图。

目标：**历史会话里用户发的图片能显示缩略图**（Core 出预览 URL），非图片附件显示文件名芯片。

## 2. 服务端（backend/app/fleet/routes.py）

新增只读路由：

```
GET /api/v1/fleet/inbox/preview?node_id=<AgentNode.id>&path=<绝对路径>
```

鉴权：`Depends(current_user)`；节点必须属于当前用户（`AgentNode.id == node_id and user_id == user.id`），否则 404。

校验（全部满足才返回，否则 404/400，不泄露路径是否存在）：

1. `Path(path).expanduser().resolve(strict=True)` 成功，且是普通文件；
2. 文件大小 ≤ 20 MiB；
3. 解析后的真实路径中**包含** `/.studiolo-inbox/` 片段；
4. 真实路径位于 `node.allowed_roots_json` 中任一目录的真实路径之下（`os.path.commonpath` 或 `Path.is_relative_to`）；
5. 扩展名白名单：`.jpg .jpeg .png .gif .webp .bmp .heic .pdf .txt .md .csv .json .zip`（其余返回 400）。

响应：`FileResponse(path, media_type=<由扩展名推断>)`，头 `Cache-Control: private, max-age=86400`。

## 3. 客户端

### 3.1 解析（src/services/messageSegments.ts）

新增导出：

```ts
export interface AttachmentNote { name: string; mime: string; path: string }
export function parseAttachmentNote(text: string): { cleaned: string; files: AttachmentNote[] }
```

- 匹配**位于文本末尾**的块：`/\n*\[附带文件\]\n((?:- \[(?:已解密附件|加密附件票据)\][^\n]*\n?)+)\s*$/`
- 每行解析：`- [已解密附件] {name} ({mime}): {path}`；`- [加密附件票据] {name} (id=xxx)` 无路径，`path` 置空。
- `cleaned` = 去掉该块并 `trimEnd()` 的正文。

### 3.2 渲染

- `buildTurnRenderItems()` 处理 `type: 'text'` 时先 `parseAttachmentNote`：
  - 用 `cleaned` 作为正文（若 `cleaned` 为空则不产出 text 项）；
  - 每个附件产出一个新 item：`{ type: 'attachment-note', id, name, mime, path }`
- `ThreadRenderItem` 增加该类型；`AgentChatThread.vue` 渲染：
  - `mime.startsWith('image/')` 且 `path` 非空 → 缩略图（最大 220×220，圆角，点击打开现有图片预览）；
  - 否则 → 芯片 `📎 {name}`（点击 emit `openFile`，行为与现有附件一致）。
- 缩略图取图：新增 `src/composables/useInboxPreview.ts`
  - `resolveInboxUrl(nodeId, path)`：用 `fleet` 的 route（`origin` + `token`）`fetch(`${origin}/api/v1/fleet/inbox/preview?node_id=...&path=...`, { headers: { Authorization: `Bearer ${token}` } })` → `blob()` → `URL.createObjectURL`；
  - 以 `${nodeId}:${path}` 为 key 缓存，`onScopeDispose` 不主动 revoke（会话内复用）；
  - 失败（404/网络）→ 回退为芯片，不抛错到 UI。
  - 并发上限 4，避免一次拉太多。

## 4. 测试

- `tests/attachment-note.test.mjs`（纯函数）：
  1. 标准单附件块 → cleaned 正文正确、files 1 条、name/mime/path 正确；
  2. 多附件块 → 2 条；
  3. 正文中间出现 `[附带文件]`（不在末尾）→ 不剥离；
  4. 加密票据无路径 → `path === ''`；
  5. 无块 → `cleaned === 原文`、files 空。
- `npm run test:fleet`、`test:worklog`、`npx vue-tsc --noEmit` 全绿。

## 5. 边界与不做的事

- 只改 `backend/app/fleet/routes.py`、`src/**`、`tests/**`；**不改** agent-node 的 `merge_prompt_with_attachments()`（协议保留，仅客户端负责展示剥离）。
- 不新增依赖。
- 不改同步协议、不改数据库结构。
- Core 与 agent-node 不同机时该接口自然 404，客户端回退为芯片（可接受）。
- 不做缩略图压缩/服务端转码，直接返回原文件。
