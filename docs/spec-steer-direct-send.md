# SPEC · 运行中发送即插话（去掉队列中转）

- 版本：v1（2026-11-23）
- 实施者：Codex（`gpt-6.2-sol`, effort=high）
- 前置：分支 `feat/reconnect-follow` 已含 steer（`1d28b7c`）与三层审计（`cf33b97`）

## 1. 问题

现在运行中发消息会先落到 `outbox`，`flushOutbox` 因 `runningBySession` 直接 `continue`，消息停在待发队列；用户还得再点队列项的「插话」。多一步，且不符合直觉。

## 2. 目标

**运行中直接点发送就是插话**：

- `provider=hermes` + 无附件 → 立即尝试 `prompt.steer`
- 成功 → 从 outbox 删除 + 乐观插入用户消息（Hermes 的确认文本随后走主回合流到达）
- 被拒（节点不支持 / 上游未接受）→ **留在 outbox**，回合结束后按现有 `flushOutbox` 逻辑正常发送（等价于排队）
- 其它 provider → 行为完全不变（留在 outbox 排队）

## 3. 改动：`src/stores/fleet.ts` 的 `flushOutbox`（约 2943–2970）

现有循环跳过条件包含 `runningBySession.value[item.sessionKey]`。改成：

```ts
for (const item of outbox.value) {
  const session = sessionsByKey.value[item.sessionKey]
  if (busySessions.has(item.sessionKey)) continue
  busySessions.add(item.sessionKey)
  if (!session || nodes.value.find(node => node.id === session.nodeId)?.status !== 'online'
    || transmittingOutbox.has(item.id)) continue

  if (runningBySession.value[item.sessionKey]) {
    // 运行中：Hermes 且无附件时直接插话；失败/其它 provider 留在 outbox 排队
    if (session.provider === 'hermes' && item.files.length === 0) {
      const attempt = {}
      transmittingOutbox.set(item.id, attempt)
      void (async () => {
        let accepted = false
        try {
          accepted = await steerPromptToSession(item.sessionKey, item.text)
        } catch { accepted = false }
        if (fleetRoute.value !== route || transmittingOutbox.get(item.id) !== attempt) return
        transmittingOutbox.delete(item.id)
        if (!accepted) return                 // 留给回合结束后的常规 flush
        await removeOutboxPrompt(item)
        appendSteerUserMessage(item)
      })()
    }
    continue
  }

  const attempt = {}
  transmittingOutbox.set(item.id, attempt)
  // …以下保持原样
}
```

### 3.1 新增 `appendSteerUserMessage(item: FleetOutboxItem)`

在 `flushOutbox` 附近新增：

```ts
function appendSteerUserMessage(item: FleetOutboxItem) {
  const sKey = item.sessionKey
  const id = `user-${item.id}`
  if (messagesBySession.value[sKey]?.some(row => row.id === id)) return
  appendMessage(sKey, {
    id,
    role: 'user',
    text: item.text,
    createdAt: item.createdAt,
  })
}
```

字段名与 `sendPromptToSession` 里既有的 `appendMessage` 调用保持一致（读那段代码后照抄字段，不要自创）。

### 3.2 顺带（测试稳定性）

`agent-node/agent_node/audit.py` 与 `backend/app/fleet/audit.py` 的 `audit_logger()`：在 `PYTEST_CURRENT_TEST` 环境变量存在时直接返回 `None`（测试下默认关闭审计日志，避免 I/O 拖慢时序敏感用例）。

## 4. 不改的东西

1. 不改 `steerPromptToSession` 本身（含 pendingSteers 逻辑）
2. 不改 `sendPromptToSession` / `sendPromptToSpecificSession`
3. 不改队列 UI（`AgentChatThread.vue` 不动；队列项按钮保留，供「插话被拒」或非 Hermes 场景使用）
4. 不改 agent-node 的 daemon / adapter
5. 不改 Core
6. 不 commit、不改版本号

## 5. 边界行为

| 场景 | 期望 |
|---|---|
| Hermes 运行中，纯文本发送 | 立即插话；outbox 项消失；对话里出现自己的消息 + Hermes 的确认文本 |
| Hermes 运行中，带附件发送 | 不插话，留在 outbox，回合结束后发出（排队） |
| Hermes 运行中，插话被拒 | 消息留在 outbox，回合结束后自动发出（用户不会丢消息） |
| 非 Hermes provider 运行中 | 行为完全不变（排队） |
| 连续快速发两条 | 第一条插话进行中（`pendingSteers` 有该会话）→ 第二条 `steerPromptToSession` 返回 false → 留在 outbox 排队 |
| 空闲时发送 | 走原有路径，不经过插话分支 |

## 6. 门禁

```bash
npx vue-tsc --noEmit -p tsconfig.json
npm run test:fleet
npm run build
cd backend && ../.venv/bin/python -m pytest -q tests/test_fleet_relay_and_blobs.py
cd ../agent-node && python -m pytest -q
```

## 7. 交付格式

```markdown
## 改动文件
- path:line — 一句话

## 门禁结果
- 命令 → 实际输出摘要

## 与 SPEC 的不一致
- 无 / 逐条说明

## 手动验证建议
1. …
```
