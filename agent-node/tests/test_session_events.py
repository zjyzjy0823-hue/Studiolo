import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import sqlite3
from unittest.mock import AsyncMock, patch

import pytest

from agent_node.adapters.mock import MockAdapter
from agent_node.config import DirectTransferConfig, NodeConfig
from agent_node.daemon import AgentNodeDaemon, SessionStream
from agent_node.session_events import EventStore, fold


def event(seq, kind="message.assistant.delta", payload=None, *, epoch="node-1", session="s1"):
    return {
        "sessionId": session,
        "epoch": epoch,
        "seq": seq,
        "turnId": "turn-1",
        "participantId": "codex",
        "type": kind,
        "at": 1000 + seq,
        "payload": {"text": "chunk"} if payload is None else payload,
    }


@pytest.mark.parametrize("change", [
    {"seq": 0}, {"seq": -1}, {"seq": True}, {"seq": 1.5},
    {"type": "tool.unknown"}, {"payload": []}, {"participantId": ""},
    {"providerExtension": "unsupported"},
])
def test_invalid_envelope(tmp_path, change):
    with pytest.raises(ValueError):
        EventStore(tmp_path / "events.db").append({**event(1), **change})


@pytest.mark.parametrize("field", list(event(1)))
def test_missing_envelope_field(tmp_path, field):
    bad = event(1)
    del bad[field]
    with pytest.raises(ValueError):
        EventStore(tmp_path / "events.db").append(bad)


def test_idempotent_append_and_read_boundaries(tmp_path):
    path = tmp_path / "events.db"
    store = EventStore(path)
    first, second = event(1), event(2)
    assert store.append(first)
    assert not store.append(event(1, payload={"text": "different"}))
    assert store.append(second)
    assert store.append(event(1, epoch="node-2"))
    assert store.append(event(1, session="other"))
    store.close()

    reopened = EventStore(path)
    assert reopened.events_since("s1", "node-1", 0) == [first, second]
    assert reopened.events_since("s1", "node-1", 0, limit=1) == [first]
    assert reopened.events_since("s1", "node-1", 1) == [second]
    assert reopened.events_since("s1", "node-1", 2) == []
    assert reopened.events_since("s1", "node-2", 0) == [event(1, epoch="node-2")]
    assert reopened.max_seq("s1", "node-1") == 2
    assert reopened.max_seq("s1", "node-2") == 1
    assert reopened.max_seq("s1", "missing") == 0
    assert reopened.prune(1002) == 3
    assert reopened.events_since("s1", "node-1", 0) == [second]
    reopened.close()


def test_allocator_is_atomic_across_writers_and_retains_pruned_head(tmp_path):
    def write(store, kinds):
        store.append_frame(
            session_id="s", epoch="ep", turn_id="t", participant_id="codex", at=1000,
            events=[(kind, {"text": "delta"}) for kind in kinds],
        )

    path = tmp_path / "events.db"
    with EventStore(path) as first, EventStore(path) as second:
        first.max_seq("s", "ep")
        second.max_seq("s", "ep")
        with ThreadPoolExecutor() as pool:
            writes = [pool.submit(write, first if i % 2 else second, ["thought.delta"] * 2) for i in range(12)]
            for pending in writes:
                pending.result()
        assert [e["seq"] for e in first.events_since("s", "ep", 0)] == list(range(1, 25))
        with pytest.raises(ValueError):
            write(first, ["thought.delta", "unknown.event"])
        assert first.max_seq("s", "ep") == 24
        assert second.prune(1001) == 24
        assert first.max_seq("s", "ep") == 0
        write(first, ["thought.delta"])
        assert first.max_seq("s", "ep") == 25


