"""Project Hermes' native replay frames into the shared session snapshot."""

from collections.abc import Iterator
import json
from math import isfinite
from typing import Any, cast

from ..session_events import SessionEvent, Snapshot, fold_ordered, validate_event


def fold_gateway_replay(session_id: str, epoch: str, events: list[dict[str, Any]]) -> Snapshot:
    def project() -> Iterator[SessionEvent]:
        turn_id = ""
        versioned_session = None
        for event in events:
            if "sessionId" in event:
                # Gateways that already speak the versioned event contract need no projection.
                versioned = cast(SessionEvent, event)
                validate_event(versioned)
                versioned_session = versioned_session or versioned["sessionId"]
                if versioned["epoch"] != epoch or versioned["sessionId"] != versioned_session:
                    raise ValueError("Hermes replay mixed event logs")
                yield versioned
                continue

            kind, payload, seq = event["type"], event["payload"], event["seq"]
            at = event.get("at")
            native_turn = event.get("admission_id") or payload.get("turn_id") or event.get("execution_generation")
            if event.get("admission_id") or (native_turn is not None and (kind == "message.start" or not turn_id)):
                turn_id = str(native_turn)
            elif kind == "message.start":
                turn_id = f"turn-{seq}"
            projected_turn = turn_id or f"turn-{seq}"
            for projected_kind, data in _updates(kind, payload, at, projected_turn):
                session_scope = projected_kind in ("session.created", "session.running", "notice")
                yield SessionEvent(
                    sessionId=session_id, epoch=epoch, seq=seq, participantId="hermes",
                    turnId=None if session_scope else projected_turn, at=at if at is not None else 0,
                    type=projected_kind, payload=data,
                )
                if not session_scope:
                    turn_id = projected_turn
            if kind == "message.complete":
                turn_id = ""

    snapshot = fold_ordered(project())
    # Control frames still advance the gateway cursor when they have no snapshot fields.
    snapshot.lastSeq = events[-1]["seq"] if events else 0
    return snapshot


def _updates(
    kind: str, payload: dict[str, Any], at: int | None, turn_id: str,
) -> Iterator[tuple[str, dict[str, Any]]]:
    text = payload.get("text")
    if kind == "session.info":
        meta = {key: payload[key] for key in ("cwd", "title") if isinstance(payload.get(key), str)}
        if meta:
            yield "session.created", {"provider": "hermes", **meta}
    elif kind == "message.start":
        yield "turn.started", {"startedAt": payload.get("started_at", at)}
        yield "session.running", {"running": True, "runId": turn_id}
        if isinstance(text, str):
            yield "message.user", {"text": text}
    elif kind == "message.user":
        if isinstance(text, str) or isinstance(payload.get("attachments"), list):
            yield "message.user", {**payload, "text": text if isinstance(text, str) else ""}
    elif kind in ("message.delta", "message.token", "message.interim"):
        if isinstance(text, str) and text and not payload.get("already_streamed"):
            yield "message.assistant.delta", {"text": text}
    elif kind in ("reasoning.delta", "thinking.delta", "reasoning.available"):
        if isinstance(text, str) and text:
            yield ("thought.completed" if kind == "reasoning.available" else "thought.delta"), {"text": text}
    elif kind == "message.complete":
        if isinstance(text, str) and text and not (payload.get("response_reused") or payload.get("response_previewed")):
            yield "message.assistant.completed", {"text": text}
        if isinstance(reasoning := payload.get("reasoning"), str) and reasoning:
            yield "thought.completed", {"text": reasoning}
        status = payload.get("status") or payload.get("outcome")
        if status in ("cancelled", "canceled", "interrupted"):
            status = "cancelled"
        elif status in ("error", "failed", "unknown") or payload.get("error"):
            status = "failed"
        else:
            status = "completed"
        raw_usage = payload.get("turn_usage") or {}
        usage = {target: raw_usage[source] for source, target in (("input", "in"), ("output", "out"))
                 if type(raw_usage.get(source)) is int and raw_usage[source] >= 0}
        yield "turn.ended", {"endedAt": payload.get("ended_at", at), "status": status, "usage": usage}
        yield "session.running", {"running": False}
    elif kind in ("tool.start", "tool.progress", "tool.complete") and (call_id := payload.get("tool_id")):
        yield _tool_update(kind, str(call_id), payload)
    elif kind in ("approval.request", "approval.settled") and (request_id := payload.get("prompt_id")):
        data = {"requestId": str(request_id)}
        if kind == "approval.request":
            yield "approval.requested", {**data, **{key: payload[key] for key in ("command", "risk") if key in payload}}
        elif isinstance(decision := payload.get("choice") or payload.get("decision"), str):
            yield "approval.resolved", {**data, "decision": {"once": "allow_once", "session": "allow_session"}.get(decision, decision)}
    elif kind == "notice" and isinstance(text, str):
        yield "notice", {"text": text, "level": payload.get("level") or "info", "source": payload.get("source") or "hermes"}


def _tool_update(kind: str, call_id: str, payload: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    tool: dict[str, Any] = {"callId": call_id}
    if name := payload.get("name"):
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
    output = payload.get("result_text") or result
    if output is None:
        output = payload.get("summary")
    if output is not None:
        tool["output"] = output if isinstance(output, str) else json.dumps(output, ensure_ascii=False)
    if type(duration := payload.get("duration_s")) in (int, float) and isfinite(duration) and duration >= 0:
        tool["durationMs"] = int(duration * 1000)
    return "tool.call.completed", tool
