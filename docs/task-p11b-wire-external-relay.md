# 任务书：P11b —— 把外部回合的事件真正接到客户端（agy 执行）

## 一、现状（已验证）

`cb40fc9` 里已经有：

- `HermesWsAdapter.on_session_event` 回调字段与分支（`_deliver` 里，非本节点发起的回合会调它）
- `ExternalTurn`（daemon.py:79）、`GatewayEventNormalizer`（hermes_replay.py）、`SessionEventUpdate`（session_events.py）

**但功能是死代码**：

- daemon **从未给 `adapter.on_session_event` 赋值**
- 因此没有任何帧发到 Core/客户端
- 客户端仍然只能靠 2 秒轮询

## 二、要做的（两件事，做完必须真机见效）

### 1. 注册回调（daemon.py）

在拿到 `HermesWsAdapter` 实例的地方（`_adapter_for` / provider 初始化处）执行：

```python
if isinstance(adapter, HermesWsAdapter):
    adapter.on_session_event = self._on_external_session_event
```

要求：**幂等**（重复注册不叠加），且不能在事件循环里做阻塞操作。

### 2. 实现 `_on_external_session_event(session_id, params)`

把网关原生事件映射成**客户端已经能渲染的帧**，再经现有 `self._send_ws(...)` 发给 Core。

客户端现成的帧契约（**照这个来，不要发明新形状**，来源 `src/stores/fleet.ts:2353-2400`）：

| 帧 | 必填字段 |
|---|---|
| `TextDelta` | `type, text, runId, requestId, sessionId, provider` |
| `ThoughtDelta` | 同上，`text` 为思考内容 |
| `ToolCall` | `type, callId, name, status:"running", args, runId, sessionId, provider` |
| `ToolCallUpdate` | `type, callId, name, status, output, durationMs, runId, sessionId, provider` |
| `Completed` | `type, runId, sessionId, provider` |

网关事件 → 帧的映射：

| 网关 `params.type` | 帧 |
|---|---|
| `message.delta` | `TextDelta`（`text = payload.text`） |
| `reasoning.delta` | `ThoughtDelta` |
| `tool.start` | `ToolCall`（`callId = payload.call_id`，`name = payload.name`，`args = payload.args`） |
| `tool.progress` | `ToolCallUpdate`（状态 `running`） |
| `tool.complete` | `ToolCallUpdate`（`status` = success/error，`output`、`durationMs`；**没有 durationMs 时不要填 0**） |
| 回合结束（`session.info.running=false` 或 `turn.completed` 类事件） | `Completed` |

`runId` 规则：同一外部回合内稳定，用 `external-{int(turn_started_at or 首帧时间)}`，并在收到 `Completed` 后清空，下一轮重新生成。

## 三、硬约束

- **本节点自己发起的回合不允许再发一遍**（adapter 已用 `_active` 判断，daemon 侧再判一次 `key in self._active_runs`）
- 回调里任何 `await` 都必须 `create_task`，不得阻塞网关读循环
- 不改 `src/`、不改 `backend/`
- 不引入新依赖、不 commit
- 解析失败静默跳过（一条脏数据不能让连接挂掉）

## 四、测试（真跑并贴输出）

1. 注册：创建 daemon 后 `adapter.on_session_event` 不为 None（假 adapter）
2. 映射纯函数：上表六类事件各自产出正确帧（含 `durationMs` 缺失为 None 而非 0）
3. `runId` 在同一回合内稳定、`Completed` 之后下一个回合变化
4. 本地回合不重复发：`_active_runs` 有该 key 时，帧计数为 0
5. 脏事件（缺 payload / 未知 type）不抛错
6. `agent-node` 全量测试（`../.venv/bin/python -m pytest tests/ -q`）全绿

## 五、交付

改动文件 / 真实测试输出末尾几行 / **说明回调注册的确切位置（文件:行号）** / 「没做到或与任务书不一致的地方」
