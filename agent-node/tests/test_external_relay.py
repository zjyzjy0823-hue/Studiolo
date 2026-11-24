import asyncio
import json
from unittest.mock import AsyncMock

import pytest

from agent_node.adapters.hermes_ws import HermesWsAdapter
from agent_node.config import DirectTransferConfig, NodeConfig
from agent_node.daemon import AgentNodeDaemon, map_external_gateway_event


def _make_daemon(tmp_path, adapter):
    config = NodeConfig(
        "http://127.0.0.1:8000",
        "sn_live_test",
        (tmp_path,),
        direct=DirectTransferConfig(enabled=False),
    )
    return AgentNodeDaemon(config, adapters={"hermes": adapter}, staging_dir=tmp_path)


def test_daemon_registers_on_session_event_idempotently(tmp_path):
    fake_adapter = HermesWsAdapter((tmp_path,))
    assert fake_adapter.on_session_event is None

    daemon = _make_daemon(tmp_path, fake_adapter)
    assert fake_adapter.on_session_event is not None
    first_handler = fake_adapter.on_session_event

    # 幂等：重复注册不叠加、仍为同一个绑定方法
    daemon._register_external_event_handlers()
    assert fake_adapter.on_session_event == first_handler


def test_map_external_gateway_event_six_event_types():
    sid = "sess-1"
    run_id = "external-1700000000"

    # 1. message.delta -> TextDelta
    f_text = map_external_gateway_event(sid, {"type": "message.delta", "payload": {"text": "hello"}}, run_id)
    assert f_text == {
        "type": "TextDelta",
        "text": "hello",
        "runId": run_id,
        "requestId": run_id,
        "sessionId": sid,
        "provider": "hermes",
    }

    # 2. reasoning.delta -> ThoughtDelta
    f_thought = map_external_gateway_event(sid, {"type": "reasoning.delta", "payload": {"text": "thinking..."}}, run_id)
    assert f_thought == {
        "type": "ThoughtDelta",
        "text": "thinking...",
        "runId": run_id,
        "requestId": run_id,
        "sessionId": sid,
        "provider": "hermes",
    }

    # 3. tool.start -> ToolCall (supports payload.call_id and payload.tool_id)
    f_start = map_external_gateway_event(
        sid,
        {"type": "tool.start", "payload": {"call_id": "call-1", "name": "bash", "args": {"cmd": "ls"}}},
        run_id,
    )
    assert f_start == {
        "type": "ToolCall",
        "callId": "call-1",
        "name": "bash",
        "status": "running",
        "args": {"cmd": "ls"},
        "input": {"cmd": "ls"},
        "runId": run_id,
        "sessionId": sid,
        "provider": "hermes",
    }
    f_start_native = map_external_gateway_event(
        sid,
        {"type": "tool.start", "payload": {"tool_id": "tool-2", "name": "terminal", "args": {"command": "pwd"}}},
        run_id,
    )
    assert f_start_native is not None and f_start_native["callId"] == "tool-2"

    # 4. tool.progress -> ToolCallUpdate (running)
    f_progress = map_external_gateway_event(
        sid,
        {"type": "tool.progress", "payload": {"call_id": "call-1", "name": "bash", "message": "50%"}},
        run_id,
    )
    assert f_progress == {
        "type": "ToolCallUpdate",
        "callId": "call-1",
        "name": "bash",
        "status": "running",
        "output": "50%",
        "durationMs": None,
        "runId": run_id,
        "sessionId": sid,
        "provider": "hermes",
    }

    # 5a. tool.complete without durationMs -> durationMs is None (NOT 0)
    f_complete_no_dur = map_external_gateway_event(
        sid,
        {"type": "tool.complete", "payload": {"call_id": "call-1", "name": "bash", "output": "ok"}},
        run_id,
    )
    assert f_complete_no_dur == {
        "type": "ToolCallUpdate",
        "callId": "call-1",
        "name": "bash",
        "status": "completed",
        "output": "ok",
        "durationMs": None,
        "runId": run_id,
        "sessionId": sid,
        "provider": "hermes",
    }

    # 5b. tool.complete with error and duration_s
    f_complete_err = map_external_gateway_event(
        sid,
        {
            "type": "tool.complete",
            "payload": {
                "tool_id": "call-2",
                "name": "bash",
                "is_error": True,
                "error": "exit 1",
                "duration_s": 1.25,
            },
        },
        run_id,
    )
    assert f_complete_err == {
        "type": "ToolCallUpdate",
        "callId": "call-2",
        "name": "bash",
        "status": "error",
        "output": "exit 1",
        "error": "exit 1",
        "durationMs": 1250,
        "runId": run_id,
        "sessionId": sid,
        "provider": "hermes",
    }

    # 6. turn completion -> Completed (both session.info running=false and turn.completed / message.complete)
    for end_event in (
        {"type": "session.info", "payload": {"running": False}},
        {"type": "turn.completed", "payload": {}},
        {"type": "message.complete", "payload": {"status": "complete"}},
    ):
        assert map_external_gateway_event(sid, end_event, run_id) == {
            "type": "Completed",
            "runId": run_id,
            "sessionId": sid,
            "provider": "hermes",
        }