@pytest.fixture
def conversation():
    events = [
        ("turn.started", {"startedAt": 1000}),
        ("message.user", {"text": "Check two files", "attachments": [{"fileName": "a.txt"}]}),
        ("session.running", {"running": True, "runId": "turn-1"}),
        ("thought.delta", {"text": "Checking"}),
        ("thought.completed", {"text": "Checked"}),
        ("tool.call.started", {"callId": "a", "name": "read", "input": {"path": "a.txt"}}),
        ("tool.call.updated", {"callId": "a", "status": "running", "progress": 0.5}),
        ("tool.call.completed", {"callId": "a", "ok": True, "output": "A", "durationMs": 23}),
        ("tool.call.updated", {"callId": "b", "name": "stat", "status": "running"}),
        ("tool.call.completed", {"callId": "b", "ok": False, "output": "missing", "durationMs": 17}),
        ("message.assistant.delta", {"text": "One"}),
        ("message.assistant.delta", {"text": " file"}),
        ("message.assistant.completed", {"text": "One file exists."}),
        ("message.assistant.delta", {"text": "stale"}),
        ("notice", {"level": "info", "text": "Background finished", "source": "node"}),
        ("turn.ended", {"status": "completed", "endedAt": 1350, "usage": {"in": 20, "out": 10, "tps": 30}}),
        ("session.running", {"running": False, "runId": "turn-1"}),
    ]
    return [event(seq, kind, payload) for seq, (kind, payload) in enumerate(events, 1)]


def test_fold_conversation(conversation):
    snapshot = fold(conversation)
    user, assistant = snapshot.messages
    assert user["text"] == "Check two files"
    assert user["attachments"] == [{"fileName": "a.txt"}]
    assert assistant["thought"] == "Checked"
    assert [
        (t["name"], t["status"], t["output"], t["durationMs"])
        for t in assistant["toolCalls"]
    ] == [("read", "completed", "A", 23), ("stat", "error", "missing", 17)]
    assert fold(conversation[:12]).messages[1]["text"] == "One file"
    assert assistant["text"] == "One file exists."
    assert len(snapshot.messages) == 2
    assert [notice["text"] for notice in snapshot.notices] == ["Background finished"]
    turn = snapshot.turns[0]
    assert (turn["startedAt"], turn["endedAt"], turn["durationMs"]) == (1000, 1350, 350)
    assert turn["usage"] == {"in": 20, "out": 10, "tps": 30}
    assert snapshot.usage == {"in": 20, "out": 10}
    assert snapshot.running is False
    assert snapshot.lastSeq == len(conversation)
    assert fold(conversation[::-1] + conversation[2:8]) == snapshot

    # The snapshot must not keep references to source payloads.
    user["attachments"][0]["fileName"] = "modified"
    assert conversation[1]["payload"]["attachments"][0]["fileName"] == "a.txt"


def test_fold_rejects_mixed_logs():
    with pytest.raises(ValueError):
        fold([event(1), event(2, epoch="other")])


@pytest.mark.parametrize(("provider", "names"), [
    ("hermes", ["terminal", "terminal"]),
    ("codex", ["exec_command"]),
    ("opencode", ["bash"]),
])
def test_recorded_provider_turn(provider, names):
    path = Path(__file__).parent / "fixtures" / "session_events" / f"{provider}.jsonl"
    events = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
    assert {e["participantId"] for e in events} == {provider}
    snapshot = fold(events)
    assert [m["role"] for m in snapshot.messages] == ["user", "assistant"]
    assert snapshot.messages[-1]["text"]
    assert [(t["name"], t["status"]) for t in snapshot.messages[-1]["toolCalls"]] == [
        (name, "completed") for name in names
    ]
    assert len(snapshot.turns) == 1
    assert snapshot.turns[0]["status"] == "completed"
    assert snapshot.turns[0]["durationMs"] > 0
    assert not snapshot.running


@pytest.fixture
def node(tmp_path):
    config = NodeConfig(
        core_url="http://127.0.0.1:48197",
        node_token="local-test",
        allowed_roots=(tmp_path,),
        direct=DirectTransferConfig(enabled=False),
    )
    return config, MockAdapter(config.allowed_roots), tmp_path / "stage"


def test_daemon_disabled_has_identical_wire_and_no_db(node, tmp_path, monkeypatch):
    monkeypatch.delenv("STUDIOLO_SESSION_EVENTS", raising=False)
    with patch("agent_node.session_events.Path.home", return_value=tmp_path):
        config, adapter, staging = node
        daemon = AgentNodeDaemon(config, adapters={"mock": adapter}, staging_dir=staging)
        ws = AsyncMock()
        frame = {"type": "TextDelta", "provider": "mock", "sessionId": "s", "runId": "r", "text": "hi"}
        asyncio.run(daemon._send_ws(ws, frame))
    ws.send.assert_awaited_once_with(json.dumps(frame, ensure_ascii=False))
    assert not (tmp_path / ".hermes").exists()


