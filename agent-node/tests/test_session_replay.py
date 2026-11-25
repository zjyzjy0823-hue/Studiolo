import asyncio
from dataclasses import asdict
import json
from pathlib import Path
from unittest.mock import AsyncMock

import httpx
import pytest

from agent_node.adapters.hermes_replay import merge_transcript_snapshot, normalize_gateway_replay
from agent_node.config import DirectTransferConfig, NodeConfig
from agent_node.daemon import AgentNodeDaemon
from agent_node.session_events import SessionEvent, fold, validate_event
from test_hermes_ws import wire_adapter  # noqa: F401  (pytest fixture)


def fixture_events(provider):
    path = Path(__file__).parent / "fixtures" / "session_events" / f"{provider}.jsonl"
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


@pytest.fixture(autouse=True)
def gateway_messages(monkeypatch):
    client = httpx.AsyncClient

    def mock(handler):
        def make(**options):
            return client(transport=httpx.MockTransport(handler), **options)

        monkeypatch.setattr("agent_node.adapters.hermes_ws.httpx.AsyncClient", make)

    mock(lambda _: httpx.Response(200, json={"messages": []}))
    return mock


@pytest.fixture
def make_node(tmp_path, monkeypatch):
    monkeypatch.setenv("STUDIOLO_SESSION_EVENTS", "1")
    monkeypatch.setattr("agent_node.session_events.Path.home", lambda: tmp_path)

    def make(**adapters):
        config = NodeConfig("http://127.0.0.1:48197", "local-test", (tmp_path,),
                            direct=DirectTransferConfig(enabled=False))
        return AgentNodeDaemon(config, adapters=adapters, staging_dir=tmp_path)

    return make


async def rpc(node, method, **params):
    ws = AsyncMock()
    await node.handle_command(ws, {"type": method, "_rpcId": "test-rpc", **params})
    ws.send.assert_awaited_once()
    frame = json.loads(ws.send.await_args.args[0])
    assert frame.keys() == {"type", "_rpcId", "result"}
    assert frame["type"] == "SessionReplayResult"
    assert frame["_rpcId"] == "test-rpc"
    return frame["result"]


def print_replay(provider, page, snapshot):
    messages = snapshot["snapshot"]["messages"]
    tools = sum(len(message["toolCalls"]) for message in messages)
    print(f"{provider} source={page['source']} events={len(page['events'])} "
          f"messages={len(messages)} tools={tools} lastSeq={snapshot['lastSeq']}")


@pytest.mark.parametrize("provider", ["codex", "opencode"])
def test_node_snapshot_and_event_pages(make_node, provider):
    async def run():
        node = make_node()
        log = node._session_event_log
        original = fixture_events(provider)
        events = [{**event, "epoch": log.epoch} for event in original]
        session = events[0]["sessionId"]
        with log.store as store:
            for event in original + events:
                store.append(event)
            snapshot = await rpc(node, "session.snapshot", sessionId=session)
            assert snapshot == {"sessionId": session, "epoch": log.epoch, "source": "node",
                                "lastSeq": events[-1]["seq"], "snapshot": asdict(fold(events)),
                                "incomplete": False, "hasMoreBefore": False, "beforeCursor": None}
            args = {"sessionId": session, "epoch": log.epoch}
            page = await rpc(node, "session.events.since", **args, lastSeq=0)
            assert page == {**args, "source": "node", "events": events, "hasMore": False}
            first = await rpc(node, "session.events.since", **args, lastSeq=0, limit=2)
            assert first == {**page, "events": events[:2], "hasMore": True}
            rest = await rpc(node, "session.events.since", **args, lastSeq=2)
            assert rest == {**page, "events": events[2:]}
            tail = await rpc(node, "session.events.since", **args, lastSeq=snapshot["lastSeq"])
            assert tail == {**page, "events": []}
            previous = await rpc(node, "session.events.since", sessionId=session,
                                 epoch=original[0]["epoch"], lastSeq=0)
            assert previous["events"] == original
            unknown = await rpc(node, "session.events.since", sessionId=session, epoch="unknown", lastSeq=10)
            assert unknown == {**tail, "snapshotRequired": True}
            print_replay(provider, page, snapshot)

    asyncio.run(run())


