"""Versioned session event log and its pure snapshot projection."""

from collections.abc import Iterable
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import dataclass, field
import json
import os
from pathlib import Path
import sqlite3
from threading import Lock
import time
from typing import Any, TypedDict
from uuid import uuid4


class SessionEvent(TypedDict):
    sessionId: str
    epoch: str
    seq: int
    turnId: str | None
    participantId: str
    type: str
    at: int
    payload: dict[str, Any]


_EVENT_TYPES = frozenset({
    "session.created", "turn.started", "turn.ended", "message.user",
    "message.assistant.delta", "message.assistant.completed",
    "thought.delta", "thought.completed", "tool.call.started", "tool.call.updated",
    "tool.call.completed", "approval.requested", "approval.resolved",
    "session.running", "notice", "snapshot.ready",
})
_TURN_TYPES = _EVENT_TYPES - {"session.created", "session.running", "notice", "snapshot.ready"}
_NODE_EPOCH = str(uuid4())
_MAX_SQLITE_INT = (1 << 63) - 1


def validate_event(event: SessionEvent) -> None:
    if not isinstance(event, dict) or event.keys() != SessionEvent.__required_keys__:
        raise ValueError("invalid session event envelope fields")
    for key in ("sessionId", "epoch", "participantId", "type"):
        if not isinstance(event[key], str) or not event[key].strip():
            raise ValueError(f"{key} must be a nonempty string")
    if event["type"] not in _EVENT_TYPES:
        raise ValueError(f"unknown session event type: {event['type']}")
    turn_id = event["turnId"]
    if turn_id is None:
        if event["type"] in _TURN_TYPES:
            raise ValueError("turnId is required for turn-scoped events")
    elif not isinstance(turn_id, str) or not turn_id.strip():
        raise ValueError("turnId must be a nonempty string or null")
    if type(event["seq"]) is not int or not 0 < event["seq"] <= _MAX_SQLITE_INT:
        raise ValueError("seq must be a positive SQLite integer")
    if type(event["at"]) is not int or not 0 <= event["at"] <= _MAX_SQLITE_INT:
        raise ValueError("at must be a nonnegative Unix timestamp in milliseconds")
    if not isinstance(event["payload"], dict):
        raise ValueError("payload must be a JSON object")
    if "meta" in event["payload"] and not isinstance(event["payload"]["meta"], dict):
        raise ValueError("payload.meta must be a JSON object")


_SCHEMA = """
CREATE TABLE IF NOT EXISTS session_events (
    session_id TEXT, epoch TEXT, seq INTEGER, turn_id TEXT, participant_id TEXT,
    type TEXT, payload TEXT, at INTEGER, PRIMARY KEY(session_id, epoch, seq)
);
CREATE TABLE IF NOT EXISTS session_event_heads (
    session_id TEXT, epoch TEXT, seq INTEGER NOT NULL, PRIMARY KEY(session_id, epoch)
);
"""
_INSERT_EVENT = """
INSERT INTO session_events (session_id, epoch, seq, turn_id, participant_id, type, payload, at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, epoch, seq) DO NOTHING
"""
_UPDATE_HEAD = """
INSERT INTO session_event_heads (session_id, epoch, seq) VALUES (?, ?, ?)
ON CONFLICT(session_id, epoch) DO UPDATE SET seq = max(seq, excluded.seq)
"""


