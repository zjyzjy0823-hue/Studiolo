# 任务书 B · 会话层 P7/P8 收尾（安全子集，行为不变）

> 目标：在不改变默认（`syncMode=legacy`）行为的前提下，把「会话运行态」判定归一（P7），
> 并清理**已证实零引用**的兼容代码（P8 安全子集）；本轮删不掉的部分必须在文档里写清删除条件。

## 已核实的事实（不要推翻，也不要试图“顺手修好”）

| 事实 | 证据 |
|---|---|
| `_active_runs` 既是并发守卫（`prompt.send` 拒绝重复回合）、也是空闲轮询跳过条件，**不能删除** | `agent-node/agent_node/daemon.py:386`，使用点 1350/1364/1874/1925/2031/2130 |
| 「运行态只信 `session.running` 事件」目前不成立：只有 Hermes WS 适配器有 `session_running()` 探针，Codex/OpenCode 没有 | `agent_node/adapters/hermes_ws.py:399`，其余 adapters 无该方法 |
| `sameTurnContent` 仍被 legacy 历史合并与发件箱保活使用，`syncMode` 默认仍是 legacy，**不能删** | `src/stores/fleet.ts:2268`、`src/services/chatHelpers.ts:941`、`fleet.ts:306` |
| `external-<ts>` 合成 runId 仍用于外部回合对账，**不能删** | `agent-node/agent_node/daemon.py:1390` |
| 帧缓冲 / 快照抢占状态机是 legacy 重连的唯一恢复路径，**不能删** | `src/stores/fleet.ts` 的 `streamStateBySession` 分支 |

## 范围

### B1（P7 归一，行为不变）

在 `agent-node/agent_node/daemon.py` 内新增两个私有方法，**用它们替换全部重复判定**：

```python
def _session_busy(self, key: tuple[str, str]) -> bool:
    return key in self._active_runs or key in self._compacting_sessions
```

```python
async def _session_running(self, adapter, key: tuple[str, str]) -> tuple[bool, int | None]:
    # 本地登记优先；未登记且 adapter 是 HermesWsAdapter 时用 session_running() 兜底
    # 返回 (是否运行, turn_started_at)
```

必须替换的位置（已核实存在，行号可能因上下文微移，用内容定位）：

- `daemon.py:1350`、`1364`：模型 / 思考档位切换的「会话忙碌」拒绝 → `self._session_busy(key)`
- `daemon.py:1377-1385`、`2042-2050`：`session.subscribe` 的 active 判定 → 调 `await self._session_running(...)`，保留 `local_active` 与 `probed_running` 的区分（其中一处注释「A local run can start while the probe is in flight.」必须保留）
- `daemon.py:1473`：`is_running = (provider, sid) in self._active_runs` → 用统一入口（若保持纯本地语义，用 `_session_busy` 并在注释写明为什么不探测）
- `daemon.py:1874`、`1925`、`1935`、`2031`、`2070`、`2130`：回合 / 流生命周期判断 → 能归一的归一，**语义不同（只看本次 run、只看 stream）的保留原样并加一行注释说明差异**
- `daemon.py:1060`：`session.active.list` 的 `self._active_runs | probed_runs` 保留 union，但本地集合的读取改走 `_session_busy`（只对 local 部分）

**不改业务语义**：同一输入下所有分支的返回值必须与改前一致。纯重构。

### B2（P8 安全清理）

用 `grep -rn` 证明**零引用**的兼容代码，然后删除。每条删除都要给证据（改前 grep 命令 + 输出）。
候选（自行核实，不限于）：`daemon.py` 中已无调用方的旧分支 / 常量、`fleet.ts` / `chatHelpers.ts` 中零引用的 helper。

**明确不要动**：`sameTurnContent`、帧缓冲 / 快照抢占状态机、`external-` runId、`_active_runs`。
如果审计结果是「没有可安全删除的代码」，就写「本轮无安全删除项」并说明为什么 —— 不要为了凑改动而删。

### B3（文档对账）

更新 `docs/plan-session-layer-rebuild.md`，在 P7、P8 两节末尾各加一段「实施状态（2026-11-25）」：

- P7：已做「运行态判定归一」（列 `文件:行号`）；未做「删除 `_active_runs`」，原因是并发守卫 + 只有 Hermes 有 `session_running()` 探针
- P8：逐项列出 `sameTurnContent` / 帧缓冲 / 快照抢占 / `external-` runId / `_active_runs` 的当前消费者，以及删除的前置条件（epoch 成为默认 + Codex/OpenCode 补探针）

## 验收（必须自己跑并贴原始输出）

1. `cd agent-node && ../.venv/bin/python -m pytest tests -q` → 与基线一致（当前基线 **193 passed**；只许增加，不许减少）
2. `npm run test:fleet` → `ℹ fail 0`（如果改了前端）
3. `grep -n "_session_busy\|_session_running" agent-node/agent_node/daemon.py` → 列出全部替换点
4. `git diff --stat` → 只包含 `daemon.py`（+ 可能的新增/修改测试、`docs/plan-session-layer-rebuild.md`）
5. `git diff` 中不得出现对 `sameTurnContent`、`external-`、`_active_runs` 的删除行

## 禁止

- 不要改 `src/` 的业务行为（B2 证明零引用的 helper 除外）
- 不要 `git add` / `git commit` / `git push`
- 不要动 `.env*`、`syncMode` 默认值、UI 组件
- 不要跑全量后端 pytest（约 12 分钟）或 `postgres_sync_integration.py`（会写数据库）

## 交付格式

1. **改动清单**：`文件:行号` + 改了什么（B2 附 grep 证据）
2. **验收输出**：1–5 条命令的原始输出片段
3. **P7/P8 剩余项表**：条目 / 当前消费者 / 删除前置条件
4. **偏离说明**：与本任务书不一致之处及原因（没有就写「无」）
