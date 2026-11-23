import asyncio
import json
import time
from unittest.mock import AsyncMock

import httpx
import pytest

from agent_node.adapters.hermes import HermesAdapter
from agent_node.adapters.hermes_ws import HermesWsAdapter
from agent_node.adapters.registry import build_adapter_registry
from agent_node.config import DirectTransferConfig, NodeConfig, load_node_config
from agent_node.daemon import AgentNodeDaemon


class GatewaySocket:
    """In-memory wire fixture that mixes RPC replies and events on the receive loop."""

    def __init__(self, dispatch, *, canonical):
        self.dispatch = dispatch
        self.frames = asyncio.Queue()
        self.event("gateway.ready", {"session_authority": canonical, "replay_epoch": "gateway-epoch"})

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        await self.close()

    def __aiter__(self):
        return self

    async def __anext__(self):
        frame = await self.frames.get()
        if frame is None:
            raise StopAsyncIteration
        return json.dumps(frame)

    async def send(self, frame):
        msg = json.loads(frame)
        result = self.dispatch(self, msg)
        if result is not None:
            self.frames.put_nowait({"jsonrpc": "2.0", "id": msg["id"], **result})

    async def close(self):
        self.frames.put_nowait(None)

    def event(self, kind, payload, **params):
        self.frames.put_nowait({"jsonrpc": "2.0", "method": "event",
                                "params": {"type": kind, "payload": payload, **params}})


@pytest.fixture
def wire_adapter(monkeypatch, tmp_path):
    async def credentials(self):
        return self._ws_url, None

    def make(dispatch, *, canonical):
        sockets = []

        def connect(*args, **kwargs):
            socket = GatewaySocket(dispatch, canonical=canonical)
            sockets.append(socket)
            return socket

        monkeypatch.setattr("agent_node.adapters.hermes_ws.websockets.connect", connect)
        monkeypatch.setattr(HermesWsAdapter, "_credentials", credentials)
        return HermesWsAdapter((tmp_path,)), sockets

    return make


def test_idle_transcript_relays_only_latest_new_assistant_once(tmp_path, wire_adapter):
    async def run(*, canonical):
        rows = [{"row_id": 1, "role": "assistant", "text": "old", "timestamp": time.time() - 60}]

        def dispatch(socket, msg):
            if msg["method"] == "session.create":
                return {"result": {"session_id": "saved", "info": {"cwd": str(tmp_path)}}}
            if msg["method"] == "session.transcript":
                assert msg["params"] == {"session_id": "saved", "order": "latest", "limit": 20}
                if not canonical:
                    return {"error": {"code": -32601, "message": "Method not found"}}
                return {"result": {"rows": rows}}
            if msg["method"] == "session.history":
                assert not canonical and msg["params"] == {"session_id": "saved"}
                return {"result": {"messages": rows}}
            return {"result": {}}

        adapter, sockets = wire_adapter(dispatch, canonical=canonical)
        config = NodeConfig("http://127.0.0.1:8000", "sn_live_test", (tmp_path,),
                            direct=DirectTransferConfig(enabled=False))
        daemon = AgentNodeDaemon(config, adapters={"hermes": adapter}, staging_dir=tmp_path)
        ws = AsyncMock()
        try:
            await daemon.handle_command(ws, {"type": "session.open", "provider": "hermes"})
            ws.send.reset_mock()
            await daemon._poll_idle_transcripts(ws, "node")
            ws.send.assert_not_awaited()
            rows.extend([
                {"row_id": 2, "role": "assistant", "text": "earlier report", "timestamp": time.time()},
                {"row_id": 3, "role": "assistant", "text": "job finished", "timestamp": time.time()},
                {"row_id": 4, "role": "user", "text": "user message", "timestamp": time.time()},
            ])
            await daemon._poll_idle_transcripts(ws, "node")
            await daemon._poll_idle_transcripts(ws, "node")
            assert len(sockets) == 1
            ws.send.assert_awaited_once()
            assert json.loads(ws.send.await_args.args[0]) == {
                "type": "TextDelta", "nodeId": "node", "provider": "hermes", "sessionId": "saved",
                "text": "job finished", "messageId": "3", "idle": True, "requestId": "idle-3",
            }
        finally:
            await adapter.close()

    asyncio.run(run(canonical=True))
    asyncio.run(run(canonical=False))


