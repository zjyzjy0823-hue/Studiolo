# SPEC · 空闲会话主动消息转发（agent-node）

- 版本：v1（2026-11-23）
- 实施者：Codex（`gpt-6.2-sol`, effort=high）
- 前置：`8ed0b41` 已把 hermes adapter 换到 `/api/ws`，但读取是按需的

## 1. 问题

`daemon.py` 的 `emit` 回调只存在于 `prompt.send` 的调用栈里。Hermes 在**空闲时**（没有 prompt 在等）产生的消息——例如后台任务完成后 agent 主动发的汇报——没有任何入口转发到前端，所以手机上永远看不到。

## 2. 目标

会话空闲时，agent-node 能发现 Hermes 侧新增的 assistant 消息并推给前端。

**采用轮询方案**（不改现有流式读取，风险最低）：

- 只轮询「本节点已打开、且当前没有活跃 run」的会话
- 每 2 秒一次 `session.transcript`（或 `session.events.since`，取现有实现里更合适的）
- 与内存里记录的最后一条消息 id 比对，发现新的 assistant 消息就推送
- 推送后更新游标，不重复推

## 3. 实现

### 3.1 `agent-node/agent_node/adapters/hermes_ws.py`

新增：

```python
async def fetch_transcript(self, *, session_id: str, limit: int = 20) -> list[dict]:
    """读取会话最近若干条消息（用于空闲时检测新消息）。"""
```

- 走已有的 WS 连接（复用 `_ensure_connection` 或等价方法）
- 返回按时间正序的消息列表，每条至少含 `id` / `role` / `text` / `created_at`
- 失败返回空列表，不抛（轮询任务不应因单次失败中断）

### 3.2 `agent-node/agent_node/daemon.py`

新增后台任务（在节点启动时创建，节点关闭时取消）：

```python
IDLE_TRANSCRIPT_INTERVAL_SECONDS = 2.0

async def _idle_transcript_watcher(self) -> None:
    """空闲会话轮询：把 Hermes 主动产生的 assistant 消息推给前端。"""
```

要求：

1. 遍历 `self.adapters`，只处理 `provider == "hermes"` 且实际是 WS 实现的 adapter（`hasattr(adapter, "fetch_transcript")`）
2. 对每个已知会话（`self.sessions` 或等价结构）：
   - 跳过 `self._active_runs` 里的会话（回合中由现有流负责）
   - 跳过 5 秒内刚有新事件的会话（避免与流式重复）
3. 拉 transcript → 找 `role == "assistant"` 且 id 未见过的最新一条
4. 有新消息时发送事件（复用现有事件类型，不要新增白名单以外的类型）：

```python
await send_back({
    "type": "TextDelta",
    "nodeId": ...,
    "provider": "hermes",
    "sessionId": sid,
    "text": text,           # 整条消息文本
    "messageId": msg_id,    # 供前端去重
    "idle": True,           # 标记来源：空闲补发
    "requestId": f"idle-{msg_id}",
})
```

5. 记录已推过的 `messageId`（每个会话保留最近 50 个，`OrderedDict` 或 `deque + set`），防重复

### 3.3 前端去重（必要）

`src/stores/fleet.ts` 的 WS 事件处理里：若收到带 `idle: True` 和 `messageId` 的事件，且当前会话的最后一条 assistant 消息 id 相同或文本已包含该内容，则忽略。

- 不要新增 UI 元素
- 不要改动现有 `TextDelta` 的合并逻辑（只是加一个提前 return）

## 4. 不改的东西

1. 不改 `send_prompt` 的流式读取
2. 不改 Core 白名单（`TextDelta` 已在册）
3. 不改 `hermes.py`（ACP 实现）
4. 不改审批/插话/取消逻辑
5. 不 commit

## 5. 门禁

```bash
cd agent-node && python -m pytest -q
npx vue-tsc --noEmit -p tsconfig.json
npm run test:fleet
```

补 2 个单元测试：

- transcript 返回新消息 → 产生一次推送；再轮询同样的消息 → 不重复推
- 会话有活跃 run 时 → 跳过

## 6. 交付格式

```markdown
## 改动文件
- path:line — 一句话

## 门禁结果
- 命令 → 实际输出摘要

## 与 SPEC 的不一致
- 无 / 逐条说明
```