def test_gateway_ready_epoch_and_versioned_fixture(make_node, tmp_path, wire_adapter):
    events = [{**event, "epoch": "gateway-epoch"} for event in fixture_events("hermes")]
    session = events[0]["sessionId"]

    def dispatch(_, request):
        method, params = request["method"], request["params"]
        if method == "session.resume":
            return {"result": {"session_id": session, "info": {"cwd": str(tmp_path)}}}
        if method == "session.snapshot":
            return {"error": {"code": -32601, "message": "method not found"}}
        if method == "session.events.since":
            assert params["session_id"] == session
            assert params["replay_epoch"] == "gateway-epoch"
            return {"result": {"events": events[params["last_seen"]:], "latest_seq": events[-1]["seq"]}}
        assert method == "client.capabilities"
        return {"result": {}}

    async def run():
        adapter, _ = wire_adapter(dispatch, canonical=False)
        node = make_node(hermes=adapter)
        try:
            with node._session_event_log.store as store:
                # This local copy stops early. The gateway remains authoritative.
                store.append({**events[0], "epoch": node._session_event_log.epoch})
                snapshot = await rpc(node, "session.snapshot", sessionId=session, provider="hermes")
                assert snapshot == {"sessionId": session, "epoch": "gateway-epoch", "source": "gateway",
                                    "lastSeq": events[-1]["seq"], "snapshot": asdict(fold(events)),
                                    "incomplete": False, "hasMoreBefore": False, "beforeCursor": None}
                args = {"sessionId": session, "epoch": snapshot["epoch"]}
                page = await rpc(node, "session.events.since", **args, lastSeq=0)
                assert page == {**args, "events": events, "hasMore": False, "source": "gateway"}
                assert await rpc(node, "session.events.since", **args, lastSeq=snapshot["lastSeq"]) == {
                    **page, "events": [],
                }
                print_replay("hermes-v1", page, snapshot)
        finally:
            await adapter.close()

    asyncio.run(run())


@pytest.fixture
def native_replay():
    path = Path(__file__).parent / "fixtures" / "session_events" / "hermes-native.json"
    return json.loads(path.read_text(encoding="utf-8"))


@pytest.fixture
def transcript_rows():
    # Role order, finish reasons and tool references come from a real Hermes stored turn.
    path = Path(__file__).parent / "fixtures" / "session_events" / "hermes-transcript.json"
    return json.loads(path.read_text(encoding="utf-8"))


def test_transcript_fold_and_content_keys(transcript_rows):
    user, intermediate, first_tool, second_tool, assistant = transcript_rows
    second_tool = {**second_tool, "role": "assistant", "durationMs": 0}
    rows = [user, {**user, "id": 99}, intermediate, first_tool,
            {**first_tool, "content": "duplicate"}, second_tool, assistant]
    snapshot = merge_transcript_snapshot("session", rows, [])
    assert [(message["turnId"], message["role"], message["text"]) for message in snapshot.messages] == [
        ("t1", "user", "Verify two tools"), ("t1", "assistant", "Tools done."),
    ]
    tools = snapshot.messages[1]["toolCalls"]
    assert [(tool["callId"], tool["status"], tool["durationMs"]) for tool in tools] == [
        ("fixture-tool-1", "completed", None), ("fixture-tool-2", "completed", 0),
    ]
    assert tools[0]["output"] == first_tool["content"]
    assert json.loads(tools[0]["input"]) == {"command": "printf fixture"}
    assert len(snapshot.turns) == 1 and snapshot.turns[0]["status"] == "completed"
    assert snapshot.lastSeq == 0
    print(f"hermes-transcript turns={len(snapshot.turns)} users=1 tools={len(tools)} "
          f"durationMs={json.dumps([tool['durationMs'] for tool in tools])}")


