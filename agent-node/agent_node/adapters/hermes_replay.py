"""Project Hermes' native replay and durable transcript into session snapshots."""

from collections import defaultdict
from collections.abc import Iterator
from dataclasses import dataclass, field
from hashlib import sha256
import json
from typing import Any, cast

from ..session_events import MAX_SESSION_SEQ, SessionEvent, SessionEventUpdate, Snapshot, fold, validate_event


def normalize_gateway_replay(
    session_id: str, gateway_epoch: str, frames: list[dict[str, Any]],
) -> tuple[str, list[SessionEvent]]:
    if frames and all("sessionId" in frame for frame in frames):
        events = []
        source_session = frames[0]["sessionId"]
        for frame in frames:
            event = cast(SessionEvent, frame)
            validate_event(event)
            if event["epoch"] != gateway_epoch or event["sessionId"] != source_session:
                raise ValueError("Hermes replay mixed event logs")
            events.append({**event, "sessionId": session_id})
        return gateway_epoch, events

    # Each native frame can yield several events. Number the shared projection
    # densely and invalidate old cursors when the retained prefix changes.
    epoch = f"hermes-v1:{gateway_epoch}"
    gaps = []
    previous = 0
    for frame in frames:
        seq = frame["seq"]
        if seq > previous + 1:
            gaps.append((previous + 1, seq - 1))
        previous = seq
    if gaps:
        epoch += ":" + sha256(repr(gaps).encode()).hexdigest()[:24]

    events = []
    normalizer = GatewayEventNormalizer()
    for frame in frames:
        if "sessionId" in frame or frame.get("replay_epoch", gateway_epoch) != gateway_epoch:
            raise ValueError("Hermes replay mixed event logs")
        for update in normalizer.normalize(frame, fallback_turn=f"turn-{frame['seq']}"):
            event = SessionEvent(
                sessionId=session_id, epoch=epoch, seq=len(events) + 1, participantId="hermes",
                turnId=update.turn_id, at=update.at, type=update.type, payload=update.payload,
            )
            validate_event(event)
            events.append(event)
    return epoch, events


@dataclass
class GatewayEventNormalizer:
    active_turn: str | None = None
    pending_prompts: dict[str, str] = field(default_factory=dict)

    def normalize(
        self, frame: dict[str, Any], *, fallback_turn: str, default_at: int = 0,
    ) -> list[SessionEventUpdate]:
        kind, payload = frame["type"], frame.get("payload")
        if payload is None:
            payload = {}
        if not isinstance(payload, dict):
            raise ValueError("Hermes replay payload must be an object")
        at = _timestamp(frame.get("at"), default_at)
        explicit_turn = _identifier(frame.get("admission_id"))
        starts_turn = kind in ("message.start", "turn.started")
        ends_turn = kind in ("message.complete", "turn.ended")
        if kind == "session.info" and isinstance(pending := payload.get("pending"), list):
            self.pending_prompts = {
                item["admission_id"]: item["text"] for item in pending if isinstance(item, dict)
                and isinstance(item.get("admission_id"), str) and isinstance(item.get("text"), str)
            }
        if kind == "message.start" and explicit_turn in self.pending_prompts and not isinstance(payload.get("text"), str):
            payload = {**payload, "text": self.pending_prompts[explicit_turn]}
        turn_id = (explicit_turn or (None if starts_turn else self.active_turn)
                   or _identifier(payload.get("turn_id")) or _identifier(frame.get("execution_generation"))
                   or fallback_turn)
        events = []
        for event_type, data in _updates(kind, payload, at, turn_id):
            session_scope = event_type in ("session.created", "session.running", "notice")
            events.append(SessionEventUpdate(event_type, None if session_scope else turn_id, at, data))
            if not session_scope:
                self.active_turn = turn_id
        if ends_turn:
            self.active_turn = None
        return events