def test_run_id_stable_within_turn_and_changes_after_completed(tmp_path):
    async def run():
        adapter = HermesWsAdapter((tmp_path,))
        daemon = _make_daemon(tmp_path, adapter)
        ws = AsyncMock()
        daemon._ws = ws

        # First turn
        adapter.on_session_event("sess-1", {"type": "reasoning.delta", "payload": {"text": "plan"}})
        adapter.on_session_event("sess-1", {"type": "message.delta", "payload": {"text": "part1"}})
        adapter.on_session_event("sess-1", {"type": "message.delta", "payload": {"text": "part2"}})
        adapter.on_session_event("sess-1", {"type": "session.info", "payload": {"running": False}})
        # Trailing duplicate session.info running=false should be ignored once Completed cleared the turn
        adapter.on_session_event("sess-1", {"type": "session.info", "payload": {"running": False}})

        # Second turn immediately after Completed (same second!)
        adapter.on_session_event("sess-1", {"type": "message.delta", "payload": {"text": "next turn"}})
        adapter.on_session_event("sess-1", {"type": "turn.completed", "payload": {}})

        await asyncio.gather(*list(daemon._external_event_tasks))
        sent = [json.loads(call.args[0]) for call in ws.send.await_args_list]
        assert [frame["type"] for frame in sent] == [
            "ThoughtDelta",
            "TextDelta",
            "TextDelta",
            "Completed",
            "TextDelta",
            "Completed",
        ]
        turn1_run_ids = {frame["runId"] for frame in sent[:4]}
        turn2_run_ids = {frame["runId"] for frame in sent[4:]}
        assert len(turn1_run_ids) == 1
        assert len(turn2_run_ids) == 1
        turn1_id = next(iter(turn1_run_ids))
        turn2_id = next(iter(turn2_run_ids))
        assert turn1_id.startswith("external-")
        assert turn2_id.startswith("external-")
        assert turn1_id != turn2_id

    asyncio.run(run())


def test_local_active_run_is_not_relayed(tmp_path):
    async def run():
        adapter = HermesWsAdapter((tmp_path,))
        daemon = _make_daemon(tmp_path, adapter)
        ws = AsyncMock()
        daemon._ws = ws
        daemon._active_runs.add(("hermes", "sess-local"))

        adapter.on_session_event("sess-local", {"type": "message.delta", "payload": {"text": "dup"}})
        adapter.on_session_event("sess-local", {"type": "tool.start", "payload": {"call_id": "c1", "name": "bash"}})
        adapter.on_session_event("sess-local", {"type": "turn.completed", "payload": {}})

        await asyncio.gather(*list(daemon._external_event_tasks))
        assert ws.send.await_count == 0

    asyncio.run(run())


