import asyncio
import json
import time
from unittest.mock import AsyncMock

import httpx
import pytest

from agent_node.adapters.hermes import HermesAdapter
from agent_node.adapters.hermes_ws import HermesWsAdapter
from agent_node.adapters.registry import build_adapter_registry
from agent_node.config import DirectTransferConfig, HermesMediaConfig, NodeConfig, load_node_config
from agent_node.daemon import AgentNodeDaemon, SessionStream
from agent_node.hermes_media import relay_hermes_attachment


class GatewaySocket:
    """In-memory wire fixture that mixes RPC replies and events on the receive loop."""

    def __init__(self, dispatch, *, canonical, replay_epoch):
        self.dispatch = dispatch
        self.frames = asyncio.Queue()
        self.event("gateway.ready", {"session_authority": canonical, "replay_epoch": replay_epoch})

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

    def make(dispatch, *, canonical, replay_epoch="gateway-epoch"):
        sockets = []

        def connect(*args, **kwargs):
            socket = GatewaySocket(dispatch, canonical=canonical, replay_epoch=replay_epoch)
            sockets.append(socket)
            return socket

        monkeypatch.setattr("agent_node.adapters.hermes_ws.websockets.connect", connect)
        monkeypatch.setattr(HermesWsAdapter, "_credentials", credentials)
        return HermesWsAdapter((tmp_path,)), sockets

    return make


