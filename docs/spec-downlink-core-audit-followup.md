# 追加改动：保留「每帧都审计」，但补上投递结果字段

## 背景

阶段一已实现并通过测试（13 passed / relay 8 passed，主 agent 已复跑）。
但当前实现把 `side=core` 审计改成「只有在至少一个客户端成功入队后才写」（`backend/app/fleet/hub.py` 的 `broadcast_node_event`）。

这会**丢掉一个关键诊断能力**：今天事故里手机被静默移出广播表，如果按新逻辑，Core 侧将完全没有审计记录，只剩节点侧——下次再排查就会误判成「Core 没收到」。

## 要改成

1. `backend/app/fleet/audit.py` 的 `audit_event` 增加一个**可选**参数 `queued: int | None = None`：
   - 为 `None` 时输出格式**完全不变**（节点侧不受影响）
   - 不为 `None` 时在行尾追加 ` queued=<n>`
2. `hub.py` 的 `broadcast_node_event`：**恢复为每帧都写审计**，并把 `broadcast_workspace()` 的返回值作为 `queued=` 传进去。
3. 相应更新 `backend/tests/test_fleet_hub_backpressure.py` 里 `test_audit_is_only_recorded_after_successful_enqueue`：
   - 改名为「审计记录投递结果」类断言
   - 覆盖三种情况：`queued=1`（正常）、`queued=0`（无客户端 / target 缺失）、队列满后 `queued=0`
   - 断言节点侧格式不受影响（`queued` 为 None 时不出现该字段）

## 约束

- 只改 `backend/app/fleet/audit.py`、`backend/app/fleet/hub.py`、`backend/tests/test_fleet_hub_backpressure.py`
- 不动 `src/`、`src-tauri/`、`agent-node/`，不动阶段二的任何逻辑
- 不 commit、不 push、不重启服务
- 跑 `python -m pytest tests/test_fleet_hub_backpressure.py tests/test_fleet_relay_and_blobs.py -q` 并贴真实输出