def test_daemon_commits_before_wire_and_replay_is_read_only(node, tmp_path, monkeypatch):
    monkeypatch.setenv("STUDIOLO_SESSION_EVENTS", "1")
    config, adapter, staging = node
    path = tmp_path / ".hermes" / "studiolo-node" / "session_events.db"
    forwarded = []
    with patch("agent_node.session_events.Path.home", return_value=tmp_path):
        daemon = AgentNodeDaemon(config, adapters={"mock": adapter}, staging_dir=staging)
        assert not path.exists()

        async def send(raw):
            frame = json.loads(raw)
            forwarded.append(frame)
            if frame["type"] in {"Accepted", "Completed"}:
                db = EventStore(path)
                with db:
                    events = db.events_since("s", daemon._session_event_log.epoch, 0)
                expected = "turn.started" if frame["type"] == "Accepted" else "turn.ended"
                assert expected in [event["type"] for event in events]

        async def run():
            ws = AsyncMock(send=send)
            await daemon.handle_command(ws, {
                "type": "prompt.send", "provider": "mock", "sessionId": "s",
                "requestId": "r", "text": "TOOL_DEMO",
            })
            await daemon.handle_command(ws, {"type": "session.subscribe", "provider": "mock", "sessionId": "s"})
            await asyncio.to_thread(daemon._session_event_log.store.close)

        asyncio.run(run())
    with EventStore(path) as db:
        events = db.events_since("s", daemon._session_event_log.epoch, 0)
    assert [event["seq"] for event in events] == list(range(1, len(events) + 1))
    snapshot = fold(events)
    assert len(snapshot.messages) == 2
    assert snapshot.messages[0]["text"] == "TOOL_DEMO"
    assert len(snapshot.messages[1]["toolCalls"]) >= 1
    assert snapshot.turns[0]["usage"]["out"] > 0
    assert forwarded[-1]["type"] == "SessionStreamReplay"
    assert forwarded[0]["type"] == "Accepted"
    assert forwarded[-2]["type"] == "Completed"
    assert snapshot.running is False


def test_daemon_does_not_buffer_or_send_uncommitted_frame(node, tmp_path, monkeypatch):
    monkeypatch.setenv("STUDIOLO_SESSION_EVENTS", "1")
    config, adapter, staging = node
    with patch("agent_node.session_events.Path.home", return_value=tmp_path):
        daemon = AgentNodeDaemon(config, adapters={"mock": adapter}, staging_dir=staging)
    ws, stream = AsyncMock(), SessionStream()
    events = daemon._session_event_log
    with patch.object(events.store, "append_frame", side_effect=sqlite3.OperationalError("disk full")):
        with pytest.raises(sqlite3.OperationalError, match="disk full"):
            asyncio.run(daemon._send_ws(ws, {
                "type": "TextDelta", "sessionId": "s", "runId": "r", "text": "hi",
            }, provider="mock", stream=stream))
    assert not stream.events
    assert stream.sequence == 0
    ws.send.assert_not_awaited()


def test_daemon_records_approval_resolution_without_new_wire_frame(node, tmp_path, monkeypatch):
    monkeypatch.setenv("STUDIOLO_SESSION_EVENTS", "1")
    config, adapter, staging = node
    with patch("agent_node.session_events.Path.home", return_value=tmp_path):
        daemon = AgentNodeDaemon(config, adapters={"mock": adapter}, staging_dir=staging)
    daemon._session_streams["mock", "s"] = SessionStream(run_id="r")
    wire = []

    async def send(raw):
        frame = json.loads(raw)
        wire.append(frame["type"])
        await daemon.handle_command(ws, {
            "type": "permission.respond", "callId": frame["callId"], "decision": "allow_once",
        })

    ws = AsyncMock(send=send)
    decision = asyncio.run(daemon._request_approval(
        ws, provider="mock", session_id="s", call_id="call", command="ls", risk="medium",
    ))
    events = daemon._session_event_log
    with events.store as db:
        snapshot = fold(db.events_since("s", events.epoch, 0))
    assert decision == "allow_once"
    assert wire == ["PermissionRequest"]
    assert snapshot.approvals == [{
        "turnId": "r", "participantId": "mock", "requestId": "call", "command": "ls",
        "risk": "medium", "decision": "allow_once",
    }]