def test_idle_transcript_skips_active_run_and_recent_stream(tmp_path):
    async def run():
        adapter = AsyncMock(spec=HermesWsAdapter)
        config = NodeConfig("http://127.0.0.1:8000", "sn_live_test", (tmp_path,),
                            direct=DirectTransferConfig(enabled=False))
        daemon = AgentNodeDaemon(config, adapters={"hermes": adapter}, staging_dir=tmp_path)
        ws = AsyncMock()
        await daemon.handle_command(ws, {"type": "session.subscribe", "provider": "hermes", "sessionId": "saved"})
        ws.send.reset_mock()
        daemon._active_runs.add(("hermes", "saved"))
        await daemon._poll_idle_transcripts(ws, "node")
        daemon._active_runs.clear()
        daemon._idle_transcripts["saved"].last_event_at = time.monotonic()
        await daemon._poll_idle_transcripts(ws, "node")
        adapter.fetch_transcript.assert_not_awaited()
        ws.send.assert_not_awaited()

    asyncio.run(run())


def test_replays_after_disconnect_and_preserves_approval(tmp_path, wire_adapter):
    async def run():
        calls, events, approvals = [], [], []
        approval_open, answer, replayed = asyncio.Event(), asyncio.Event(), asyncio.Event()
        stamp = {"session_id": "stored", "replay_epoch": "session-epoch",
                 "admission_id": "admission-a", "execution_generation": 7}
        request = {"prompt_id": "p1", "command": "write notes", "choices": ["once", "session", "deny"],
                   "execution_generation": 7}
        snapshot = {"session_id": "stored", "stored_session_id": "stored", "revision": 2, "last_sequence": 0,
                    "execution_generation": 7, "replay_epoch": "session-epoch",
                    "info": {"cwd": str(tmp_path), "model": "test", "provider": "test-provider"}}

        def dispatch(socket, msg):
            method, params = msg["method"], msg["params"]
            calls.append(method)
            if method in ("session.create", "session.resume"):
                prompts = [{"kind": "approval", **request}] if method == "session.resume" else []
                return {"result": {**snapshot, "prompts": prompts}}
            if method == "session.transcript":
                return {"result": {"rows": []}}
            if method == "session.stats":
                return {"result": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}}
            if method == "prompt.submit":
                assert params["submission_id"] == "request-a"
                socket.event("message.delta", {"text": "A"}, seq=1, **stamp)
                socket.event("thinking.delta", {"text": "plan"}, seq=2, **stamp)
                socket.event("tool.start", {"tool_id": "t1", "name": "write", "args": {"path": "notes"}}, seq=3, **stamp)
                socket.event("approval.request", request, seq=4, **stamp)
                return {"result": {"status": "started", "admission_id": "admission-a", "execution_generation": 7}}
            if method == "session.events.since":
                assert params["last_seen"] == 4
                return {"result": {"events": [{"type": "message.delta", "payload": {"text": "B"}, "seq": 5, **stamp}]}}
            if method == "session.steer":
                assert params == {"session_id": "stored", "text": "shorten", "execution_generation": 7}
                return {"result": {"status": "queued"}}
            if method == "approval.respond":
                assert params == {"session_id": "stored", "prompt_id": "p1", "execution_generation": 7, "choice": "session"}
                socket.event("message.delta", {"text": "B"}, seq=5, **stamp)  # replay duplicate
                socket.event("tool.complete", {"tool_id": "t1", "name": "write", "result": {"ok": True}}, seq=6, **stamp)
                socket.event("message.complete", {"text": "ABC", "status": "complete",
                                                  "usage": {"input": 14, "output": 8, "total": 22}}, seq=7, **stamp)
            return {"result": {"ok": True}}

        adapter, sockets = wire_adapter(dispatch, canonical=True)

        async def emit(event):
            events.append(event)
            if event.get("text") == "B":
                replayed.set()

        async def approve(*args):
            approvals.append(args)
            history = await adapter.get_history(session_id="stored")
            assert history[-1]["toolCalls"][0]["status"] == "running"
            approval_open.set()
            await answer.wait()
            return "allow_session"

        try:
            async with asyncio.timeout(6):
                assert (await adapter.open_session(cwd=str(tmp_path)))["sessionId"] == "stored"
                job = asyncio.create_task(adapter.send_prompt(session_id="stored", text="write", request_id="request-a",
                                                              emit=emit, request_approval=approve))
                await approval_open.wait()
                assert await adapter.steer(session_id="stored", text="shorten")
                await sockets[0].close()
                await replayed.wait()
                answer.set()
                await job
            assert approvals == [("stored", "p1", "write notes", "medium")]
            assert "".join(event["text"] for event in events if event["type"] == "TextDelta") == "ABC"
            assert [event["type"] for event in events].count("Completed") == 1
            assert any(event["type"] == "ThoughtDelta" for event in events)
            assert any(event["type"] == "TokenUsage" and event["totalTokens"] == 7 for event in events)
            assert calls.count("prompt.submit") == 1
            assert calls.count("session.transcript") == 2
            assert len(sockets) == 2
        finally:
            await adapter.close()

    asyncio.run(run())


