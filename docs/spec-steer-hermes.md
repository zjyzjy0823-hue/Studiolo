# SPEC · 运行中插话（Hermes steer / redirect）

- 版本：v1（2026-11-23）
- 实施者：Codex（`gpt-6.2-sol`, effort=high）
- 审查者：Hermes agent

## 1. 背景

Hermes ACP 已经实现「运行中收到第二条 prompt 就 redirect 当前回合」（`acp_adapter/server.py:776 _claim_turn_or_queue`），返回 `PromptResponse(stop_reason="end_turn")` 并通过 `session/update` 发一条 agent 文本「Redirected the active turn with your correction.」。

Studiolo 用不到，是因为 `agent-node/agent_node/daemon.py:1290` 在转发前直接 `raise ValueError("当前会话已有任务运行中")`。

目标：让 **Hermes 会话**支持运行中插话（不打断当前回合，进度保留）；其它 provider 行为不变。

## 2. 改动一：`agent-node/agent_node/adapters/hermes.py`

新增方法（放在 `send_prompt` 附近）：

```python
async def steer(self, *, session_id: str, text: str) -> bool:
    """运行中插话：把文本作为新 prompt 发给 ACP，Hermes 会 redirect 当前回合。

    不注册 self._turns、不建立 stream：redirect 的响应是同步的
    （PromptResponse stop_reason=end_turn），确认文本由 Hermes 通过
    session/update 送到正在跑的那条主回合流里。
    """
    proc = await self._ensure_acp()
    payload = {"sessionId": session_id, "prompt": [{"type": "text", "text": text}]}
    resp = await proc.call("session/prompt", payload)
    return str((resp or {}).get("stopReason") or "") == "end_turn"
```

要求：

- 用现有的 `proc.call`（与 `send_prompt` 相同的 JSON-RPC 通道），**不要**设置墙钟超时（redirect 是立即返回的；如果上游没有立即返回，说明它变成了排队或正常回合，交给现有 watchdog）
- **不要**写 `self._turns`、**不要**动 `self._turns` 里正在跑的那条
- 抛异常时让调用方处理，不要在方法内吞掉

## 3. 改动二：`agent-node/agent_node/daemon.py`

在命令分发里新增 `prompt.steer`（放在 `elif cmd == "prompt.cancel":` 附近，保持同级缩进）：

```python
elif cmd == "prompt.steer":
    sid = str(frame.get("sessionId") or "")
    text = str(frame.get("text") or "").strip()
    adapter = self.adapters.get(provider)
    steer_fn = getattr(adapter, "steer", None)
    if not text or adapter is None or steer_fn is None:
        await send_back({"type": "SteerRejected", "sessionId": sid,
                         "code": "unsupported", "message": "当前 Agent 不支持插话"})
        return
    if (provider, sid) not in self._active_runs:
        await send_back({"type": "SteerRejected", "sessionId": sid,
                         "code": "idle", "message": "当前没有运行中的回合"})
        return
    try:
        ok = await steer_fn(session_id=sid, text=text)
    except Exception as exc:  # noqa: BLE001 — 反馈给前端，不打断主回合
        await send_back({"type": "SteerRejected", "sessionId": sid,
                         "code": "failed", "message": str(exc)[:200]})
        return
    await send_back({"type": "SteerAccepted" if ok else "SteerRejected",
                     "sessionId": sid,
                     "code": "" if ok else "not_redirected",
                     "message": "" if ok else "上游未接受插话（可能已排队）"})
    return
```

要求：

- **不要**修改 `prompt.send` 分支的任何逻辑（`_active_runs` 的拦截保持原样，其它 provider 行为不变）
- **不要**创建 `SessionStream`、**不要**动 `_active_runs`
- 不 commit

## 4. 改动三：`src/stores/fleet.ts`

新增并导出：

```ts
async function steerPromptToSession(sKey: string, text: string): Promise<boolean> {
  const sess = sessionsByKey.value[sKey]
  const clean = text.trim()
  if (!sess || !clean) return false
  return sendWsCommand({
    type: 'prompt.steer',
    nodeId: sess.nodeId,
    provider: sess.provider,
    sessionId: sess.sessionId,
    text: clean,
    requestId: createRequestId(),
  })
}
```

并在 store 的返回值里导出 `steerPromptToSession`。

## 5. 改动四：`src/components/chat/AgentChatThread.vue` 队列项按钮

现状：队列每行有「立即插队」按钮 → `fleet.steerQueuedPrompt`（取消当前回合 + 重发）。

改为两个按钮：

1. **「插话」**（新，主按钮）：`await fleet.steerPromptToSession(effectiveKey, item.text)`；
   - 成功 → `fleet.removeQueuedPrompt(effectiveKey, item.id)` + `emit('action', '已插话，当前回合会按新指令调整')`
   - 失败 → `emit('action', '插话失败，可改用「打断重发」')`，队列项保留
2. **「打断重发」**（原「立即插队」，改名）：调用 `fleet.steerQueuedPrompt`，行为不变

样式沿用现有 `btn btn-subtle btn-sm` 与 `queue-icon-btn`；移动端按钮 `min-height: 36px`。

## 6. 不改的东西（明令禁止）

1. 不改 `prompt.send` 的 `_active_runs` 拦截
2. 不改 Codex / OpenCode / Antigravity / dsh 的任何代码
3. 不改 `fleet.ts` 的 `steerQueuedPrompt`（打断重发）行为
4. 不改 `WorkLog` / `PermissionRequestCard` / 回执逻辑
5. 不改 Core（backend/）任何代码
6. 不 commit、不改版本号

## 7. 边界行为

| 场景 | 期望 |
|---|---|
| Hermes 会话运行中，点「插话」 | Hermes redirect 当前回合；主回合流里出现「Redirected the active turn with your correction.」；队列项移除 |
| Hermes 会话空闲，点「插话」 | 返回 `SteerRejected(idle)`，前端提示，队列项保留 |
| 非 Hermes provider（Codex/OpenCode） | 返回 `SteerRejected(unsupported)`，前端提示改用「打断重发」 |
| Hermes 正在压缩上下文 | Hermes 内部会排队，返回文本「Queued for the next turn」；`steer` 仍返回 true（用户会看到排队提示） |
| 插话请求本身失败（ACP 异常） | `SteerRejected(failed)`，**主回合不受影响**，必须验证这一点 |

## 8. 门禁（自己跑并贴结果）

```bash
cd agent-node && python -m pytest -q
cd .. && npx vue-tsc --noEmit -p tsconfig.json
npm run test:fleet
npm run build
```

## 9. 交付格式

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