def test_gateway_snapshot_merges_transcript_and_running_tail(
    make_node, tmp_path, wire_adapter, native_replay, transcript_rows, gateway_messages,
):
    public_id, stored_id = "hermes-public", "persisted/session"
    frames = native_replay["events"]
    runtime_id = frames[0]["session_id"]
    gateway_epoch = native_replay["replay_epoch"]
    for kind, payload in (("message.start", {"text": "Verify two tools"}), ("message.delta", {"text": "Still working"})):
        frames.append({"session_id": runtime_id, "replay_epoch": gateway_epoch, "seq": len(frames) + 1,
                       "admission_id": "live-turn", "type": kind, "payload": payload})
    rows = [
        {"role": "user", "content": "Earlier prompt", "timestamp": 1900000000},
        {"role": "assistant", "content": "Earlier answer", "timestamp": 1900000001},
        *transcript_rows,
        {"role": "user", "content": "Verify two tools"},
        {"role": "assistant", "finish_reason": "tool_calls", "tool_calls": [{"id": "open"}]},
    ]
    reads = []

    def messages(request):
        assert request.url.raw_path.startswith(b"/api/sessions/persisted%2Fsession/messages?")
        assert request.headers["X-Hermes-Session-Token"] == "fixture-dashboard"
        assert request.url.params["order"] == "oldest"
        assert request.url.params["include_compacted"] == "true"
        assert request.url.params["inline_images"] == "false"
        offset = int(request.url.params["offset"])
        reads.append(offset)
        return httpx.Response(200, json={"messages": rows[offset:offset + 2],
                                        "pagination": {"offset": offset, "limit": 2}})

    def dispatch(_, request):
        method, params = request["method"], request["params"]
        if method == "session.resume":
            return {"result": {"session_id": runtime_id, "stored_session_id": stored_id,
                               "replay_epoch": gateway_epoch, "info": {"cwd": str(tmp_path)}}}
        if method == "session.events.since":
            reads.append("events")
            assert params["session_id"] == runtime_id
            cursor = params["last_seen"]
            return {"result": {"events": frames[max(8, cursor):], "last_sequence": frames[-1]["seq"],
                               "truncated": cursor < 8}}
        assert method == "client.capabilities"
        return {"result": {}}

    async def run():
        adapter, _ = wire_adapter(dispatch, canonical=True)
        adapter._dashboard_token = "fixture-dashboard"
        node = make_node(hermes=adapter)
        try:
            response = await rpc(node, "session.snapshot", sessionId=public_id, provider="hermes")
            projected = response["snapshot"]
            assert reads == [0, 2, 4, 6, 8, "events"]
            assert response["incomplete"] is True
            assert [turn["turnId"] for turn in projected["turns"]] == ["t1", "t2", "live-turn"]
            assert [(message["turnId"], message["role"], message["text"]) for message in projected["messages"]] == [
                ("t1", "user", "Earlier prompt"), ("t1", "assistant", "Earlier answer"),
                ("t2", "user", "Verify two tools"), ("t2", "assistant", "Tools done."),
                ("live-turn", "user", "Verify two tools"), ("live-turn", "assistant", "Still working"),
            ]
            tools = projected["messages"][3]["toolCalls"]
            assert [tool["output"] for tool in tools] == [row["content"] for row in transcript_rows if row["role"] == "tool"]
            assert projected["running"] is True and projected["runId"] == "live-turn"
            delta = await rpc(node, "session.events.since", sessionId=public_id, epoch=response["epoch"], lastSeq=0)
            assert reads == [0, 2, 4, 6, 8, "events", "events"]
            assert "snapshot" not in delta and any(event["turnId"] == "fixture-turn" for event in delta["events"])
            assert response["lastSeq"] == projected["lastSeq"] == delta["events"][-1]["seq"]
            print(f"hermes-merged turns={len(projected['turns'])} messages={len(projected['messages'])} "
                  f"tools={len(tools)} running={projected['running']} lastSeq={response['lastSeq']}")
        finally:
            await adapter.close()

    gateway_messages(messages)
    asyncio.run(run())


def test_running_turn_overrides_transcript_with_explicit_id(transcript_rows):
    rows = [{**row, "turnId": "explicit"} for row in transcript_rows]
    frames = [
        {"type": "message.start", "seq": 1, "admission_id": "explicit", "payload": {"text": "Live prompt"}},
        {"type": "message.delta", "seq": 2, "admission_id": "explicit", "payload": {"text": "Live text"}},
    ]
    _, events = normalize_gateway_replay("session", "gateway", frames)
    snapshot = merge_transcript_snapshot("session", rows, events)
    assert snapshot == fold(events)
    assert snapshot.running