@pytest.mark.parametrize(("scenario", "expected"), [
    ("live-basename", None),
    ("live-full-path", None),
    ("tool-only", "media_forbidden"),
    ("text-only", "media_forbidden"),
    ("different-turn", "media_forbidden"),
    ("other-session", "media_forbidden"),
    ("same-basename", "media_forbidden"),
    ("url-argument", "media_forbidden"),
    ("invalid-first-argument", "media_forbidden"),
    ("failed-tool", "media_forbidden"),
    ("outside-root", "media_forbidden"),
    ("too-large", "media_too_large"),
    ("restart", None),
    ("restart-paged", None),
    ("restart-failed-tool", "media_forbidden"),
    ("restart-other-session", "media_forbidden"),
    ("restart-ancestor", "media_forbidden"),
])
def test_tool_written_attachment_relay(tmp_path, monkeypatch, wire_adapter, scenario, expected):
    allowed = tmp_path.resolve() / "allowed"
    allowed.mkdir()
    source = (allowed.parent if scenario == "outside-root" else allowed) / "report.html"
    document = b"<p>Hermes report</p>"
    source.write_bytes(document)
    if scenario == "same-basename":
        alternate = allowed / "other" / source.name
        alternate.parent.mkdir()
        alternate.write_bytes(b"Another file with the same name")
    if scenario == "too-large":
        with source.open("r+b") as file:
            file.truncate(32 * 1024 * 1024 + 1)
    token = allowed / "token"
    token.write_text("test-token")
    config = NodeConfig("https://core.example", "sn_live_test", (allowed,),
                        direct=DirectTransferConfig(enabled=False),
                        hermes_media=HermesMediaConfig("http://127.0.0.1", token))

    session_id = "other" if scenario == "other-session" else "stored"
    reference = str(source) if scenario in ("live-full-path", "outside-root") else "./report.html"
    basename_or_path = reference if scenario == "live-full-path" else source.name
    body = "The work is done." if scenario in ("tool-only", "different-turn") else f"Saved {basename_or_path}."
    tool_name = "read_file" if scenario == "text-only" else "ExPoRt_report"
    failed = scenario in ("failed-tool", "restart-failed-tool")
    args = {"filePath": None, "path": f" {reference} ", "filename": "unused.html"}
    if scenario == "url-argument":
        args["filePath"] = f"file://{source}"
    elif scenario == "invalid-first-argument":
        args["filePath"] = 0
    metadata = {"id": session_id, "cwd": str(allowed)}
    row_owner = "older" if scenario in ("restart-other-session", "restart-ancestor") else "stored"
    rows = [
        {"role": "user", "text": "Create a report", "session_id": row_owner, "row_id": 1},
        {"role": "tool", "name": tool_name, "args": args, "session_id": row_owner,
         "tool_call_id": "write-1", "content": json.dumps({"error": "failed"} if failed else {"ok": True})},
        {"role": "assistant", "text": body, "content": None, "session_id": row_owner, "row_id": 3},
    ]
    if scenario == "restart-ancestor":
        metadata["parent_session_id"] = row_owner
        rows = [{key: value for key, value in row.items() if key != "session_id"} for row in rows]
    stamp = {"session_id": "stored", "admission_id": "admission-a", "execution_generation": 7}
    calls, uploaded, download_paths = [], [], []
    run = 0

    def dispatch(socket, message):
        nonlocal run
        method, params = message["method"], message["params"]
        if method == "session.transcript":
            calls.append(params["session_id"])
            page = {"session_id": params["session_id"], "rows": rows if scenario.startswith("restart") else []}
            if scenario == "restart-paged":
                if params.get("cursor") == "older":
                    page["rows"] = rows[:2]
                else:
                    page.update(rows=[rows[2], *({"role": "user", "text": "Later prompt"} for _ in range(499))],
                                next_cursor="older")
            return {"result": page}
        if method == "session.resume":
            return {"result": {"session_id": "stored", "info": {"cwd": str(allowed)}}}
        if method == "prompt.submit":
            run += 1
            if run == 1:
                socket.event("tool.start", {"tool_id": "write-1", "name": tool_name}, **stamp)
                socket.event("tool.complete", {"tool_id": "write-1", "args": args,
                                                "result": {"error": "failed"} if failed else {"ok": True}}, **stamp)
            socket.event("message.complete", {"text": body if run == 1 else "I mentioned report.html."}, **stamp)
            return {"result": {"status": "started", "admission_id": "admission-a", "execution_generation": 7}}
        return {"result": {}}

    async def upstream(request):
        if request.url.path == f"/api/sessions/{session_id}":
            return httpx.Response(200, json=metadata)
        if request.url.path == f"/api/sessions/{session_id}/messages":
            return httpx.Response(200, json={"messages": []})
        assert request.url.path == "/api/files/download"
        download_paths.append(request.url.params["path"])
        return httpx.Response(200, content=document)

    async def core(request):
        uploaded.append(await request.aread())
        return httpx.Response(204)

    async def relay(*args, **kwargs):
        return await relay_hermes_attachment(*args, **kwargs, transport=httpx.MockTransport(upstream),
                                            core_transport=httpx.MockTransport(core))

    async def exercise():
        adapter, _ = wire_adapter(dispatch, canonical=True)
        daemon = AgentNodeDaemon(config, adapters={"hermes": adapter}, staging_dir=tmp_path)
        ws = AsyncMock()
        monkeypatch.setattr("agent_node.daemon.relay_hermes_attachment", relay)
        try:
            if scenario.startswith("restart"):
                assert adapter.attachment_writes("stored") == set()
            else:
                for turn in range(2 if scenario == "different-turn" else 1):
                    await adapter.send_prompt(session_id="stored", text="Report", request_id=f"req-{turn}",
                                              emit=AsyncMock(), request_approval=AsyncMock())
                calls.clear()

            await daemon.handle_command(ws, {
                "type": "hermes.media.relay", "_rpcId": "relay-1", "nodeId": "node", "provider": "hermes",
                "sessionId": session_id, "reference": "./other/report.html" if scenario == "same-basename" else reference,
                "transferId": "0" * 32, "maxBytes": 64 * 1024 * 1024,
            }, node_id="node")
            ws.send.assert_awaited_once()
            result = json.loads(ws.send.await_args.args[0])
            assert result["type"] == "HermesMediaResult"
            if expected:
                assert result["ok"] is False and result["code"] == expected
                assert uploaded == download_paths == []
            else:
                assert result["ok"] is True and result["sizeBytes"] == len(document)
                assert result["fileName"] == source.name
                assert uploaded == [document]
                assert download_paths == [str(source)]
            if scenario in ("restart", "restart-paged"):
                assert calls == ["stored"] * (2 if scenario == "restart-paged" else 1)
                assert adapter.attachment_writes("stored") == {reference}
            if scenario.startswith("live") or scenario == "restart-ancestor":
                assert calls == []
        finally:
            await adapter.close()

    asyncio.run(exercise())


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


