"""Versioned session event log and its pure snapshot projection."""

from collections.abc import Iterable
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import dataclass, field
from hashlib import sha256
from itertools import groupby
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


@dataclass
class SessionEventUpdate:
    type: str
    turn_id: str | None
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
MAX_SESSION_SEQ = (1 << 63) - 1
DEFAULT_WINDOW_TURNS = 40
DEFAULT_WINDOW_MESSAGES = 120
MAX_WINDOW_LIMIT = 500


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
    if type(event["seq"]) is not int or not 0 < event["seq"] <= MAX_SESSION_SEQ:
        raise ValueError("seq must be a positive SQLite integer")
    if type(event["at"]) is not int or not 0 <= event["at"] <= MAX_SESSION_SEQ:
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
        self.append_updates(session_id=session_id, epoch=epoch, participant_id=participant_id,
                            updates=[SessionEventUpdate(kind, turn_id, at, payload) for kind, payload in events])

    def append_updates(
        self, *, session_id: str, epoch: str, participant_id: str, updates: list[SessionEventUpdate],
    ) -> None:
        if not updates:
            return
        with self._connection() as db:
            db.execute("BEGIN IMMEDIATE")
            head = db.execute(
                "SELECT seq FROM session_event_heads WHERE session_id = ? AND epoch = ?",
                (session_id, epoch),
            ).fetchone()
            seq = head[0] if head else 0
            for update in updates:
                seq += 1
                row = _event_row(SessionEvent(
                    sessionId=session_id, epoch=epoch, seq=seq, turnId=update.turn_id,
                    participantId=participant_id, type=update.type, at=update.at, payload=update.payload,
                ))
                db.execute(_INSERT_EVENT, row)
            db.execute(_UPDATE_HEAD, (session_id, epoch, seq))

    def events_since(
        self, session_id: str, epoch: str, last_seq: int, limit: int = 500,
    ) -> list[SessionEvent]:
        if type(limit) is not int or limit <= 0:
            raise ValueError("limit must be a positive integer")
        if not self.path.exists():
            return []
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

    def session_owner(self, session_id: str, preferred_epoch: str) -> tuple[str, str] | None:
        if not self.path.exists():
            return None
        with self._connection() as db:
            row = db.execute(
                """SELECT epoch, participant_id FROM session_events WHERE session_id = ? AND epoch = ?
                   ORDER BY seq DESC LIMIT 1""",
                (session_id, preferred_epoch),
            ).fetchone()
            if row is None:
                row = db.execute(
                    """SELECT epoch, participant_id FROM session_events WHERE session_id = ?
                       ORDER BY at DESC, seq DESC LIMIT 1""",
                    (session_id,),
                ).fetchone()
        return row

    def snapshot(self, session_id: str, epoch: str) -> "Snapshot":
        # A single SQLite read fixes the snapshot boundary even while frames are being appended.
        return fold(self.events_since(session_id, epoch, 0, limit=MAX_SESSION_SEQ))

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
    log_key: tuple[str, str] | None = None
    ordered = []
    for event in events:
        validate_event(event)
        key = (event["sessionId"], event["epoch"])
        if log_key is not None and key != log_key:
            raise ValueError("fold expects events from one session and epoch")
        log_key = key
        ordered.append(event)

    groups = groupby(sorted(ordered, key=lambda event: event["seq"]), key=lambda event: event["seq"])
    return fold_ordered(next(group) for _, group in groups)