def test_unmatched_event_turns_preserve_same_text_and_live_suffix():
    rows = [{"role": "user", "content": "Older prompt"}, {"role": "assistant", "content": "Same answer"}]
    # The newer turn completed after the transcript was read. The retained window
    # also has a delta whose start and running event are missing.
    frames = [
        {"type": "message.start", "seq": 1, "admission_id": "new", "payload": {"text": "Newer prompt"}},
        {"type": "message.complete", "seq": 2, "admission_id": "new", "payload": {"text": "Same answer"}},
        {"type": "message.delta", "seq": 4, "admission_id": "live", "payload": {"text": "Live reply"}},
    ]
    _, events = normalize_gateway_replay("session", "gateway", frames)
    snapshot = merge_transcript_snapshot("session", rows, events)
    assert [turn["turnId"] for turn in snapshot.turns] == ["t1", "new", "live"]
    assert [message["text"] for message in snapshot.messages] == [
        "Older prompt", "Same answer", "Newer prompt", "Same answer", "Live reply",
    ]
    assert snapshot.running and snapshot.runId == "live"


def test_gateway_without_messages_returns_event_snapshot(
    make_node, tmp_path, wire_adapter, native_replay, gateway_messages,
):
    frames = native_replay["events"]
    session = frames[0]["session_id"]
    gateway_epoch = native_replay["replay_epoch"]

    def dispatch(_, request):
        if request["method"] == "session.resume":
            return {"result": {"session_id": session, "replay_epoch": gateway_epoch, "info": {"cwd": str(tmp_path)}}}
        if request["method"] == "session.events.since":
            return {"result": native_replay}
        assert request["method"] == "client.capabilities"
        return {"result": {}}

    async def run():
        adapter, _ = wire_adapter(dispatch, canonical=True)
        node = make_node(hermes=adapter)
        try:
            response = await rpc(node, "session.snapshot", sessionId=session)
            _, events = normalize_gateway_replay(session, gateway_epoch, frames)
            assert response["incomplete"] is True
            assert response["snapshot"] == asdict(fold(events))
            assert [message["text"] for message in response["snapshot"]["messages"]] == [
                "Verify two tools", "Tools done.",
            ]
            print(f"hermes-messages-404 incomplete={response['incomplete']} "
                  f"messages={len(response['snapshot']['messages'])} lastSeq={response['lastSeq']}")
        finally:
            await adapter.close()

    gateway_messages(lambda _: httpx.Response(404))
    asyncio.run(run())