@pytest.mark.parametrize("running", [True, False, None, ConnectionError("probe failed")])
def test_subscribe_replays_hermes_running_state(tmp_path, monkeypatch, running):
    async def run():
        adapter = HermesWsAdapter((tmp_path,))
        probe = AsyncMock(return_value=running)
        if isinstance(running, Exception):
            probe.side_effect = running
        monkeypatch.setattr(adapter, "session_running", probe)
        config = NodeConfig("http://127.0.0.1:8000", "sn_live_test", (tmp_path,),
                            direct=DirectTransferConfig(enabled=False))
        daemon = AgentNodeDaemon(config, adapters={"hermes": adapter}, staging_dir=tmp_path)
        ws = AsyncMock()
        subscribe = {"type": "session.subscribe", "provider": "hermes", "sessionId": "saved"}

        await daemon.handle_command(ws, subscribe)
        ws.send.assert_awaited_once()
        replay = json.loads(ws.send.await_args.args[0])
        assert replay["type"] == "SessionStreamReplay"
        assert replay["active"] is (running is True)
        assert replay["runId"] == ("external-0" if running is True else None)
        assert not daemon._active_runs
        probe.assert_awaited_once_with(session_id="saved")

        key = ("hermes", "saved")
        daemon._active_runs.add(key)
        daemon._session_streams[key] = SessionStream(run_id="local-run")
        await daemon.handle_command(ws, subscribe)
        replay = json.loads(ws.send.await_args.args[0])
        assert replay["type"] == "SessionStreamReplay"
        assert replay["active"] is True
        assert replay["runId"] == "local-run"
        probe.assert_awaited_once_with(session_id="saved")

    asyncio.run(run())


def test_subscribe_coalesces_probes_and_refreshes_after_two_seconds(tmp_path, monkeypatch, wire_adapter):
    async def run():
        now = 100.0
        running = True
        calls = []

        def dispatch(socket, msg):
            if msg["method"] == "session.resume":
                params = msg["params"]
                calls.append(params)
                assert params["omit_messages"] is True
                return {"result": {"running": running and params["session_id"] == "saved"}}
            return {"result": {}}

        monkeypatch.setattr("agent_node.adapters.hermes_ws.monotonic", lambda: now)
        adapter, sockets = wire_adapter(dispatch, canonical=False)
        config = NodeConfig("http://127.0.0.1:8000", "sn_live_test", (tmp_path,),
                            direct=DirectTransferConfig(enabled=False))
        daemon = AgentNodeDaemon(config, adapters={"hermes": adapter}, staging_dir=tmp_path)
        ws = AsyncMock()

        async def subscribe(sid="saved"):
            await daemon.handle_command(ws, {"type": "session.subscribe", "provider": "hermes", "sessionId": sid})
            replay = json.loads(ws.send.await_args.args[0])
            assert replay["type"] == "SessionStreamReplay"
            return replay["active"]

        try:
            assert await asyncio.gather(subscribe(), subscribe()) == [True, True]
            assert calls == [{"session_id": "saved", "omit_messages": True}]
            now += 1.99
            running = False
            assert await subscribe() is True
            assert len(calls) == 1
            assert await subscribe("other") is False
            assert calls[-1] == {"session_id": "other", "omit_messages": True}

            now += 0.02
            assert await subscribe() is False
            assert calls == [
                {"session_id": "saved", "omit_messages": True},
                {"session_id": "other", "omit_messages": True},
                {"session_id": "saved", "omit_messages": True},
            ]
            assert len(sockets) == 1
            assert not adapter._active and not adapter._sessions and not daemon._active_runs
        finally:
            await adapter.close()

    asyncio.run(run())


