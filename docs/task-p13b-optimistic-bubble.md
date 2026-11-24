# 任务书：P13b —— 点发送立刻出气泡（上传在后台）

## 一、现状（已定位）

- `sendPromptToSpecificSession`（fleet.ts:3823）→ 存 outbox → `flushOutbox()`
- 气泡是在 `sendPromptToSession`（fleet.ts:3588）里 append 的，**而这发生在附件上传完成之后**
- 所以带图时：点发送 → 输入框清空 → **屏幕上什么都没有** → 上传完（几秒到几十秒）→ 气泡才出现

用户的原话：「点发送后直接消失了，过一会才出来，带照片更久」。

## 二、目标

**点发送的那一帧就出现气泡**，上传与发送在后台进行，气泡状态如实反映进度。

## 三、做法

### 1. 立即插入乐观气泡（核心）

在 `sendPromptToSpecificSession` 里，**在任何 await 之前**（拿到 `sKey` 与 body 之后立刻）：

```
appendMessage(sKey, {
  id: `user-${id}`, requestId: id, role: 'user',
  nodeId: session.nodeId, provider: session.provider,
  text: body, delivery: 'sending', createdAt: Date.now(),
})
```

- `id` 必须是本次发送的稳定 id（outbox item 的 id / 无 storage 分支生成的 requestId）
- **同一 id 只能存在一条**：`appendMessage` 前先按 id 去重

### 2. 让后续发送复用同一个 id

`sendPromptToSession` 里的 `appendMessage` 已有守卫：

```
if (appendUser && !messagesBySession.value[sKey]?.some(row => row.id === `user-${reqId}`)) …
```

要求：把 outbox item 的 `id`（或上面生成的 id）**作为 requestId 传进去**，让守卫命中、不重复插入。
附件上传完成后，把 `artifacts` 挂到**同一条**消息上（按 requestId 定位并更新），不要新建气泡。

### 3. 状态可见

- `delivery: 'sending'` → 气泡显示「发送中…」（若附件正在上传，显示「上传中…」）
- 成功后 `sent`，「发送中」消失
- 失败 → `failed`，给出重试入口（复用现有失败样式；若没有就只标记颜色，不加新交互）

**如果现有组件不支持这些文案**：允许在消息气泡右下角加一个小字号状态文字，**不要改整体布局与样式体系**。

### 4. 不做的事

- 不伪造 `ArtifactRef`（它需要上传后的 digest/key），附件卡片等上传完成后自然出现
- 不新增 `pendingFiles` 之类的新字段（除非现有类型已支持）
- 不改 Core / 节点 / `src-tauri/`
- 不动 P13a 的 `preservePendingMessages`（它保证刷新不丢，本任务是保证一开始就有）

## 四、测试（真跑并贴输出）

1. 发送带附件消息：**上传未完成时**气泡已在列表里，`delivery==='sending'`
2. 上传完成 → 同一条消息（id 不变）变成 `sent`，附件挂在它上面，**列表里只有一条**
3. 上传失败 → 该条变 `failed`，气泡不消失
4. 纯文本发送：气泡立即出现，成功后 `sent`
5. 连续发两条：两条独立，顺序按 createdAt
6. `node --test tests/` 全绿（现有 243 项不得减少）、`npx vue-tsc --noEmit` exit 0

## 五、硬约束

只改 `src/` 与 `tests/`；不引入依赖；不 commit、不打包。

## 六、交付

改动文件与行号 / 真实测试输出末尾 / 「没做到或与任务书不一致的地方」