def test_gateway_native_epoch_pagination_and_projection(make_node, tmp_path, wire_adapter, native_replay):
    frames = native_replay["events"]
    gateway_epoch = native_replay["replay_epoch"]
    runtime_id = frames[0]["session_id"]
    session = "public-hermes-session"

    def dispatch(_, request):
        method, params = request["method"], request["params"]
        if method == "session.resume":
            assert params["session_id"] == session
            return {"result": {"session_id": runtime_id, "replay_epoch": gateway_epoch,
                               "info": {"cwd": str(tmp_path)}}}
        if method == "session.events.since":
            assert params["session_id"] == runtime_id
            assert params["replay_epoch"] == gateway_epoch
            cursor = params["last_seen"]
            page = frames[cursor:cursor + 5]
            return {"result": {**native_replay, "events": page, "count": len(page),
                               "last_sequence": frames[-1]["seq"], "latest_seq": frames[-1]["seq"],
                               "has_more": cursor + len(page) < len(frames)}}
        assert method == "client.capabilities"
        return {"result": {}}

    async def run():
        adapter, _ = wire_adapter(dispatch, canonical=True)
        node = make_node(hermes=adapter)
        try:
            snapshot = await rpc(node, "session.snapshot", sessionId=session)
            epoch = snapshot["epoch"]
            assert epoch == f"hermes-v1:{gateway_epoch}"
            assert snapshot.keys() == {"sessionId", "epoch", "source", "lastSeq", "snapshot",
                                       "incomplete", "hasMoreBefore", "beforeCursor"}
            assert snapshot["source"] == "gateway" and snapshot["sessionId"] == session
            assert snapshot["incomplete"] is False
            projected = snapshot["snapshot"]
            assert projected["running"] is False and projected["runId"] is None
            assert len(projected["turns"]) == sum(frame["type"] == "message.start" for frame in frames) == 1
            assert projected["turns"][0] == {
                "turnId": "fixture-turn", "participantId": "hermes", "startedAt": None,
                "endedAt": None, "status": "completed", "usage": {},
            }
            user, assistant = projected["messages"]
            assert (user["role"], user["text"]) == ("user", "Verify two tools")
            assert (assistant["role"], assistant["text"], assistant["thought"]) == (
                "assistant", "Tools done.", "Check the tool results.",
            )
            assert [tool["callId"] for tool in assistant["toolCalls"]] == ["fixture-tool-1", "fixture-tool-2"]
            assert all(tool["status"] == "completed" for tool in assistant["toolCalls"])

            args = {"sessionId": session, "epoch": epoch}
            events = []
            cursor = 0
            while True:
                page = await rpc(node, "session.events.since", **args, lastSeq=cursor, limit=2)
                assert page.keys() == {"sessionId", "epoch", "source", "events", "hasMore"}
                assert (page["source"], page["sessionId"], page["epoch"]) == ("gateway", session, epoch)
                assert 0 < len(page["events"]) <= 2
                for event in page["events"]:
                    validate_event(event)
                    cursor += 1
                    assert event.keys() == SessionEvent.__required_keys__
                    assert (event["sessionId"], event["epoch"], event["seq"]) == (session, epoch, cursor)
                    assert (event["participantId"], event["at"]) == ("hermes", 0)
                    assert event["turnId"] == (None if event["type"].startswith("session.") else "fixture-turn")
                events.extend(page["events"])
                if not page["hasMore"]:
                    break
            assert [(event["type"], event["payload"]) for event in events] == [
                ("turn.started", {"startedAt": 0}),
                ("message.user", {"text": "Verify two tools"}),
                ("session.running", {"running": True, "runId": "fixture-turn"}),
                ("thought.delta", {"text": "Check the tool results."}),
                ("tool.call.started", {"callId": "fixture-tool-1", "name": "terminal",
                                       "input": {"command": "printf fixture-1"}}),
                ("tool.call.updated", {"callId": "fixture-tool-1", "name": "terminal", "status": "running",
                                       "progress": 0.5, "deltaOutput": "Running"}),
                ("tool.call.completed", {"callId": "fixture-tool-1", "name": "terminal", "ok": True,
                                         "input": {"command": "printf fixture-1"},
                                         "output": '{"output": "fixture-1", "exit_code": 0}'}),
                ("tool.call.started", {"callId": "fixture-tool-2", "name": "terminal",
                                       "input": {"command": "printf fixture-2"}}),
                ("tool.call.completed", {"callId": "fixture-tool-2", "name": "terminal", "ok": True,
                                         "input": {"command": "printf fixture-2"},
                                         "output": '{"output": "fixture-2", "exit_code": 0}'}),
                ("message.assistant.delta", {"text": "Tools "}),
                ("message.assistant.delta", {"text": "done."}),
                ("message.assistant.completed", {"text": "Tools done."}),
                ("turn.ended", {"endedAt": 0, "status": "completed"}),
                ("session.running", {"running": False}),
            ]
            assert snapshot["lastSeq"] == projected["lastSeq"] == cursor == 14
            assert asdict(fold(events)) == projected
            tail = await rpc(node, "session.events.since", **args, lastSeq=cursor)
            assert tail == {**page, "events": []}
            stale = await rpc(node, "session.events.since", sessionId=session, epoch=gateway_epoch, lastSeq=cursor)
            assert stale == {**tail, "snapshotRequired": True}
            print_replay("hermes-native", {**page, "events": events}, snapshot)

            for kind, payload in (("message.start", {"text": "Next prompt"}), ("message.delta", {"text": "Next"})):
                frames.append({"session_id": runtime_id, "replay_epoch": gateway_epoch, "seq": len(frames) + 1,
                               "admission_id": "fixture-turn-2", "type": kind, "payload": payload})
            new_page = await rpc(node, "session.events.since", **args, lastSeq=cursor)
            assert new_page["epoch"] == epoch and new_page["hasMore"] is False
            assert [(event["seq"], event["type"]) for event in new_page["events"]] == [
                (15, "turn.started"), (16, "message.user"), (17, "session.running"), (18, "message.assistant.delta"),
            ]
            new_snapshot = await rpc(node, "session.snapshot", sessionId=session)
            assert new_snapshot["epoch"] == epoch
            assert new_snapshot["snapshot"] == asdict(fold(events + new_page["events"]))
            assert new_snapshot["snapshot"]["runId"] == "fixture-turn-2"
        finally:
            await adapter.close()

    asyncio.run(run())