def test_active_snapshot_includes_fresh_external_hermes_runs(tmp_path, monkeypatch, wire_adapter):
    async def run():
        now = 100.0

        def dispatch(socket, msg):
            if msg["method"] == "session.resume":
                return {"result": {"running": msg["params"]["session_id"] != "idle"}}
            return {"result": {}}

        monkeypatch.setattr("agent_node.adapters.hermes_ws.monotonic", lambda: now)
        adapter, _ = wire_adapter(dispatch, canonical=True)
        config = NodeConfig("http://127.0.0.1:8000", "sn_live_test", (tmp_path,),
                            direct=DirectTransferConfig(enabled=False))
        daemon = AgentNodeDaemon(config, adapters={"hermes": adapter}, staging_dir=tmp_path)
        ws = AsyncMock()
        old_stream = SessionStream(stream_id="old-stream", run_id="old-run")
        old_stream.append({"type": "Completed"})
        daemon._session_streams[("hermes", "with-stream")] = old_stream
        daemon._session_streams[("hermes", "local")] = SessionStream(stream_id="local-stream", run_id="local-run")
        daemon._active_runs.add(("hermes", "local"))

        async def snapshot():
            await daemon.handle_command(ws, {"type": "session.active.list"})
            frame = json.loads(ws.send.await_args.args[0])
            assert frame["type"] == "ActiveRunsSnapshot"
            return sorted(frame["runs"], key=lambda run: run["sessionId"])

        local = {"provider": "hermes", "sessionId": "local", "runId": "local-run",
                 "streamId": "local-stream", "lastSeq": 0}
        try:
            for sid in ("external", "idle", "with-stream"):
                await daemon.handle_command(ws, {"type": "session.subscribe", "provider": "hermes", "sessionId": sid})
            replay = json.loads(ws.send.await_args.args[0])
            assert replay["type"] == "SessionStreamReplay"
            assert replay["active"] is True
            assert replay["runId"] == "old-run"
            assert replay["events"] == []
            assert await snapshot() == [
                {"provider": "hermes", "sessionId": "external", "runId": None},
                local,
                {"provider": "hermes", "sessionId": "with-stream", "runId": "old-run",
                 "streamId": "old-stream", "lastSeq": 1},
            ]
            now += 2
            assert await snapshot() == [local]
        finally:
            await adapter.close()

    asyncio.run(run())


def test_running_probe_returns_unknown_on_gateway_timeout(tmp_path, monkeypatch):
    async def run():
        adapter = HermesWsAdapter((tmp_path,))
        connection = AsyncMock()
        connection.call.side_effect = TimeoutError
        monkeypatch.setattr(adapter, "_online", AsyncMock(return_value=connection))
        try:
            assert await adapter.session_running(session_id="saved") is None
            assert await adapter.session_running(session_id="saved") is None
            connection.call.assert_awaited_once_with(
                "session.resume", {"session_id": "saved", "omit_messages": True}, timeout=3,
            )
            assert adapter.cached_running_sessions() == set()
        finally:
            await adapter.close()

    asyncio.run(run())