def _identifier(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value
    if type(value) is int:
        return str(value)
    return None


def _timestamp(value: Any, default: int = 0) -> int:
    if type(value) is int and 0 <= value <= MAX_SESSION_SEQ:
        return value
    return default


_ATTACHMENT_FIELDS = {
    "artifactId": "artifact_id", "fileName": "file_name", "mime": "mime",
    "mimeType": "mime_type", "size": "size", "sizeBytes": "size_bytes",
}


def _message(payload: dict[str, Any]) -> dict[str, Any] | None:
    text, attachments = payload.get("text"), payload.get("attachments")
    data: dict[str, Any] = {"text": text if isinstance(text, str) else ""}
    if isinstance(attachments, list):
        clean = []
        for item in attachments:
            if not isinstance(item, dict):
                continue
            attachment = {}
            for field, alias in _ATTACHMENT_FIELDS.items():
                value = item.get(field, item.get(alias))
                if field in ("size", "sizeBytes"):
                    if type(value) is int and value >= 0:
                        attachment[field] = value
                elif isinstance(value, str):
                    attachment[field] = value
            if attachment:
                clean.append(attachment)
        if clean:
            data["attachments"] = clean
    return data if isinstance(text, str) or "attachments" in data else None


def _updates(
    kind: str, payload: dict[str, Any], at: int, turn_id: str,
) -> Iterator[tuple[str, dict[str, Any]]]:
    text = payload.get("text")
    if kind == "session.info":
        meta = {key: payload[key] for key in ("cwd", "title") if isinstance(payload.get(key), str)}
        if meta:
            yield "session.created", {"provider": "hermes", **meta}
    elif kind in ("message.start", "turn.started"):
        yield "turn.started", {"startedAt": _timestamp(payload.get("started_at"), at)}
        if kind == "message.start" and (message := _message(payload)) is not None:
            yield "message.user", message
        yield "session.running", {"running": True, "runId": turn_id}
    elif kind == "message.user":
        if (message := _message(payload)) is not None:
            yield "message.user", message
    elif kind in ("message.delta", "message.token", "message.interim"):
        if isinstance(text, str) and text and not payload.get("already_streamed"):
            yield "message.assistant.delta", {"text": text}
    elif kind in ("reasoning.delta", "thinking.delta", "reasoning.available"):
        if isinstance(text, str) and text:
            yield ("thought.completed" if kind == "reasoning.available" else "thought.delta"), {"text": text}
    elif kind in ("message.complete", "turn.ended"):
        if kind == "message.complete" and not (payload.get("response_reused") or payload.get("response_previewed")):
            message = _message(payload)
            if message and (message["text"] or message.get("attachments")):
                yield "message.assistant.completed", message
        if isinstance(reasoning := payload.get("reasoning"), str) and reasoning:
            yield "thought.completed", {"text": reasoning}
        status = payload.get("status") or payload.get("outcome")
        if status in ("cancelled", "canceled", "interrupted"):
            status = "cancelled"
        elif status in ("error", "failed", "unknown") or payload.get("error"):
            status = "failed"
        else:
            status = "completed"
        raw_usage = payload.get("turn_usage")
        ended = {"endedAt": _timestamp(payload.get("ended_at"), at), "status": status}
        if isinstance(raw_usage, dict):
            ended["usage"] = {
                target: raw_usage[source] for source, target in (("input", "in"), ("output", "out"))
                if type(raw_usage.get(source)) is int and raw_usage[source] >= 0
            }
        yield "turn.ended", ended
        yield "session.running", {"running": False}
    elif kind in ("tool.start", "tool.progress", "tool.complete"):
        if call_id := _identifier(payload.get("tool_id") or payload.get("tool_call_id")):
            yield _tool_update(kind, call_id, payload)
    elif kind in ("approval.request", "approval.settled"):
        if request_id := _identifier(payload.get("prompt_id")):
            if kind == "approval.request":
                details = {key: payload[key] for key in ("command", "risk") if isinstance(payload.get(key), str)}
                yield "approval.requested", {"requestId": request_id, **details}
            elif isinstance(decision := payload.get("choice") or payload.get("decision"), str):
                choice = {"once": "allow_once", "session": "allow_session"}.get(decision, decision)
                yield "approval.resolved", {"requestId": request_id, "decision": choice}
    elif kind == "notice":
        message = text if isinstance(text, str) else payload.get("message")
        if isinstance(message, str):
            yield "notice", {"text": message, "level": _identifier(payload.get("level")) or "info",
                             "source": _identifier(payload.get("source")) or "hermes"}


def _tool_update(kind: str, call_id: str, payload: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    tool: dict[str, Any] = {"callId": call_id}
    if isinstance(name := payload.get("name") or payload.get("tool_name"), str) and name:
        tool["name"] = name
    if "args" in payload:
        tool["input"] = payload["args"]
    if kind == "tool.start":
        tool.setdefault("name", "tool")
        return "tool.call.started", tool
    if kind == "tool.progress":
        tool["status"] = "running"
        if "progress" in payload:
            tool["progress"] = payload["progress"]
        if isinstance(message := payload.get("message"), str):
            tool["deltaOutput"] = message
        return "tool.call.updated", tool

    result = payload.get("result")
    tool["ok"] = not (payload.get("error") or payload.get("is_error") or
                      (isinstance(result, dict) and result.get("error")))
    output = payload.get("result_text")
    if output is None:
        output = result
    if output is None:
        output = payload.get("summary")
    if output is not None:
        tool["output"] = output if isinstance(output, str) else json.dumps(output, ensure_ascii=False)
    if (type(duration := payload.get("duration_s")) in (int, float)
            and 0 <= duration < MAX_SESSION_SEQ // 1000):
        tool["durationMs"] = int(duration * 1000)
    return "tool.call.completed", tool


_CONTENT_ROLES = {
    "message.user": "user", "message.assistant.completed": "assistant", "tool.call.completed": "tool",
}


def _content_key(kind: str, payload: dict[str, Any]) -> tuple[str, str]:
    role = _CONTENT_ROLES[kind]
    identity = payload["callId"] if role == "tool" else sha256(payload["text"].encode()).hexdigest()
    return role, identity


@dataclass
class _TranscriptTurn:
    turn_id: str | None = None
    rows: list[dict[str, Any]] = field(default_factory=list)
    completed: bool = False
    running: bool = False


def _transcript_role(row: dict[str, Any]) -> str | None:
    if row.get("row_kind") == "compaction" or row.get("display_kind") == "hidden":
        return None
    if _identifier(row.get("tool_call_id")) is not None:
        return "tool"
    return row.get("role")


def _assistant_completed(row: dict[str, Any]) -> bool:
    reason = row.get("finish_reason")
    return (row.get("running") is not True and row.get("status") not in ("running", "in_progress")
            and reason not in ("tool_calls", "function_call")
            and (bool(reason) or row.get("status") == "completed"
                 or not (row.get("tool_calls") or row.get("toolCalls"))))


def _transcript_turns(rows: list[dict[str, Any]]) -> Iterator[_TranscriptTurn]:
    turn = _TranscriptTurn()
    for row in rows:
        role = _transcript_role(row)
        if role not in ("user", "assistant", "tool"):
            continue
        turn_id = _identifier(row.get("turnId")) or _identifier(row.get("turn_id"))
        if turn.rows and ((turn.turn_id and turn_id and turn.turn_id != turn_id)
                          or (turn.completed and role != "tool" and (not turn_id or turn_id != turn.turn_id))):
            yield turn
            turn = _TranscriptTurn()
        turn.turn_id = turn.turn_id or turn_id
        turn.rows.append(row)
        if role == "assistant" and _assistant_completed(row):
            turn.completed = True
            turn.running = False
        elif role != "tool" and (row.get("running") is True or row.get("status") in ("running", "in_progress")):
            turn.running = True
    if turn.rows:
        yield turn


def _transcript_text(row: dict[str, Any]) -> dict[str, Any]:
    text = row.get("display_content", row.get("content"))
    if isinstance(text, list):
        text = "".join(part["text"] for part in text if isinstance(part, dict)
                       and part.get("type") in ("text", "input_text", "output_text")
                       and isinstance(part.get("text"), str))
    if not isinstance(text, str):
        text = row.get("text")
    return _message({**row, "text": text}) or {"text": ""}


def _transcript_updates(turn: _TranscriptTurn) -> Iterator[tuple[str, dict[str, Any]]]:
    declarations: dict[str, dict[str, Any]] = {}
    for row in turn.rows:
        role = _transcript_role(row)
        if role == "user":
            yield "message.user", _transcript_text(row)
        elif role == "assistant":
            tools = row.get("tool_calls") or row.get("toolCalls") or []
            for item in tools if isinstance(tools, list) else []:
                if isinstance(item, dict) and (call_id := _identifier(item.get("id") or item.get("callId"))):
                    declarations.setdefault(call_id, item)
            if _assistant_completed(row):
                yield "message.assistant.completed", _transcript_text(row)
                thought = row.get("reasoning") or row.get("thought") or row.get("reasoning_content")
                if isinstance(thought, str) and thought:
                    yield "thought.completed", {"text": thought}
        else:
            call_id = _identifier(row.get("tool_call_id") or row.get("callId"))
            if call_id is None:
                row_id = _identifier(row.get("row_id") or row.get("id"))
                call_id = f"transcript-tool-{row_id or _content_key('message.user', _transcript_text(row))[1]}"
            declaration = declarations.get(call_id, {})
            function = declaration.get("function")
            function = function if isinstance(function, dict) else {}
            raw = {**row, "name": row.get("name") or row.get("tool_name") or declaration.get("name")
                   or function.get("name") or "tool", "result": row.get("content", row.get("text"))}
            if "args" not in raw:
                raw["args"] = row.get("input", declaration.get("input", function.get("arguments")))
            raw.pop("duration_s", None)
            kind, tool = _tool_update("tool.complete", call_id, raw)
            if type(duration := row.get("durationMs")) is int and 0 <= duration <= MAX_SESSION_SEQ:
                tool["durationMs"] = duration
            yield kind, tool


def _matching_replay_turns(
    turns: list[_TranscriptTurn], updates: list[list[tuple[str, dict[str, Any]]]], events: list[SessionEvent],
    running_turn: str | None,
) -> dict[int, str]:
    # A replay window can start mid-turn. Use whichever durable identifiers or
    # complete messages it still contains, keeping anonymous matches in order.
    order: dict[str, int] = {}
    explicit_ids = {turn.turn_id for turn in turns if turn.turn_id is not None}
    identities: dict[tuple[str, str], list[str]] = defaultdict(list)
    user_ids: set[str] = set()
    assistant_ids: set[str] = set()
    for event in events:
        turn_id, kind, payload = event["turnId"], event["type"], event["payload"]
        if turn_id is None:
            continue
        order.setdefault(turn_id, len(order))
        if turn_id in explicit_ids:
            continue
        if kind.startswith("tool.call."):
            identities["tool", payload["callId"]].append(turn_id)
        elif kind in _CONTENT_ROLES and payload["text"]:
            (user_ids if kind == "message.user" else assistant_ids).add(turn_id)
            identities[_content_key(kind, payload)].append(turn_id)

    matched = {}
    upper = len(order)
    for index in reversed(range(len(turns))):
        turn = turns[index]
        if turn.turn_id in order:
            matched[index] = turn.turn_id
            upper = min(upper, order[turn.turn_id])
        elif turn.turn_id is None and turn.completed and not turn.running:
            evidence: dict[str, set[str]] = defaultdict(set)
            has_user_text = False
            for kind, payload in updates[index]:
                if kind in _CONTENT_ROLES:
                    role, identity = _content_key(kind, payload)
                    has_user_text |= role == "user" and bool(payload["text"])
                    for turn_id in identities[role, identity]:
                        if order[turn_id] < upper:
                            evidence[turn_id].add(role)
            candidates = [("tool" in roles, len(roles), order[turn_id], turn_id)
                          for turn_id, roles in evidence.items()
                          if "tool" in roles or (turn_id != running_turn and
                              ("assistant" in roles or turn_id not in assistant_ids) and
                              ("user" in roles or not has_user_text or turn_id not in user_ids))]
            if candidates:
                _, _, upper, matched[index] = max(candidates)
    return matched


def _open_replay_turn(events: list[SessionEvent]) -> str | None:
    # A retained suffix may have missed the start and its session.running event.
    for event in reversed(events):
        kind = event["type"]
        if kind in ("turn.ended", "message.assistant.completed"):
            break
        if kind == "session.running" and not event["payload"]["running"]:
            break
        if kind in ("turn.started", "message.assistant.delta", "tool.call.started", "tool.call.updated", "thought.delta"):
            return event["turnId"]
    return None


def merge_transcript_snapshot(session_id: str, rows: list[dict[str, Any]], events: list[SessionEvent]) -> Snapshot:
    """Merge a durable transcript with a retained gateway replay window."""
    replay = fold(events)
    running_turn = replay.runId or _open_replay_turn(events)
    turns = list(_transcript_turns(rows))
    updates = [list(_transcript_updates(turn)) for turn in turns]
    matched = _matching_replay_turns(turns, updates, events, running_turn)
    reserved = {event["turnId"] for event in events} | {turn.turn_id for turn in turns}
    covered: set[str] = set()
    seen: set[tuple[str, str, str]] = set()
    history_events: list[SessionEvent] = []
    ordinal = 0
    for index, turn in enumerate(turns):
        if not turn.completed:
            continue
        ordinal += 1
        if turn.running or (running_turn is not None and matched.get(index) == running_turn):
            continue
        turn_key = turn.turn_id or f"t{ordinal}"
        if turn.turn_id is None:
            while turn_key in reserved and turn_key != matched.get(index):
                turn_key += ":transcript"
        if index in matched:
            covered.add(matched[index])
        turn_updates = [("turn.started", {"startedAt": 0}), *updates[index],
                        ("turn.ended", {"endedAt": 0, "status": "completed"})]
        for kind, payload in turn_updates:
            if kind in _CONTENT_ROLES:
                key = (turn_key, *_content_key(kind, payload))
                if key in seen:
                    continue
                seen.add(key)
            history_events.append(SessionEvent(sessionId=session_id, epoch="transcript", seq=len(history_events) + 1,
                                               turnId=turn_key, participantId="hermes", at=0, type=kind, payload=payload))

    history = fold(history_events)
    for message in history.messages:
        for tool in message["toolCalls"]:
            tool.setdefault("durationMs", None)

    tail_events = []
    tail_turns: dict[str, dict[str, Any]] = {}
    for event in events:
        turn_key, kind = event["turnId"], event["type"]
        if turn_key in covered:
            continue
        if turn_key is not None:
            tail_turns.setdefault(turn_key, {"turnId": turn_key, "participantId": event["participantId"],
                                             "startedAt": None, "endedAt": None, "usage": {}})
            if kind == "message.user":
                key = (turn_key, *_content_key(kind, event["payload"]))
                if key in seen:
                    continue
                seen.add(key)
        tail_events.append(event)
    tail = fold(tail_events)
    tail_turns.update((turn["turnId"], turn) for turn in tail.turns)
    tail.turns = history.turns + list(tail_turns.values())
    tail.messages = history.messages + tail.messages
    if running_turn is not None:
        tail.running, tail.runId = True, running_turn
    tail.lastSeq = replay.lastSeq
    return tail