@pytest.mark.parametrize("withhold_retained_frames", [False, True], ids=["legacy", "authority"])
def test_gateway_truncated_replay(make_node, tmp_path, wire_adapter, native_replay, withhold_retained_frames):
    frames = native_replay["events"]
    session = frames[0]["session_id"]
    gateway_epoch = native_replay["replay_epoch"]
    evicted_through = 0

    def dispatch(_, request):
        method, params = request["method"], request["params"]
        if method == "session.resume":
            return {"result": {"session_id": session, "replay_epoch": gateway_epoch, "info": {"cwd": str(tmp_path)}}}
        if method == "session.events.since":
            cursor = params["last_seen"]
            truncated = cursor < evicted_through
            available = frames[max(cursor, evicted_through):]
            if truncated and withhold_retained_frames:
                available = []
            return {"result": {**native_replay, "events": available, "count": len(available), "truncated": truncated,
                               "snapshot_required": truncated and withhold_retained_frames}}
        assert method == "client.capabilities"
        return {"result": {}}

    async def run():
        nonlocal evicted_through
        adapter, _ = wire_adapter(dispatch, canonical=withhold_retained_frames, replay_epoch=gateway_epoch)
        node = make_node(hermes=adapter)
        try:
            full = await rpc(node, "session.snapshot", sessionId=session)
            evicted_through = 8
            partial = await rpc(node, "session.snapshot", sessionId=session)
            assert partial["source"] == "gateway"
            assert partial["epoch"] != full["epoch"]
            assert partial["incomplete"] is True
            assert partial["lastSeq"] == partial["snapshot"]["lastSeq"] == 6
            assistant, = partial["snapshot"]["messages"]
            assert assistant["text"] == "Tools done."
            assert [tool["callId"] for tool in assistant["toolCalls"]] == ["fixture-tool-2"]

            args = {"sessionId": session, "epoch": partial["epoch"]}
            first = await rpc(node, "session.events.since", **args, lastSeq=0)
            assert first["snapshotRequired"] is True
            assert asdict(fold(first["events"])) == partial["snapshot"]
            tail = await rpc(node, "session.events.since", **args, lastSeq=partial["lastSeq"])
            assert tail == {**args, "source": "gateway", "events": [], "hasMore": False}
            stale = await rpc(node, "session.events.since", sessionId=session,
                              epoch=full["epoch"], lastSeq=full["lastSeq"])
            assert stale == {**tail, "snapshotRequired": True}
            print(f"hermes-truncated source={partial['source']} incomplete={partial['incomplete']} "
                  f"messages={len(partial['snapshot']['messages'])} lastSeq={partial['lastSeq']}")

            evicted_through = len(frames)
            empty = await rpc(node, "session.snapshot", sessionId=session)
            assert empty["incomplete"] is True
            assert empty["lastSeq"] == empty["snapshot"]["lastSeq"] == 0
            assert empty["snapshot"]["messages"] == []
        finally:
            await adapter.close()

    asyncio.run(run())