@pytest.mark.parametrize(("canonical", "generation", "steer_generation"), [
    (False, 7, {}),
    (True, 7, {"execution_generation": 7}),
    (True, None, {}),
])
def test_external_replay_and_steer_use_gateway_runtime_state(tmp_path, wire_adapter, canonical, generation,
                                                           steer_generation):
    async def run():
        calls = []

        def dispatch(socket, msg):
            method, params = msg["method"], msg["params"]
            if method == "session.resume":
                calls.append((method, params))
                snapshot = {"session_id": "runtime", "session_key": "saved", "running": True,
                            "turn_started_at": 1234.75, "info": {"cwd": str(tmp_path)}}
                if generation is not None:
                    snapshot["execution_generation"] = generation
                return {"result": snapshot}
            if method == "session.steer":
                calls.append((method, params))
                return {"result": {"status": "queued"}}
            return {"result": {}}

        adapter, _ = wire_adapter(dispatch, canonical=canonical)
        config = NodeConfig("http://127.0.0.1:8000", "sn_live_test", (tmp_path,),
                            direct=DirectTransferConfig(enabled=False))
        daemon = AgentNodeDaemon(config, adapters={"hermes": adapter}, staging_dir=tmp_path)
        ws = AsyncMock()
        session = {"provider": "hermes", "sessionId": "saved"}
        try:
            await daemon.handle_command(ws, {**session, "type": "session.subscribe"})
            replay = json.loads(ws.send.await_args.args[0])
            assert replay["type"] == "SessionStreamReplay"
            assert replay["active"] is True
            assert replay["runId"] == "external-1234"

            await daemon.handle_command(ws, {**session, "type": "prompt.steer", "text": "shorten",
                                             "requestId": "steer-request"})
            assert json.loads(ws.send.await_args.args[0]) == {
                "type": "SteerAccepted", "sessionId": "saved", "requestId": "steer-request",
                "code": "", "message": "",
            }
            assert calls == [
                ("session.resume", {"session_id": "saved", "omit_messages": True}),
                ("session.steer", {"session_id": "runtime", "text": "shorten", **steer_generation}),
            ]
            assert not daemon._active_runs and not daemon._session_streams
            assert not adapter._active and not adapter._sessions
        finally:
            await adapter.close()

    asyncio.run(run())


@pytest.mark.parametrize("reply", [
    {"result": {"status": "rejected"}},
    {"error": {"code": 4001, "message": "session not found"}},
    {"error": {"code": 4010, "message": "agent does not support steer"}},
    {"error": {"code": -32000, "message": "session_idle"}},
    {"error": {"code": -32000, "message": "stale_generation"}},
    {"error": {"code": -32000, "message": "steer_unavailable"}},
])
def test_external_steer_refusal_is_not_redirected(tmp_path, wire_adapter, reply):
    async def run():
        calls = []

        def dispatch(socket, msg):
            method = msg["method"]
            calls.append(method)
            if method == "session.resume":
                return {"result": {"session_id": "runtime", "running": True, "info": {"cwd": str(tmp_path)}}}
            if method == "session.steer":
                return reply
            return {"result": {}}

        adapter, _ = wire_adapter(dispatch, canonical=False)
        config = NodeConfig("http://127.0.0.1:8000", "sn_live_test", (tmp_path,),
                            direct=DirectTransferConfig(enabled=False))
        daemon = AgentNodeDaemon(config, adapters={"hermes": adapter}, staging_dir=tmp_path)
        ws = AsyncMock()
        try:
            assert await adapter.steer_external(session_id="saved", text="shorten") is False
            await daemon.handle_command(ws, {"type": "prompt.steer", "provider": "hermes",
                                             "sessionId": "saved", "text": "shorten"})
            response = json.loads(ws.send.await_args.args[0])
            assert response["type"] == "SteerRejected"
            assert response["code"] == "not_redirected"
            assert calls == ["client.capabilities", "session.resume", "session.steer", "session.steer"]
        finally:
            await adapter.close()

    asyncio.run(run())


def test_steer_without_running_hermes_turn_is_idle(tmp_path):
    async def run():
        adapter = AsyncMock(spec=HermesWsAdapter)
        adapter.session_running.return_value = False
        config = NodeConfig("http://127.0.0.1:8000", "sn_live_test", (tmp_path,),
                            direct=DirectTransferConfig(enabled=False))
        daemon = AgentNodeDaemon(config, adapters={"hermes": adapter}, staging_dir=tmp_path)
        ws = AsyncMock()
        await daemon.handle_command(ws, {"type": "prompt.steer", "provider": "hermes",
                                         "sessionId": "saved", "text": "shorten"})
        response = json.loads(ws.send.await_args.args[0])
        assert response["type"] == "SteerRejected"
        assert response["code"] == "idle"
        adapter.session_running.assert_awaited_once_with(session_id="saved")
        adapter.steer_external.assert_not_awaited()
        adapter.steer.assert_not_awaited()

    asyncio.run(run())


