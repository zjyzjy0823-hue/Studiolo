# SPEC：下载白名单——本会话工具写过的文件也能下载

## 问题（已实测）

手机上的附件卡片显示正常，点下载必然 `403 media_forbidden`（Core 日志实测三条 403）。

原因：两边判定不一致。

- 客户端 `src/services/messageSegments.ts:383`：只要「本消息有 `write/create/save/export` 类工具调用，且 input 里有 filePath/path/file/target_file/filename，并且正文里点名了该路径或文件名」→ 渲染成可下载卡片
- 服务端 `agent-node/agent_node/hermes_media.py:29 references_attachment()`：只认正文里的 `MEDIA:` / `@file:` / `@image:` 标记

于是「Agent 写过但没用 MEDIA 标记」的文件：有卡片、点了 403。

## 要做的改动（只改 agent-node）

### 1. 记住「本会话工具写过的文件」

在 Hermes 适配器里维护 `session -> set[绝对路径/原始路径字符串]`：

- 从事件流里的 `ToolCall` / `ToolCallUpdate` 提取；工具名小写后包含 `write`/`create`/`save`/`export`
- 路径取自入参的 `filePath` / `path` / `file` / `target_file` / `filename`，必须是字符串且不含 `://`
- 与客户端判定保持**同一套规则**（照抄上面那段的条件，不要自创）
- 会话维度存放；节点重启后可从 `session.transcript` 的历史行回填（同样逻辑跑一遍）

### 2. 授权检查放行这一类

在 `relay_hermes_attachment()` 里，把判定改成：

```
references_attachment(live_history, reference)          → 放行（现状）
或  reference 属于「本会话工具写过的文件」
   且 某条 assistant 消息正文里包含该路径或它的 basename  → 放行
否则走原来的历史校验 → 仍可能 403
```

- 第二条必须**同时**满足「工具写过」和「正文点名」，与客户端一致，不要放宽
- basename 匹配只在「工具写过该文件」的前提下生效，避免 `README.md` 这种泛匹配被滥用

### 3. 安全边界不变

仍然受三层约束，任何一层不过就拒绝：

- `open_session_file()` 的 `allowedRoots` + `cwd` 校验
- `max_bytes`（当前 32MB，超了 413）
- 符号链接、目录穿越的既有防护

### 4. 不要做的事

- 不要引入「任意路径白名单」「根目录放行」
- 不要改 `max_bytes`
- 不要改客户端、不改协议字段

## 测试（真跑并贴输出）

`agent-node/tests/` 追加：

1. 工具写过 + 正文点名 → 放行，能取到字节
2. 工具写过但正文没点名 → 拒绝（403），保持客户端/服务端一致
3. 正文点名但工具没写过、也没有 MEDIA 标记 → 拒绝
4. 路径在 `allowedRoots` 外 → 403
5. 超过 `max_bytes` → 413
6. 节点重启场景：从 `session.transcript` 回填后仍能放行
7. 既有 71 项测试全绿

## 禁止

- 不改 `src/`、`backend/`
- 不 commit、不 push、不重启服务
- 不为让测试变绿放宽断言

## 交付

改动文件与意图 / 真实测试输出 / 「与 SPEC 不一致 / 没做到 / 有风险」