def test_native_payload_uses_contract_fields_and_preserves_known_times():
    updates = [
        ("session.info", {"cwd": "/fixture", "pending": [], "stored_session_id": "internal"}),
        ("message.start", {"turn_id": "explicit-turn", "started_at": 1000}),
        ("message.user", {"text": "attachment", "session_id": "internal", "attachments": [
            {"artifact_id": "artifact", "file_name": "report.txt", "size_bytes": 42, "local_path": "/private"},
        ]}),
        ("approval.request", {"prompt_id": "approve", "command": "example", "execution_generation": 1}),
        ("approval.settled", {"prompt_id": "approve", "choice": "once"}),
        ("tool.complete", {"tool_call_id": "tool", "tool_name": "terminal", "is_error": True, "duration_s": 0.25}),
        ("notice", {"message": "gateway notice", "replay_epoch": "internal"}),
        ("message.complete", {"text": "final", "reasoning": "thought", "status": "interrupted",
                             "ended_at": 1600, "turn_usage": {"input": 20, "output": 10}, "usage": {"input": 100}}),
        ("todo.updated", {"todos": []}),
    ]
    frames = [{"type": kind, "payload": payload, "seq": seq, "at": 1000 + seq}
              for seq, (kind, payload) in enumerate(updates, 1)]
    frames.append({"type": "legacy.control", "seq": len(frames) + 1})
    _, events = normalize_gateway_replay("session", "epoch", frames)
    payloads = {event["type"]: event["payload"] for event in events}
    assert payloads["session.created"] == {"cwd": "/fixture", "provider": "hermes"}
    assert payloads["message.user"] == {"text": "attachment", "attachments": [
        {"artifactId": "artifact", "fileName": "report.txt", "sizeBytes": 42},
    ]}
    assert payloads["approval.requested"] == {"requestId": "approve", "command": "example"}
    assert payloads["approval.resolved"] == {"requestId": "approve", "decision": "allow_once"}
    assert payloads["tool.call.completed"] == {"callId": "tool", "name": "terminal", "ok": False, "durationMs": 250}
    assert payloads["notice"] == {"text": "gateway notice", "level": "info", "source": "hermes"}
    assert "todo.updated" not in payloads
    snapshot = fold(events)
    turn, = snapshot.turns
    assert (turn["turnId"], turn["durationMs"], turn["status"]) == ("explicit-turn", 600, "cancelled")
    assert snapshot.usage == {"in": 20, "out": 10}


def test_gateway_without_ready_epoch_uses_node_side_log(make_node, wire_adapter):
    def dispatch(_, request):
        assert request["method"] == "client.capabilities"
        return {"result": {}}

    async def run():
        adapter, _ = wire_adapter(dispatch, canonical=True, replay_epoch=None)
        node = make_node(hermes=adapter)
        log = node._session_event_log
        original = fixture_events("hermes")
        events = [{**event, "epoch": log.epoch} for event in original]
        session = events[0]["sessionId"]
        try:
            with log.store as store:
                for event in original + events:
                    store.append(event)
                snapshot = await rpc(node, "session.snapshot", sessionId=session)
                assert snapshot == {"sessionId": session, "source": "node", "epoch": log.epoch,
                                    "lastSeq": events[-1]["seq"], "snapshot": asdict(fold(events)),
                                    "incomplete": True, "hasMoreBefore": False, "beforeCursor": None}
                old = await rpc(node, "session.events.since", sessionId=session, epoch="old-gateway", lastSeq=100)
                assert old == {"sessionId": session, "source": "node", "epoch": log.epoch,
                               "events": [], "hasMore": False, "snapshotRequired": True}
                since = await rpc(node, "session.events.since", sessionId=session, epoch=log.epoch, lastSeq=0)
                assert since == {"sessionId": session, "source": "node", "epoch": log.epoch,
                                 "events": events, "hasMore": False}
                prior_epoch = original[0]["epoch"]
                prior = await rpc(node, "session.events.since", sessionId=session, epoch=prior_epoch, lastSeq=0)
                assert prior == {**since, "epoch": prior_epoch, "events": original}
                print_replay("hermes-fallback", since, snapshot)
        finally:
            await adapter.close()

    asyncio.run(run())


def test_session_replay_disabled(make_node, monkeypatch, wire_adapter):
    monkeypatch.setenv("STUDIOLO_SESSION_EVENTS", "0")

    async def run():
        adapter, sockets = wire_adapter(lambda *_: pytest.fail("gateway contacted with replay off"), canonical=True)
        node = make_node(hermes=adapter)
        assert await rpc(node, "session.snapshot", sessionId="s", provider="hermes") == {
            "code": "unsupported", "source": "node",
        }
        assert await rpc(node, "session.events.since", sessionId="s", epoch="ep", lastSeq=0) == {
            "code": "unsupported", "source": "node",
        }
        assert not sockets

    asyncio.run(run())
