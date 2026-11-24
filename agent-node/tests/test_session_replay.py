import asyncio
from dataclasses import asdict
import json
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from agent_node.config import DirectTransferConfig, NodeConfig
from agent_node.daemon import AgentNodeDaemon
from agent_node.session_events import fold
from test_hermes_ws import wire_adapter  # noqa: F401  (pytest fixture)


def fixture_events(provider):
    path = Path(__file__).parent / "fixtures" / "session_events" / f"{provider}.jsonl"
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


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
                                "lastSeq": events[-1]["seq"], "snapshot": asdict(fold(events))}
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
                                    "lastSeq": events[-1]["seq"], "snapshot": asdict(fold(events))}
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


def test_gateway_native_epoch_pagination_and_projection(make_node, tmp_path, wire_adapter):
    fixture = fixture_events("hermes")
    session = fixture[0]["sessionId"]
    epoch = "native-session-epoch"
    native = [
        ("message.start", {}),
        ("tool.start", {"tool_id": "call-1", "name": "terminal"}),
        ("tool.progress", {"tool_id": "call-1", "progress": 0.5}),
        ("tool.complete", {"tool_id": "call-1", "result_text": fixture[6]["payload"]["output"]}),
        ("tool.start", {"tool_id": "call-2", "name": "terminal"}),
        ("tool.complete", {"tool_id": "call-2", "result_text": fixture[9]["payload"]["output"]}),
        ("message.delta", fixture[10]["payload"]),
        ("message.complete", {**fixture[10]["payload"], "turn_usage": {"input": 20, "output": 10}}),
        ("todo.updated", {"todos": []}),
    ]
    events = [{"session_id": session, "replay_epoch": epoch, "seq": seq, "type": kind,
               "admission_id": "native-turn", "execution_generation": 7, "payload": payload}
              for seq, (kind, payload) in enumerate(native, 1)]

    def dispatch(_, request):
        method, params = request["method"], request["params"]
        if method == "session.resume":
            return {"result": {"session_id": session, "replay_epoch": epoch, "info": {"cwd": str(tmp_path)}}}
        if method == "session.snapshot":
            return {"error": {"code": -32601, "message": "method not found"}}
        if method == "session.events.since":
            assert params["session_id"] == session
            if params["replay_epoch"] != epoch:
                return {"result": {"events": [], "replay_epoch": epoch, "snapshot_required": True}}
            cursor = params["last_seen"]
            return {"result": {"events": events[cursor:cursor + 5], "has_more": cursor + 5 < len(events),
                               "replay_epoch": epoch, "last_sequence": events[-1]["seq"]}}
        assert method == "client.capabilities"
        return {"result": {}}

    async def run():
        adapter, _ = wire_adapter(dispatch, canonical=True)
        node = make_node(hermes=adapter)
        try:
            snapshot = await rpc(node, "session.snapshot", sessionId=session)
            assert (snapshot["source"], snapshot["epoch"], snapshot["lastSeq"]) == ("gateway", epoch, 9)
            projected = snapshot["snapshot"]
            assert projected["lastSeq"] == 9
            assert projected["running"] is False
            assert projected["turns"][0]["status"] == "completed"
            assert projected["usage"] == {"in": 20, "out": 10}
            assert [m["role"] for m in projected["messages"]] == ["assistant"]
            assert projected["messages"][0]["text"] == fixture[10]["payload"]["text"]
            assert [tool["status"] for tool in projected["messages"][0]["toolCalls"]] == ["completed", "completed"]
            args = {"sessionId": session, "epoch": epoch}
            first = await rpc(node, "session.events.since", **args, lastSeq=0, limit=3)
            assert first == {**args, "source": "gateway", "events": events[:3], "hasMore": True}
            second = await rpc(node, "session.events.since", **args, lastSeq=3)
            assert second == {**first, "events": events[3:8]}
            last = await rpc(node, "session.events.since", **args, lastSeq=8)
            assert last == {**first, "events": events[8:], "hasMore": False}
            assert await rpc(node, "session.events.since", **args, lastSeq=9) == {**last, "events": []}
            stale = await rpc(node, "session.events.since", sessionId=session, epoch="old", lastSeq=9)
            assert stale == {**last, "events": [], "snapshotRequired": True}
            print_replay("hermes-native", {**first, "events": first["events"] + second["events"] + last["events"]}, snapshot)
        finally:
            await adapter.close()

    asyncio.run(run())


def test_gateway_native_snapshot_and_truncated_replay(make_node, tmp_path, wire_adapter):
    session = "saved"
    projected = {"messages": [{"role": "user", "text": "prompt"}], "turns": [], "notices": [],
                 "approvals": [], "usage": {}, "running": False, "runId": None, "lastSeq": 72}
    native_available = True

    def dispatch(_, request):
        method = request["method"]
        if method == "session.resume":
            return {"result": {"session_id": session, "info": {"cwd": str(tmp_path)}}}
        if method == "session.snapshot":
            if native_available:
                return {"result": {"snapshot": projected, "last_sequence": 72}}
            return {"error": {"code": -32601, "message": "method not found"}}
        if method == "session.events.since":
            assert not native_available
            return {"result": {"events": [], "latest_seq": 72, "truncated": True}}
        assert method == "client.capabilities"
        return {"result": {}}

    async def run():
        nonlocal native_available
        adapter, _ = wire_adapter(dispatch, canonical=False)
        node = make_node(hermes=adapter)
        try:
            assert await rpc(node, "session.snapshot", sessionId=session) == {
                "sessionId": session, "source": "gateway", "epoch": "gateway-epoch",
                "lastSeq": 72, "snapshot": projected,
            }
            native_available = False
            assert await rpc(node, "session.snapshot", sessionId=session) == {
                "sessionId": session, "source": "gateway", "epoch": "gateway-epoch", "code": "replay_incomplete",
            }
            assert await rpc(node, "session.events.since", sessionId=session, epoch="gateway-epoch", lastSeq=0) == {
                "sessionId": session, "source": "gateway", "epoch": "gateway-epoch",
                "events": [], "hasMore": False, "snapshotRequired": True,
            }
        finally:
            await adapter.close()

    asyncio.run(run())


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
                                    "lastSeq": events[-1]["seq"], "snapshot": asdict(fold(events))}
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