def fold_ordered(events: Iterable[SessionEvent]) -> Snapshot:
    """Apply the validated sequence of unique events."""
    snapshot = Snapshot()
    turns: dict[str, dict[str, Any]] = {}
    assistants: dict[str, dict[str, Any]] = {}
    calls: dict[tuple[str, str], dict[str, Any]] = {}
    approvals: dict[tuple[str, str], dict[str, Any]] = {}
    completed_text: set[tuple[str, str]] = set()

    for event in events:
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
                turn["startedAt"] = payload["startedAt"] or None
            else:
                turn.update(endedAt=payload["endedAt"] or None, status=payload["status"],
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


@dataclass(frozen=True)
class MessageWindow:
    messages: list[dict[str, Any]]
    start_index: int
    end_index: int
    has_more_before: bool
    before_cursor: str | None
    kept_turn_ids: frozenset[str]


def history_cursor(message: dict[str, Any], previous: dict[str, Any]) -> str:
    anchor = [(row.get("role"), row.get("id") if row.get("systemEvents") else row.get("text"))
              for row in (previous, message)]
    return sha256(json.dumps(anchor, ensure_ascii=False).encode("utf-8")).hexdigest()


def _turn_id_of(message: dict[str, Any]) -> str | None:
    for key in ("turnId", "runId"):
        value = message.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return None


def _group_turn_blocks(messages: list[dict[str, Any]]) -> list[tuple[int, int, set[str]]]:
    """Partition chronological messages into atomic turn blocks so windowing never splits a turn."""
    n = len(messages)
    last_index: dict[str, int] = {}
    for idx, msg in enumerate(messages):
        tid = _turn_id_of(msg)
        if tid is not None:
            last_index[tid] = idx

    blocks: list[tuple[int, int, set[str]]] = []
    i = 0
    while i < n:
        tid = _turn_id_of(messages[i])
        if tid is not None:
            block_start = i
            block_end = last_index[tid]
            tids = {tid}
            j = i + 1
            while j <= block_end:
                other = _turn_id_of(messages[j])
                if other is not None:
                    tids.add(other)
                    if last_index[other] > block_end:
                        block_end = last_index[other]
                j += 1
            blocks.append((block_start, block_end + 1, tids))
            i = block_end + 1
            continue

        role = messages[i].get("role")
        if role == "system":
            blocks.append((i, i + 1, set()))
            i += 1
            continue

        block_start = i
        j = i + 1
        while j < n and _turn_id_of(messages[j]) is None and messages[j].get("role") not in ("user", "system"):
            j += 1
        blocks.append((block_start, j, set()))
        i = j

    return blocks


def _make_before_cursor(messages: list[dict[str, Any]], start_idx: int, *, anchor_hash: bool = False) -> str:
    current = messages[start_idx]
    msg_id = current.get("id")
    if (isinstance(msg_id, str) and msg_id.strip()) or type(msg_id) is int:
        id_str = str(msg_id)
        if sum(1 for row in messages if row.get("id") is not None and str(row.get("id")) == id_str) == 1:
            return f"id:{id_str}"
    turn_id = _turn_id_of(current)
    if turn_id is not None and all(_turn_id_of(row) != turn_id for row in messages[:start_idx]):
        return f"turn:{turn_id}"
    if anchor_hash and start_idx > 0:
        return history_cursor(current, messages[start_idx - 1])
    return f"idx:{start_idx}"


def resolve_before_cursor(messages: list[dict[str, Any]], before_cursor: str) -> int:
    """Resolve a window cursor to the exclusive end index of the older page, or -1 if not found."""
    if not isinstance(before_cursor, str) or not before_cursor:
        return -1
    if before_cursor.startswith("id:"):
        target = before_cursor[3:]
        return next(
            (i for i in range(len(messages) - 1, -1, -1)
             if messages[i].get("id") is not None and str(messages[i]["id"]) == target),
            -1,
        )
    if before_cursor.startswith("turn:"):
        target = before_cursor[5:]
        return next((i for i, row in enumerate(messages) if _turn_id_of(row) == target), -1)
    if before_cursor.startswith("idx:"):
        raw = before_cursor[4:]
        if raw.isdigit():
            idx = int(raw)
            if 0 <= idx <= len(messages):
                return idx
        return -1

    hash_match = next(
        (i for i in range(len(messages) - 1, 0, -1)
         if history_cursor(messages[i], messages[i - 1]) == before_cursor),
        -1,
    )
    if hash_match >= 0:
        return hash_match

    id_match = next(
        (i for i in range(len(messages) - 1, -1, -1)
         if messages[i].get("id") is not None and str(messages[i]["id"]) == before_cursor),
        -1,
    )
    if id_match >= 0:
        return id_match

    turn_match = next((i for i, row in enumerate(messages) if _turn_id_of(row) == before_cursor), -1)
    if turn_match >= 0:
        return turn_match

    if before_cursor.isdigit():
        idx = int(before_cursor)
        if 0 <= idx <= len(messages):
            return idx
    return -1


def window_messages(
    messages: list[dict[str, Any]],
    *,
    end_index: int | None = None,
    max_turns: int = DEFAULT_WINDOW_TURNS,
    max_messages: int = DEFAULT_WINDOW_MESSAGES,
    running_turn_id: str | None = None,
    include_last_turn_running: bool = False,
    anchor_hash: bool = False,
) -> MessageWindow:
    """Slice a transport window at turn boundaries without mutating underlying history."""
    total = len(messages)
    end = total if end_index is None else max(0, min(end_index, total))
    if end == 0:
        return MessageWindow([], 0, 0, False, None, frozenset())

    blocks = _group_turn_blocks(messages[:end])
    mandatory_from = len(blocks)
    if end == total:
        if running_turn_id:
            for idx, (_, _, tids) in enumerate(blocks):
                if running_turn_id in tids:
                    mandatory_from = idx
                    break
        if mandatory_from == len(blocks) and include_last_turn_running:
            mandatory_from = len(blocks) - 1

    start_block = len(blocks)
    turn_count = 0
    msg_count = 0
    for idx in range(len(blocks) - 1, -1, -1):
        b_start, b_end, _ = blocks[idx]
        b_len = b_end - b_start
        must_include = idx >= mandatory_from or start_block == len(blocks)
        if not must_include and (turn_count + 1 > max_turns or msg_count + b_len > max_messages):
            break
        start_block = idx
        turn_count += 1
        msg_count += b_len

    start_idx = blocks[start_block][0]
    selected = messages[start_idx:end]
    has_more_before = start_idx > 0
    before_cursor = _make_before_cursor(messages, start_idx, anchor_hash=anchor_hash) if has_more_before else None
    kept_turns = frozenset().union(*(tids for _, _, tids in blocks[start_block:]))
    return MessageWindow(selected, start_idx, end, has_more_before, before_cursor, kept_turns)


def window_snapshot(
    snapshot: Snapshot,
    *,
    before_cursor: str | None = None,
    max_turns: int = DEFAULT_WINDOW_TURNS,
    max_messages: int = DEFAULT_WINDOW_MESSAGES,
) -> tuple[Snapshot, bool, str | None] | None:
    """Apply transport windowing to a folded Snapshot, or return None if before_cursor is invalid."""
    if before_cursor is not None:
        end_index = resolve_before_cursor(snapshot.messages, before_cursor)
        if end_index < 0:
            return None
        win = window_messages(
            snapshot.messages,
            end_index=end_index,
            max_turns=max_turns,
            max_messages=max_messages,
        )
        running_keep = None
    else:
        running_keep = snapshot.runId if snapshot.running else None
        win = window_messages(
            snapshot.messages,
            max_turns=max_turns,
            max_messages=max_messages,
            running_turn_id=running_keep,
            include_last_turn_running=snapshot.running and running_keep is None,
        )
        if not win.has_more_before:
            return snapshot, False, None

    kept_turns = set(win.kept_turn_ids)
    if running_keep:
        kept_turns.add(running_keep)

    if win.messages:
        turns = [turn for turn in snapshot.turns if turn.get("turnId") in kept_turns]
    elif before_cursor is not None:
        turns = []
    else:
        turns = snapshot.turns[-max_turns:] if len(snapshot.turns) > max_turns else list(snapshot.turns)
        if running_keep and not any(t.get("turnId") == running_keep for t in turns):
            turns.extend(t for t in snapshot.turns if t.get("turnId") == running_keep)

    turn_ids_in_view = {turn.get("turnId") for turn in turns} | kept_turns
    notices = [
        notice for notice in snapshot.notices
        if (before_cursor is None and notice.get("turnId") is None)
        or notice.get("turnId") in turn_ids_in_view
    ]
    approvals = [
        approval for approval in snapshot.approvals
        if approval.get("turnId") in turn_ids_in_view
        or (before_cursor is None and "decision" not in approval)
    ]

    windowed = Snapshot(
        messages=win.messages,
        turns=turns,
        notices=notices,
        approvals=approvals,
        usage=dict(snapshot.usage),
        session=deepcopy(snapshot.session),
        running=snapshot.running,
        runId=snapshot.runId,
        lastSeq=snapshot.lastSeq,
        upToSeq=snapshot.upToSeq,
    )
    return windowed, win.has_more_before, win.before_cursor


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

    def record(
        self, frame: dict[str, Any], prompt: PromptEvents | None = None,
        *, updates: list[SessionEventUpdate] | None = None,
    ) -> None:
        kind, sid, provider = (frame.get(key) for key in ("type", "sessionId", "provider"))
        if not isinstance(sid, str) or not sid or not isinstance(provider, str) or not provider:
            return

        if updates is not None:
            self.store.append_updates(session_id=sid, epoch=self.epoch, participant_id=provider, updates=updates)
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