@pytest.mark.parametrize("starts_during_probe", [False, True])
def test_local_hermes_steer_takes_priority(tmp_path, starts_during_probe):
    async def run():
        adapter = AsyncMock(spec=HermesWsAdapter)
        adapter.steer.return_value = True
        config = NodeConfig("http://127.0.0.1:8000", "sn_live_test", (tmp_path,),
                            direct=DirectTransferConfig(enabled=False))
        daemon = AgentNodeDaemon(config, adapters={"hermes": adapter}, staging_dir=tmp_path)
        ws = AsyncMock()

        async def probe(*, session_id):
            daemon._active_runs.add(("hermes", session_id))
            return True

        if starts_during_probe:
            adapter.session_running.side_effect = probe
        else:
            daemon._active_runs.add(("hermes", "saved"))
        await daemon.handle_command(ws, {"type": "prompt.steer", "provider": "hermes",
                                         "sessionId": "saved", "text": "shorten"})
        assert json.loads(ws.send.await_args.args[0])["type"] == "SteerAccepted"
        adapter.steer.assert_awaited_once_with(session_id="saved", text="shorten")
        adapter.steer_external.assert_not_awaited()
        if starts_during_probe:
            adapter.session_running.assert_awaited_once_with(session_id="saved")
        else:
            adapter.session_running.assert_not_awaited()

    asyncio.run(run())


def test_external_steer_reprobes_running_cache_without_runtime_id(tmp_path, wire_adapter):
    async def run():
        calls = []

        def dispatch(socket, msg):
            method = msg["method"]
            if method == "session.resume":
                calls.append(method)
                if len(calls) == 1:
                    return {"result": {"running": True}}
                return {"result": {"session_id": "runtime", "running": True, "info": {"cwd": str(tmp_path)}}}
            if method == "session.steer":
                calls.append(method)
                assert msg["params"] == {"session_id": "runtime", "text": "shorten"}
                return {"result": {"status": "queued"}}
            return {"result": {}}

        adapter, _ = wire_adapter(dispatch, canonical=False)
        try:
            assert await adapter.session_running(session_id="saved") is True
            assert await adapter.steer_external(session_id="saved", text="shorten") is True
            assert calls == ["session.resume", "session.resume", "session.steer"]
        finally:
            await adapter.close()

    asyncio.run(run())


def test_external_steer_checks_the_session_working_directory(tmp_path, wire_adapter):
    async def run():
        calls = []

        def dispatch(socket, msg):
            method = msg["method"]
            calls.append(method)
            if method == "session.resume":
                info = {"cwd": str(tmp_path.parent)} if msg["params"]["session_id"] == "outside" else {}
                return {"result": {"session_id": "runtime", "running": True, "info": info}}
            return {"result": {}}

        adapter, _ = wire_adapter(dispatch, canonical=False)
        try:
            assert await adapter.steer_external(session_id="outside", text="shorten") is False
            assert await adapter.steer_external(session_id="unknown", text="shorten") is False
            assert calls == ["client.capabilities", "session.resume", "session.resume"]
        finally:
            await adapter.close()

    asyncio.run(run())


def test_subscribe_replays_inactive_when_gateway_does_not_answer_probe(tmp_path, wire_adapter):
    async def run():
        calls = []

        def dispatch(socket, msg):
            method = msg["method"]
            calls.append(method)
            return None if method == "session.resume" else {"result": {}}

        adapter, _ = wire_adapter(dispatch, canonical=False)
        config = NodeConfig("http://127.0.0.1:8000", "sn_live_test", (tmp_path,),
                            direct=DirectTransferConfig(enabled=False))
        daemon = AgentNodeDaemon(config, adapters={"hermes": adapter}, staging_dir=tmp_path)
        ws = AsyncMock()
        try:
            await asyncio.wait_for(daemon.handle_command(ws, {"type": "session.subscribe", "provider": "hermes",
                                                              "sessionId": "saved"}), timeout=4)
            ws.send.assert_awaited_once()
            replay = json.loads(ws.send.await_args.args[0])
            assert replay["type"] == "SessionStreamReplay"
            assert replay["active"] is False
            assert replay["runId"] is None
            assert calls == ["client.capabilities", "session.resume"]
        finally:
            await adapter.close()

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