def test_legacy_approval_timeout_and_cancel_use_runtime_id(tmp_path, wire_adapter):
    async def run():
        events, calls = [], []
        approval_answered = asyncio.Event()

        def dispatch(socket, msg):
            method = msg.get("method")
            calls.append(method)
            runtime = {"session_id": "runtime", "info": {"cwd": str(tmp_path)}}
            if method == "session.create":
                return {"result": {**runtime, "stored_session_id": "saved"}}
            if method == "session.activate":
                assert msg["params"]["session_id"] == "runtime"
                return {"result": runtime}
            if method == "session.transcript":
                return {"error": {"code": -32601, "message": "Method not found"}}
            if method == "session.history":
                assert msg["params"]["session_id"] == "runtime"
                return {"result": {"messages": [{"role": "user", "text": "previous"}]}}
            if method == "prompt.submit":
                assert msg["params"]["session_id"] == "runtime"
                socket.frames.put_nowait({"jsonrpc": "2.0", "id": "approve-me", "method": "approval", "params": {
                    "session_id": "runtime", "request_id": "old-id", "command": "write notes",
                }})
                return {"result": {"status": "streaming"}}
            if method is None:
                assert msg == {"jsonrpc": "2.0", "id": "approve-me", "result": {"choice": "deny"}}
                approval_answered.set()
                return None
            if method == "session.interrupt":
                assert msg["params"] == {"session_id": "runtime"}
                socket.event("message.complete", {"status": "interrupted"}, session_id="runtime", seq=1)
                return {"result": {"status": "interrupted"}}
            return {"result": {}}

        adapter, _ = wire_adapter(dispatch, canonical=False)

        async def emit(event):
            events.append(event)

        async def approve(sid, call_id, command, risk):
            assert (sid, call_id, command, risk) == ("saved", "approve-me", "write notes", "medium")
            raise TimeoutError

        try:
            async with asyncio.timeout(6):
                assert (await adapter.open_session(cwd=str(tmp_path)))["sessionId"] == "saved"
                assert await adapter.get_history(session_id="saved") == [{"role": "user", "text": "previous"}]
                job = asyncio.create_task(adapter.send_prompt(session_id="saved", text="write", request_id="request-b",
                                                              emit=emit, request_approval=approve))
                await approval_answered.wait()
                await adapter.cancel(session_id="saved", run_id="old-run")
                await adapter.cancel(session_id="saved", run_id="request-b")
                await job
            assert events[-1]["type"] == "Failed" and events[-1]["code"] == "cancelled"
            assert calls.count("session.interrupt") == 1
        finally:
            await adapter.close()

    asyncio.run(run())


def test_transport_default_config_and_override(tmp_path):
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"hermes": {"transport": "acp", "wsPort": 9219},
                                "providers": {"hermes": {"command": "custom-hermes"}}}))
    env = {"STUDIOLO_CORE_URL": "http://127.0.0.1:8000", "STUDIOLO_NODE_TOKEN": "sn_live_test",
           "STUDIOLO_ALLOWED_ROOTS": str(tmp_path)}
    assert isinstance(build_adapter_registry(load_node_config(environ=env))["hermes"], HermesWsAdapter)
    assert type(build_adapter_registry(load_node_config(path, env))["hermes"]) is HermesAdapter
    ws = build_adapter_registry(load_node_config(path, {**env, "STUDIOLO_HERMES_TRANSPORT": "ws"}))["hermes"]
    assert isinstance(ws, HermesWsAdapter)
    assert ws.command == "custom-hermes"
    assert ws._ws_url == "ws://127.0.0.1:9219/api/ws"
    with pytest.raises(ValueError, match="Hermes transport"):
        load_node_config(path, {**env, "STUDIOLO_HERMES_TRANSPORT": "invalid"})


def test_ticket_is_minted_each_dial_and_token_stays_on_same_origin(tmp_path, monkeypatch):
    credential = tmp_path / "dashboard-token"
    credential.write_text("test-credential\n")
    requests = []

    def respond(request):
        assert str(request.url) == "http://127.0.0.1:9119/api/auth/ws-ticket"
        assert request.headers["Authorization"] == "Bearer test-credential"
        requests.append(request)
        return httpx.Response(200, json={"ticket": f"ticket-{len(requests)}"})

    client_class = httpx.AsyncClient
    monkeypatch.setattr("agent_node.adapters.hermes_ws.httpx.AsyncClient",
                        lambda **options: client_class(transport=httpx.MockTransport(respond), **options))

    async def run():
        adapter = HermesWsAdapter((tmp_path,), token_file=credential)
        first, second = await adapter._credentials(), await adapter._credentials()
        assert first == ("ws://127.0.0.1:9119/api/ws", ["hermes-gateway-v1", "hermes-gateway-ticket.ticket-1"])
        assert second[1][-1] == "hermes-gateway-ticket.ticket-2"

    asyncio.run(run())
