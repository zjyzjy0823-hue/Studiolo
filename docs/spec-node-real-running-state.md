# SPEC：节点回报「真实运行状态」，让客户端插话能触发

## 问题（已实测，有证据）

现象：手机在「某个回合正在跑」时发消息，客户端走的是**普通发送**（`prompt.send`），节点去问 Hermes，Hermes 回「在跑」→ 节点抛 `ValueError: 当前会话已有任务运行中` → 手机收到 `Failed`（实测连续 28 次），消息被退回输入框，插话完全没触发。

根因：节点回答 `session.subscribe` 时，`active` 只查自己的 `self._active_runs`：

```python
# agent_node/daemon.py  session.subscribe 分支
is_active = key in self._active_runs
...
"active": is_active,
```

`_active_runs` 只包含**客户端经节点发起**的回合。以下回合不在其中，但 Hermes 里确实在跑：

- 后台任务完成通知触发的回合
- cron 触发的回合
- 其它 surface（TUI/ACP）发起的回合

于是 replay 告诉手机 `active=false` → 手机认为空闲 → 走普通发送 → 被拒。

## 实测可用的探针

在 Hermes gateway 上实测（`20261123_215747_38c00c`，该回合确实在跑）：

- `session.status` → `4001 session not found`（不可用）
- `session.state` / `session.info` / `session.get` → `-32601 unknown method`
- **`session.resume`（`{"session_id": ..., "omit_messages": True}`）→ 返回里有 `running: true`**，字段包括：
  `inflight, info, message_count, messages, messages_omitted, resumed, running, session_id, session_key, started_at, status, turn_started_at`

## 要做的改动（只动 agent-node）

1. **适配器新增探针**（`agent_node/adapters/hermes_ws.py`）：

```python
async def session_running(self, *, session_id: str) -> bool | None
```

- 走已有连接 `await self._online()`，调用 `session.resume`（`omit_messages=True`，超时 8s）
- 返回 `bool(result.get("running"))`；异常/超时 → 返回 `None`（表示「不知道」，调用方回退到 `_active_runs`）
- **加短 TTL 缓存（2 秒）**，避免客户端频繁 subscribe 时把 resume 打成风暴；缓存键 = session_id
- 不得改动 `_active` / `_sessions` 的既有语义；不要把探针结果写进 `_active_runs`

2. **`session.subscribe` 分支用真实状态**（`agent_node/daemon.py`）：

```python
is_active = key in self._active_runs
if not is_active and isinstance(adapter, HermesAdapter):
    probed = await adapter.session_running(session_id=sid)
    if probed is not None:
        is_active = probed
```

- `runId` 仍从 `self._session_streams` 取（探针不提供 runId，没有就保持 `None`）
- 探针失败不能影响 replay 本身（回退到原逻辑）

3. **`session.active.list`（ActiveRunsSnapshot）**：把探针判定为 running 的会话也列进去（有 stream 信息就带上，没有就 `runId: null`）。如果实现成本明显超过收益，可以不做，但要在交付里说明。

## 测试（必须真跑并贴输出）

在 `agent-node/tests/` 里加用例：

1. `_active_runs` 为空、适配器探针返回 `True` → `session.subscribe` 的 replay 里 `active == true`
2. 探针返回 `False` → `active == false`
3. 探针抛异常/返回 `None` → 回退为 `_active_runs` 的结果，不报错
4. TTL 缓存：2 秒内连续两次 subscribe 只调用一次 `session.resume`
5. 既有测试全绿：`../.venv/bin/python -m pytest tests/ -q`

## 禁止

- 不改协议字段名、不改 `src/`、不改 `backend/`
- 不 commit、不 push、不重启任何服务
- 不为让测试变绿而放宽断言

## 交付

- 改动文件与意图
- 真实测试输出
- 单独列出「与 SPEC 不一致 / 没做到 / 有风险」
