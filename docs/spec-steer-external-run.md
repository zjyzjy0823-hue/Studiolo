# SPEC（第二轮）：让「外部回合」也能插话——不重装 App

## 现状：第一轮只做了一半

第一轮已经能向 Hermes 探到真实运行状态（`session_running()` + replay `active`），但手机仍然插不进去，两个阻塞点（Codex 自己也指出了）：

1. **客户端只认「`active: true` 且带 `runId`」**：`src/stores/fleet.ts:880`
   ```ts
   if (frame.active && frame.runId) runningBySession.value = { ...runningBySession.value, [sKey]: frame.runId }
   else delete runningBySession.value[sKey]
   ```
   外部回合没有 runId → 客户端仍然认为空闲 → 还是走 `prompt.send`。
2. **节点 steer 只接受自己登记过的回合**：`agent_node/daemon.py:1427`
   ```python
   if (provider, sid) not in self._active_runs:
       await send_back({"type": "SteerRejected", ... "code": "idle" ...})
       return
   ```

## 已实测的事实（别推翻它）

- `session.resume`（`omit_messages=True`）返回：`running: true`、`status: 'working'`、`inflight: {...}`、`session_id: '94d958c5'`（**运行时 id**）、`session_key: <存储 id>`、`turn_started_at: ...`
- **返回里没有 run id**，所以客户端要的 `runId` 只能由节点合成。
- `session.steer` 方法存在；未加载的会话调用会返回 `4001 session not found`，所以必须先 resume。

## 要做的改动（仍然只动 agent-node）

### 1. 适配器：探针缓存带运行时信息 + 外部插话

- `session_running()` 的缓存条目从 `bool` 升级为 `{running: bool, runtime_id: str, turn_started_at: float | None, expires_at: float}`，供下面两处使用。
- 新增：
  ```python
  async def steer_external(self, *, session_id: str, text: str) -> bool
  ```
  - 取缓存的 `runtime_id`（没有就先用 `session.resume` 探一次，超时 3s）
  - 调 `connection.call("session.steer", {"session_id": runtime_id, "text": text})`（`_canonical` 为真时按现有约定带 `execution_generation`，没有就按无该字段处理）
  - 返回 `result.get("status") == "queued"`；`session_idle` / `stale_generation` / `steer_unavailable` / `4001` → 返回 False（不要抛）

### 2. 节点：replay 带上合成 runId

`session.subscribe` 分支里，当**本地没有该会话的 stream** 但探针判定 running 时：

```python
"active": True,
"runId": f"external-{int(turn_started_at or 0)}",
```

- 本地有 stream 时行为不变（用真实 runId）
- 探针失败/未知时按现状回退
- **探针超时压到 3 秒**（客户端订阅超时是 5 秒，第一轮定的 8 秒会晚于客户端放弃）

### 3. 节点：steer 接受外部回合

`prompt.steer` 分支：

```
本地 _active_runs 有 → 走现有 adapter.steer()（不变）
本地没有 → 探针 running 为真 → 走 adapter.steer_external()
           → 成功回 SteerAccepted；失败回 SteerRejected(code=not_redirected)
本地没有且探针说不在跑 → 仍回 SteerRejected(code=idle)（不变）
```

### 4. 不要做的事

- 不要改 `src/`（客户端本轮不动，靠合成 runId 兼容 0.8.7）
- 不要放宽 `_active_runs` 的语义（外部回合不进这个表，避免影响取消/统计）
- 不要改动 `prompt.send` 的既有行为

## 测试（真跑并贴输出）

`agent-node/tests/test_hermes_ws.py` 追加：

1. 本地无 stream + 探针 running → `session.subscribe` 的 replay 里 `active == true` 且 `runId` 以 `external-` 开头
2. 本地无 stream + 探针 running → `prompt.steer` 走 `steer_external`，成功回 `SteerAccepted`
3. `steer_external` 返回 False → 回 `SteerRejected(code=not_redirected)`
4. 本地无 stream + 探针不在跑 → 回 `SteerRejected(code=idle)`
5. 探针超时（>3s）→ subscribe 仍返回 replay（`active` 回退为 false，不报错）
6. 既有 56 项测试全绿

## 禁止

- 不改协议字段名、不改 `src/`、不改 `backend/`
- 不 commit、不 push、不重启服务
- 不为让测试变绿放宽断言

## 交付

改动文件与意图 / 真实测试输出 / 「与 SPEC 不一致 / 没做到 / 有风险」
