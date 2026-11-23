"""三层事件审计：节点侧写入独立滚动日志。"""

import logging
import os
import time
from logging.handlers import RotatingFileHandler


_AUDIT_LOGGER: logging.Logger | None = None


def audit_logger() -> logging.Logger | None:
    global _AUDIT_LOGGER
    if "PYTEST_CURRENT_TEST" in os.environ or os.environ.get("STUDIOLO_AUDIT", "1") == "0":
        return None
    if _AUDIT_LOGGER is None:
        path = os.path.expanduser("~/.hermes/logs/studiolo-audit-node.log")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        handler = RotatingFileHandler(path, maxBytes=10 * 1024 * 1024, backupCount=3, encoding="utf-8")
        formatter = logging.Formatter("%(asctime)s.%(msecs)03dZ [audit] %(message)s", "%Y-%m-%dT%H:%M:%S")
        formatter.converter = time.gmtime
        handler.setFormatter(formatter)
        logger = logging.getLogger("studiolo.audit.node")
        logger.addHandler(handler)
        logger.setLevel(logging.INFO)
        logger.propagate = False
        _AUDIT_LOGGER = logger
    return _AUDIT_LOGGER


def _field(value: str | None, limit: int | None = None) -> str:
    if not isinstance(value, str) or not value:
        return "-"
    return value[:limit].replace("\r", "_").replace("\n", "_")


def audit_event(
    side: str,
    *,
    session_id: str | None = "",
    run_id: str | None = "",
    stream_id: str | None = "",
    seq: int | str | None = "-",
    event_type: str | None = "",
    call_id: str | None = "",
) -> None:
    try:
        logger = audit_logger()
        if logger is not None:
            logger.info(
                "side=%s session=%s run=%s stream=%s seq=%s type=%s call=%s",
                side, _field(session_id, 8), _field(run_id, 8), _field(stream_id, 8),
                seq if type(seq) is int else _field(seq), _field(event_type), _field(call_id, 8),
            )
    except Exception:
        # 审计故障不应影响事件发送。
        pass