def _event_row(event: SessionEvent) -> tuple:
    validate_event(event)
    try:
        payload = json.dumps(event["payload"], ensure_ascii=False, allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise ValueError("payload must be JSON serializable") from exc
    return (event["sessionId"], event["epoch"], event["seq"], event["turnId"],
            event["participantId"], event["type"], payload, event["at"])


class EventStore:
    def __init__(self, path: str | Path | None = None) -> None:
        self.path = (Path(path).expanduser() if path is not None else
                     Path.home() / ".hermes" / "studiolo-node" / "session_events.db")
        self._lock = Lock()
        self._db: sqlite3.Connection | None = None

    @contextmanager
    def _connection(self):
        with self._lock:
            if self._db is None:
                self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                try:
                    fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                except FileExistsError:
                    pass
                else:
                    os.close(fd)
                db = sqlite3.connect(self.path, check_same_thread=False)
                try:
                    db.execute("PRAGMA journal_mode = WAL")
                    db.execute("PRAGMA synchronous = FULL")
                    db.executescript(_SCHEMA)
                except BaseException:
                    db.close()
                    raise
                self._db = db
            with self._db:
                yield self._db

    def __enter__(self) -> "EventStore":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def close(self) -> None:
        with self._lock:
            if self._db is not None:
                self._db.close()
                self._db = None

    def append(self, event: SessionEvent) -> bool:
        row = _event_row(event)
        with self._connection() as db:
            inserted = db.execute(_INSERT_EVENT, row).rowcount == 1
            if inserted:
                db.execute(_UPDATE_HEAD, row[:3])
        return inserted

    def append_frame(
        self, *, session_id: str, epoch: str, turn_id: str | None, participant_id: str,
        at: int, events: list[tuple[str, dict[str, Any]]],
    ) -> None:
        """Assign and commit a frame's events atomically, including across DB connections."""
        with self._connection() as db:
            db.execute("BEGIN IMMEDIATE")
            head = db.execute(
                "SELECT seq FROM session_event_heads WHERE session_id = ? AND epoch = ?",
                (session_id, epoch),
            ).fetchone()
            seq = head[0] if head else 0
            for kind, payload in events:
                seq += 1
                row = _event_row(SessionEvent(
                    sessionId=session_id, epoch=epoch, seq=seq, turnId=turn_id,
                    participantId=participant_id, type=kind, at=at, payload=payload,
                ))
                db.execute(_INSERT_EVENT, row)
            db.execute(_UPDATE_HEAD, (session_id, epoch, seq))

    def events_since(
        self, session_id: str, epoch: str, last_seq: int, limit: int = 500,
    ) -> list[SessionEvent]:
        if type(limit) is not int or limit <= 0:
            raise ValueError("limit must be a positive integer")
        with self._connection() as db:
            rows = db.execute(
                """SELECT session_id, epoch, seq, turn_id, participant_id, type, payload, at
                   FROM session_events WHERE session_id = ? AND epoch = ? AND seq > ?
                   ORDER BY seq LIMIT ?""",
                (session_id, epoch, last_seq, limit),
            ).fetchall()
        return [
            SessionEvent(sessionId=sid, epoch=ep, seq=seq, turnId=turn, participantId=participant,
                         type=kind, payload=json.loads(payload), at=at)
            for sid, ep, seq, turn, participant, kind, payload, at in rows
        ]

    def max_seq(self, session_id: str, epoch: str) -> int:
        with self._connection() as db:
            return db.execute(
                "SELECT COALESCE(MAX(seq), 0) FROM session_events WHERE session_id = ? AND epoch = ?",
                (session_id, epoch),
            ).fetchone()[0]

    def prune(self, before_ts: int) -> int:
        with self._connection() as db:
            return db.execute("DELETE FROM session_events WHERE at < ?", (before_ts,)).rowcount


@dataclass
class Snapshot:
    messages: list[dict[str, Any]] = field(default_factory=list)
    turns: list[dict[str, Any]] = field(default_factory=list)
    notices: list[dict[str, Any]] = field(default_factory=list)
    approvals: list[dict[str, Any]] = field(default_factory=list)
    usage: dict[str, int] = field(default_factory=dict)
    session: dict[str, Any] | None = None
    running: bool = False
    runId: str | None = None
    lastSeq: int = 0
    upToSeq: int = 0


def fold(events: Iterable[SessionEvent]) -> Snapshot:
    """Fold one session and epoch. Identical event keys are applied once."""
    snapshot = Snapshot()
    turns: dict[str, dict[str, Any]] = {}
    assistants: dict[str, dict[str, Any]] = {}
    calls: dict[tuple[str, str], dict[str, Any]] = {}
    approvals: dict[tuple[str, str], dict[str, Any]] = {}
    completed_text: set[tuple[str, str]] = set()
    log_key: tuple[str, str] | None = None
    ordered = []
    for event in events:
        validate_event(event)
        key = (event["sessionId"], event["epoch"])
        if log_key is not None and key != log_key:
            raise ValueError("fold expects events from one session and epoch")
        log_key = key
        ordered.append(event)

    for event in sorted(ordered, key=lambda event: event["seq"]):
        if event["seq"] == snapshot.lastSeq:
            continue
        snapshot.lastSeq = event["seq"]
        kind, turn_id = event["type"], event["turnId"]
        payload = deepcopy(event["payload"])
        attrs = {"turnId": turn_id, "participantId": event["participantId"]}

        if kind == "session.created":
            snapshot.session = {"sessionId": event["sessionId"], **payload}
        elif kind == "session.running":
            snapshot.running = payload["running"]
            snapshot.runId = payload.get("runId") if snapshot.running else None
        elif kind == "notice":
            snapshot.notices.append({**payload, **attrs, "at": event["at"]})
        elif kind == "snapshot.ready":
            snapshot.upToSeq = payload["upToSeq"]
        elif kind in ("turn.started", "turn.ended"):
            if turn_id not in turns:
                turns[turn_id] = {**attrs, "startedAt": None, "endedAt": None, "usage": {}}
                snapshot.turns.append(turns[turn_id])
            turn = turns[turn_id]
            if kind == "turn.started":
                turn["startedAt"] = payload["startedAt"]
            else:
                turn.update(endedAt=payload["endedAt"], status=payload["status"],
                            usage=payload.get("usage", {}))
            if turn["startedAt"] is not None and turn["endedAt"] is not None:
                turn["durationMs"] = turn["endedAt"] - turn["startedAt"]
        elif kind.startswith("approval."):
            key = (turn_id, payload["requestId"])
            if key not in approvals:
                approvals[key] = {**attrs}
                snapshot.approvals.append(approvals[key])
            approvals[key].update(payload)
        elif kind == "message.user":
            snapshot.messages.append({
                **attrs, "role": "user", "text": payload["text"], "thought": "", "toolCalls": [],
                "attachments": payload.get("attachments", []),
            })
        else:
            if turn_id not in assistants:
                assistants[turn_id] = {
                    **attrs, "role": "assistant", "text": "", "thought": "", "toolCalls": [], "attachments": [],
                }
                snapshot.messages.append(assistants[turn_id])
            message = assistants[turn_id]
            if kind.startswith("tool.call."):
                key = (turn_id, payload["callId"])
                if key not in calls:
                    calls[key] = {"callId": payload["callId"]}
                    message["toolCalls"].append(calls[key])
                call = calls[key]
                if kind == "tool.call.started":
                    call.setdefault("status", "running")
                elif kind == "tool.call.completed":
                    call["status"] = "completed" if payload["ok"] else "error"
                if kind == "tool.call.updated" and "ok" in call:
                    continue
                delta_output = payload.pop("deltaOutput", None)
                if delta_output is not None and "output" not in payload:
                    call["output"] = call.get("output", "") + delta_output
                call.update(payload)
            else:
                field_name = "thought" if kind.startswith("thought.") else "text"
                key = (turn_id, field_name)
                if kind.endswith(".completed"):
                    message[field_name] = payload["text"]
                    completed_text.add(key)
                    if field_name == "text" and "attachments" in payload:
                        message["attachments"] = payload["attachments"]
                elif key not in completed_text:
                    message[field_name] += payload["text"]

    for turn in snapshot.turns:
        for name in ("in", "out"):
            if name in turn["usage"]:
                snapshot.usage[name] = snapshot.usage.get(name, 0) + turn["usage"][name]
    return snapshot


@dataclass
class PromptEvents:
    turn_id: str
    text: str
    attachments: list[dict[str, Any]] | None
    usage: dict[str, Any] = field(default_factory=dict)


def _event_fields(frame: dict[str, Any], *names: str) -> dict[str, Any]:
    return {name: frame[name] for name in names if frame.get(name) is not None}


def _usage(frame: dict[str, Any]) -> dict[str, Any]:
    return {
        target: frame[source]
        for source, target in (("inputTokens", "in"), ("outputTokens", "out"), ("tps", "tps"))
        if type(frame.get(source)) in (int, float) and frame[source] >= 0
    }


def _attachments(attachments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        _event_fields(item, "artifactId", "fileName", "mime", "mimeType", "size", "sizeBytes")
        for item in attachments if isinstance(item, dict)
    ]


class SessionEventLog:
    """Normalize live compatibility frames at the daemon's single egress."""

    def __init__(self, store: EventStore) -> None:
        self.store = store
        self.epoch = _NODE_EPOCH

    def record(self, frame: dict[str, Any], prompt: PromptEvents | None = None) -> None:
        kind, sid, provider = (frame.get(key) for key in ("type", "sessionId", "provider"))
        if not isinstance(sid, str) or not sid or not isinstance(provider, str) or not provider:
            return

        at = time.time_ns() // 1_000_000
        run_id = frame.get("runId")
        turn_id = run_id or frame.get("turnId") or (prompt.turn_id if prompt is not None else frame.get("requestId"))
        events: list[tuple[str, dict[str, Any]]] = []
        if kind == "SessionOpened":
            turn_id = None
            events.append(("session.created", {"provider": provider, **_event_fields(frame, "title", "cwd")}))
        elif kind == "SessionRunning" and type(frame.get("running")) is bool:
            events.append(("session.running", _event_fields(frame, "running", "runId")))
        elif kind == "Notice" or (kind == "TextDelta" and frame.get("idle")):
            turn_id = None
            events.append(("notice", {
                "level": frame.get("level") or "info", "text": frame.get("text") or "",
                "source": frame.get("source") or provider,
            }))
        elif kind == "Failed" and not (run_id or frame.get("turnId") or prompt):
            turn_id = None
            events.append(("notice", {"level": "error", "text": frame.get("message") or "", "source": provider}))
        elif not turn_id:
            return
        elif kind == "Accepted":
            events.append(("turn.started", {"startedAt": frame.get("startedAt", at)}))
            if prompt is not None:
                user = {"text": prompt.text}
                if prompt.attachments:
                    user["attachments"] = _attachments(prompt.attachments)
                events.append(("message.user", user))
            events.append(("session.running", {"running": True, "runId": run_id or turn_id}))
        elif kind == "TokenUsage" and frame.get("scope") == "turn" and prompt is not None:
            prompt.usage.update(_usage(frame))
        elif kind in ("Completed", "Failed"):
            if isinstance(frame.get("text"), str):
                events.append(("message.assistant.completed", {"text": frame["text"]}))
            if kind == "Completed":
                status = "completed"
            elif frame.get("code") in ("cancelled", "canceled", "interrupted"):
                status = "cancelled"
            else:
                status = "failed"
            ended = {"status": status, "endedAt": frame.get("endedAt", at)}
            usage = {**(prompt.usage if prompt is not None else {}), **_usage(frame)}
            if usage:
                ended["usage"] = usage
            events.append(("turn.ended", ended))
            events.append(("session.running", {"running": False, "runId": run_id or turn_id}))
            if kind == "Failed":
                events.append(("notice", {"level": "error", "text": frame.get("message") or "", "source": provider}))
        elif kind in ("TextDelta", "TextCompleted", "ThoughtDelta", "ThoughtCompleted"):
            prefix = "thought" if kind.startswith("Thought") else "message.assistant"
            suffix = "delta" if kind.endswith("Delta") else "completed"
            if isinstance(frame.get("text"), str):
                events.append((f"{prefix}.{suffix}", {"text": frame["text"]}))
        elif kind in ("ToolCall", "ToolCallUpdate") and frame.get("callId"):
            tool = _event_fields(frame, "callId", "name", "input", "output", "deltaOutput", "durationMs")
            meta = _event_fields(frame, "title", "toolKind", "error", "decision", "subagentSessionId", "media")
            if meta:
                tool["meta"] = meta
            status = frame.get("status") or "running"
            if status in ("completed", "error", "failed", "cancelled", "canceled", "denied"):
                events.append(("tool.call.completed", {**tool, "ok": status == "completed"}))
            elif kind == "ToolCall":
                events.append(("tool.call.started", {"name": "tool", **tool}))
            else:
                events.append(("tool.call.updated", {**tool, "status": status, **_event_fields(frame, "progress")}))
        elif kind in ("PermissionRequest", "ApprovalRequest", "ApprovalResolved"):
            request_id = frame.get("callId") or frame.get("requestId")
            if request_id:
                if kind == "ApprovalResolved":
                    events.append(("approval.resolved", {"requestId": request_id, "decision": frame["decision"]}))
                else:
                    events.append(("approval.requested", {"requestId": request_id, **_event_fields(frame, "command", "risk")}))

        if events:
            self.store.append_frame(session_id=sid, epoch=self.epoch, turn_id=turn_id,
                                    participant_id=provider, at=at, events=events)
