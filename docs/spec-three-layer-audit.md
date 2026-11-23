# SPEC · 三层事件审计（节点 / Core / 客户端）

- 版本：v1（2026-11-23）
- 实施者：Codex（`gpt-6.2-sol`, effort=high）
- 目的：客户端「卡在某个工具调用没有后续」时，能在三层日志里定位事件在哪一环消失

## 1. 设计

每条事件在三个位置各留一行，字段一致、可拼接：

```
[audit] side=node|core|client session=<sid8> run=<rid8> stream=<st8> seq=<n> type=<Type> call=<callId8>
```

- `<sid8>` = sessionId 前 8 位；`<rid8>` = runId 前 8 位；`<st8>` = streamId 前 8 位；`<callId8>` = callId 前 8 位（无则 `-`）
- `seq` 是事件在该 stream 里的序号（没有则 `-`）
- 行首 ISO 时间戳（毫秒）

任何一层缺行，就是事件消失的位置。

## 2. 节点侧：`agent-node/agent_node/audit.py`（新文件）

```python
"""三层事件审计：节点侧写入独立滚动日志。"""
import logging
import os
from logging.handlers import RotatingFileHandler

_AUDIT_LOGGER: logging.Logger | None = None

def audit_logger() -> logging.Logger | None:
    global _AUDIT_LOGGER
    if _AUDIT_LOGGER is not None:
        return _AUDIT_LOGGER or None
    if os.environ.get("STUDIOLO_AUDIT", "1") == "0":
        _AUDIT_LOGGER = logging.getLogger("studiolo.audit.disabled")
        return None
    logger = logging.getLogger("studiolo.audit")
    if not logger.handlers:
        path = os.path.expanduser("~/.hermes/logs/studiolo-audit-node.log")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        handler = RotatingFileHandler(path, maxBytes=10 * 1024 * 1024, backupCount=3, encoding="utf-8")
        handler.setFormatter(logging.Formatter("%(asctime)s.%(msecs)03d [audit] %(message)s", "%Y-%m-%d %H:%M:%S"))
        logger.addHandler(handler)
        logger.setLevel(logging.INFO)
        logger.propagate = False
    _AUDIT_LOGGER = logger
    return logger

def audit_event(side: str, *, session_id: str = "", run_id: str = "", stream_id: str = "", seq: int | str = "-", event_type: str = "", call_id: str = "") -> None:
    logger = audit_logger()
    if logger is None:
        return
    def cut(v: str | None, n: int = 8) -> str:
        return (v or "-")[:n] if v else "-"
    logger.info(
        "side=%s session=%s run=%s stream=%s seq=%s type=%s call=%s",
        side, cut(session_id), cut(run_id), cut(stream_id), seq, event_type or "-", cut(call_id),
    )
```

### 2.1 接线点：`agent-node/agent_node/daemon.py`

在 **所有出站事件统一经过的 emit 包装处**（`wrapped_emit` 或等价函数；分析报告定位在 `daemon.py:1292-1309`、`1360-1380` 的 per-run 作用域）加一行：

```python
audit_event("node", session_id=sid, run_id=run_id, stream_id=stream.stream_id, seq=..., event_type=evt.get("type", ""), call_id=evt.get("callId", ""))
```

要求：
- 只在该 run 的 emit 路径调用一次（不要对每个订阅者重复记）
- 事件对象里没有的字段传空
- 单条写日志失败**绝不能**影响主流程（在 `audit_event` 内 try/except 吞掉异常）

## 3. Core 侧：`backend/app/fleet/audit.py`（新文件）

同结构，日志路径 `~/.hermes/logs/studiolo-audit-core.log`，环境变量 `STUDIOLO_AUDIT=0` 关闭。

### 3.1 接线点：`backend/app/fleet/hub.py`

在 **节点事件 → 客户端广播** 的路径上（分析报告提到的 relay 通用路径）加：

```python
audit_event("core", session_id=..., run_id=..., stream_id=..., seq=..., event_type=..., call_id=...)
```

要求：
- 有两个方向都要记吗？**只记 node → client 方向**（客户端卡住看的是这个方向）；命令方向（client → node）如果实现成本低可以一起记，标 `side=core` 加 `dir=cmd`
- 广播给多个客户端时只记一行（不要每个客户端一行）
- 失败不影响转发

## 4. 客户端侧：`src/stores/fleet.ts`

两个改动：

### 4.1 内存环形缓冲

```ts
type AuditEntry = { t: number; type: string; session: string; run: string; seq: number | string }
const auditRing: AuditEntry[] = []   // 最多 300 条
function pushAudit(entry: AuditEntry) { auditRing.push(entry); if (auditRing.length > 300) auditRing.shift() }
```

在 `handleWsEvent` 入口（或 WS onmessage 分发处）对所有事件调用 `pushAudit`，字段与后端一致（截 8 位）。

### 4.2 暴露导出

```ts
function dumpAuditLog(): string {
  return auditRing.map(e => `${new Date(e.t).toISOString()} [audit] side=client session=${e.session} run=${e.run} seq=${e.seq} type=${e.type}`).join('\n')
}
```

在 store 返回值导出 `dumpAuditLog`（供设置页/调试面板调用）。**不要**自动上报、不要新增 WS 命令。

### 4.3 设置页入口（可选，若成本低）

在设置 → 关于/诊断区块加一个「复制事件审计日志」按钮，调用 `dumpAuditLog()` 写入剪贴板并 toast「已复制」。若该区块不存在则跳过，第 4.2 足够。

## 5. 不改的东西

1. 不改任何事件语义、序号规则、重连逻辑
2. 不改白名单（审计不新增 WS 事件）
3. 不改 Core 的 relay 行为（只加旁路日志）
4. 不做日志上报、不做压缩/归档任务
5. 不 commit、不改版本号

## 6. 门禁

```bash
cd agent-node && python -m pytest -q          # 或项目既有测试
cd .. && npx vue-tsc --noEmit -p tsconfig.json
npm run test:fleet
npm run build
cd backend && ../.venv/bin/python -m pytest -q tests/test_fleet_relay_and_blobs.py
```

## 7. 交付格式

```markdown
## 改动文件
- path:line — 一句话

## 审计行示例（贴真实输出，三行能拼上）
```text
…

## 门禁结果
- 命令 → 实际输出摘要

## 与 SPEC 的不一致
- 无 / 逐条说明
```