@pytest.mark.parametrize("dirty_event", [
    {},
    {"type": "unknown.event", "payload": {"text": "x"}},
    {"type": "message.delta"},
    {"type": "message.delta", "payload": None},
    {"type": "message.delta", "payload": "not-a-dict"},
    {"type": "message.delta", "payload": {"text": 123}},
    {"type": "reasoning.delta", "payload": {}},
    {"type": "tool.start", "payload": {"name": "bash"}},
    {"type": "tool.progress", "payload": {}},
    {"type": "tool.complete", "payload": {"name": "bash"}},
    {"type": "session.info", "payload": "bad"},
    None,
    "not-even-a-dict",
])
def test_dirty_external_events_do_not_raise(tmp_path, dirty_event):
    async def run():
        adapter = HermesWsAdapter((tmp_path,))
        daemon = _make_daemon(tmp_path, adapter)
        ws = AsyncMock()
        daemon._ws = ws

        assert map_external_gateway_event("sess-dirty", dirty_event, "external-1") is None
        adapter.on_session_event("sess-dirty", dirty_event)
        await asyncio.gather(*list(daemon._external_event_tasks))
        assert ws.send.await_count == 0

    asyncio.run(run())


def test_end_to_end_gateway_wire_relays_external_turn_to_core_ws(tmp_path, monkeypatch):
    from tests.test_hermes_ws import GatewaySocket

    async def credentials(self):
        return self._ws_url, None

    sockets = []

    def dispatch(socket, msg):
        method = msg["method"]
        if method == "session.resume":
            return {
                "result": {
                    "session_id": "runtime-ext",
                    "session_key": "saved-ext",
                    "running": True,
                    "turn_started_at": 1234.75,
                    "info": {"cwd": str(tmp_path)},
                }
            }
        return {"result": {}}

    def connect(*args, **kwargs):
        sock = GatewaySocket(dispatch, canonical=True, replay_epoch="ep-1")
        sockets.append(sock)
        return sock

    monkeypatch.setattr("agent_node.adapters.hermes_ws.websockets.connect", connect)
    monkeypatch.setattr(HermesWsAdapter, "_credentials", credentials)

    async def run():
        adapter = HermesWsAdapter((tmp_path,))
        daemon = _make_daemon(tmp_path, adapter)
        ws = AsyncMock()
        try:
            await daemon.handle_command(ws, {"type": "session.subscribe", "provider": "hermes", "sessionId": "saved-ext"})
            replay = json.loads(ws.send.await_args.args[0])
            assert replay["type"] == "SessionStreamReplay"
            assert replay["active"] is True
            assert replay["runId"] == "external-1234"
            ws.send.reset_mock()

            sock = sockets[0]
            stamp = {"session_id": "runtime-ext", "replay_epoch": "ep-1"}
            sock.event("reasoning.delta", {"text": "check files"}, seq=1, **stamp)
            sock.event("tool.start", {"tool_id": "t1", "name": "terminal", "args": {"command": "ls"}}, seq=2, **stamp)
            sock.event("tool.progress", {"tool_id": "t1", "name": "terminal", "message": "listing"}, seq=3, **stamp)
            sock.event("tool.complete", {"tool_id": "t1", "name": "terminal", "result": "a.py"}, seq=4, **stamp)
            sock.event("message.delta", {"text": "Found a.py"}, seq=5, **stamp)
            sock.event("message.complete", {"status": "complete"}, seq=6, **stamp)
            sock.event("session.info", {"running": False, "cwd": str(tmp_path)}, seq=7, **stamp)

            for _ in range(50):
                if ws.send.await_count >= 6 and not daemon._external_event_tasks:
                    break
                await asyncio.sleep(0.01)

            sent = [json.loads(call.args[0]) for call in ws.send.await_args_list]
            assert [f["type"] for f in sent] == [
                "ThoughtDelta",
                "ToolCall",
                "ToolCallUpdate",
                "ToolCallUpdate",
                "TextDelta",
                "Completed",
            ]
            assert all(f["runId"] == "external-1234" for f in sent)
            assert all(f["sessionId"] == "saved-ext" and f["provider"] == "hermes" for f in sent)
            assert sent[3]["status"] == "completed"
            assert sent[3]["durationMs"] is None
        finally:
            await adapter.close()

    asyncio.run(run())

