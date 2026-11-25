"""P10 tests: snapshot/history turn-boundary windowing, session.older paging, and resume cache/dedup/timeout."""

import asyncio
import json
import time
from unittest.mock import AsyncMock

import httpx
import pytest

from agent_node.adapters import hermes_ws
from agent_node.adapters.hermes_ws import (
    HermesWsAdapter,
    ResumeTimeoutError,
    _SESSION_RESUME_TIMEOUT,
    _SESSION_RESUME_TTL,
    _Session,
)
from agent_node.adapters.mock import MockAdapter
from agent_node.config import DirectTransferConfig, NodeConfig
from agent_node.daemon import AgentNodeDaemon
from agent_node.session_events import (
    DEFAULT_WINDOW_MESSAGES,
    DEFAULT_WINDOW_TURNS,
    SessionEvent,
    Snapshot,
    fold,
    window_snapshot,
)
from test_hermes_ws import wire_adapter  # noqa: F401


@pytest.fixture
def make_node(tmp_path, monkeypatch):
    monkeypatch.setenv("STUDIOLO_SESSION_EVENTS", "1")
    monkeypatch.setattr("agent_node.session_events.Path.home", lambda: tmp_path)

    def make(**adapters):
        config = NodeConfig(
            "http://127.0.0.1:48197",
            "local-test",
            (tmp_path,),
            direct=DirectTransferConfig(enabled=False),
        )
        return AgentNodeDaemon(config, adapters=adapters, staging_dir=tmp_path)

    return make


async def replay_rpc(node, method, **params):
    ws = AsyncMock()
    await node.handle_command(ws, {"type": method, "_rpcId": "p10-rpc", **params})
    ws.send.assert_awaited_once()
    frame = json.loads(ws.send.await_args.args[0])
    assert frame["type"] == "SessionReplayResult"
    assert frame["_rpcId"] == "p10-rpc"
    return frame["result"]


def _append_turns(store, session_id: str, epoch: str, *, turns: int, msgs_per_turn: int = 2, provider: str = "codex"):
    """Append synthetic multi-turn events where each turn produces `msgs_per_turn` messages."""
    seq = store.max_seq(session_id, epoch)
    for t in range(1, turns + 1):
        turn_id = f"turn-{t:03d}"
        seq += 1
        store.append(SessionEvent(
            sessionId=session_id, epoch=epoch, seq=seq, turnId=turn_id,
            participantId=provider, type="turn.started", at=1000 + seq,
            payload={"startedAt": 1000 + t * 10},
        ))
        # (msgs_per_turn - 1) user messages + 1 assistant message = msgs_per_turn messages in this turn
        for u in range(msgs_per_turn - 1):
            seq += 1
            store.append(SessionEvent(
                sessionId=session_id, epoch=epoch, seq=seq, turnId=turn_id,
                participantId=provider, type="message.user", at=1000 + seq,
                payload={"text": f"t{t}-u{u}"},
            ))
        seq += 1
        store.append(SessionEvent(
            sessionId=session_id, epoch=epoch, seq=seq, turnId=turn_id,
            participantId=provider, type="message.assistant.completed", at=1000 + seq,
            payload={"text": f"t{t}-assistant"},
        ))
        seq += 1
        store.append(SessionEvent(
            sessionId=session_id, epoch=epoch, seq=seq, turnId=turn_id,
            participantId=provider, type="turn.ended", at=1000 + seq,
            payload={"endedAt": 1000 + t * 10 + 5, "status": "completed"},
        ))
    return seq


def test_snapshot_300_messages_returns_default_window_and_leaves_events_since_intact(make_node):
    async def run():
        node = make_node()
        log = node._session_event_log
        sid = "sess-300"
        with log.store as store:
            last_seq = _append_turns(store, sid, log.epoch, turns=150, msgs_per_turn=2)
            full_snapshot = store.snapshot(sid, log.epoch)
            assert len(full_snapshot.messages) == 300

            res = await replay_rpc(node, "session.snapshot", sessionId=sid)
            msgs = res["snapshot"]["messages"]
            turns = res["snapshot"]["turns"]
            assert len(msgs) <= DEFAULT_WINDOW_MESSAGES
            assert len(turns) == DEFAULT_WINDOW_TURNS == 40
            assert len(msgs) == 80
            assert res["hasMoreBefore"] is True
            assert res["beforeCursor"] == "turn:turn-111"
            assert res["lastSeq"] == last_seq
            assert msgs[0]["turnId"] == "turn-111" and msgs[0]["role"] == "user"
            assert msgs[-1]["turnId"] == "turn-150" and msgs[-1]["role"] == "assistant"

            # Underlying store & session.events.since are untouched (no data deletion)
            since = await replay_rpc(node, "session.events.since", sessionId=sid, epoch=log.epoch, lastSeq=0, limit=1000)
            assert len(since["events"]) == last_seq
            assert len(store.snapshot(sid, log.epoch).messages) == 300

    asyncio.run(run())


def test_window_clips_strictly_at_turn_boundary():
    async def run():
        # 50 turns * 7 messages/turn = 350 messages.
        # 120 is not divisible by 7 -> 17 complete turns = 119 messages, never splitting turn 33 in half.
        messages = []
        turns = []
        for t in range(1, 51):
            tid = f"turn-{t:02d}"
            turns.append({"turnId": tid, "participantId": "codex", "startedAt": t, "endedAt": t + 1, "usage": {}})
            for k in range(6):
                messages.append({"turnId": tid, "participantId": "codex", "role": "user", "text": f"{tid}-u{k}"})
            messages.append({"turnId": tid, "participantId": "codex", "role": "assistant", "text": f"{tid}-a"})
        full = Snapshot(messages=messages, turns=turns, lastSeq=350)

        windowed, has_more, cursor = window_snapshot(full)
        assert has_more is True
        assert cursor == "turn:turn-34"
        assert len(windowed.messages) == 119 <= DEFAULT_WINDOW_MESSAGES
        assert len(windowed.turns) == 17
        # First and last turns in the window must both be completely intact (7 messages each)
        first_tid = windowed.messages[0]["turnId"]
        last_tid = windowed.messages[-1]["turnId"]
        assert first_tid == "turn-34"
        assert last_tid == "turn-50"
        assert sum(1 for m in windowed.messages if m["turnId"] == first_tid) == 7
        assert sum(1 for m in windowed.messages if m["turnId"] == last_tid) == 7

    asyncio.run(run())


def test_session_older_pages_all_the_way_to_start_with_no_gaps_or_duplicates(make_node):
    async def run():
        node = make_node()
        log = node._session_event_log
        sid = "sess-older"
        with log.store as store:
            _append_turns(store, sid, log.epoch, turns=150, msgs_per_turn=2)
            expected_all = store.snapshot(sid, log.epoch).messages
            assert len(expected_all) == 300

            first = await replay_rpc(node, "session.snapshot", sessionId=sid)
            assert first["hasMoreBefore"] is True
            pages = [first["snapshot"]["messages"]]
            cursor = first["beforeCursor"]

            # Page with snake_case params {session_id, before_cursor, limit} as specified in P10
            page_count = 0
            while cursor is not None:
                page_count += 1
                older = await replay_rpc(
                    node, "session.older", session_id=sid, before_cursor=cursor, limit=60,
                )
                assert older.keys() == first.keys()
                page_msgs = older["snapshot"]["messages"]
                assert 0 < len(page_msgs) <= 60
                # Every turn in the page must be complete (2 messages per turn)
                turn_ids = [m["turnId"] for m in page_msgs]
                for tid in set(turn_ids):
                    assert turn_ids.count(tid) == 2
                pages.append(page_msgs)
                if older["hasMoreBefore"]:
                    assert older["beforeCursor"] is not None and older["beforeCursor"] != cursor
                    cursor = older["beforeCursor"]
                else:
                    assert older["beforeCursor"] is None
                    cursor = None

            assert page_count >= 4
            reconstructed = [m for page in reversed(pages) for m in page]
            assert reconstructed == expected_all

            # Invalid cursor returns explicit error code rather than silent empty data
            bad = await replay_rpc(node, "session.older", session_id=sid, before_cursor="turn:does-not-exist")
            assert bad["code"] == "invalid_cursor"

    asyncio.run(run())


def test_session_older_works_on_hermes_gateway_and_keeps_transcript_intact(
    make_node, tmp_path, wire_adapter, monkeypatch,
):
    rows = []
    for t in range(1, 151):
        rows.append({"row_id": t * 2 - 1, "role": "user", "content": f"prompt-{t}"})
        rows.append({"row_id": t * 2, "role": "assistant", "content": f"answer-{t}"})

    client_cls = httpx.AsyncClient

    def mock_http(request):
        offset = int(request.url.params.get("offset", "0"))
        limit = int(request.url.params.get("limit", "500"))
        return httpx.Response(200, json={"messages": rows[offset:offset + limit],
                                         "pagination": {"offset": offset, "limit": limit}})

    monkeypatch.setattr(
        "agent_node.adapters.hermes_ws.httpx.AsyncClient",
        lambda **opts: client_cls(transport=httpx.MockTransport(mock_http), **opts),
    )

    def dispatch(_, request):
        method = request["method"]
        if method == "session.resume":
            return {"result": {"session_id": "rt-300", "stored_session_id": "st-300",
                               "replay_epoch": "ep-300", "info": {"cwd": str(tmp_path)}}}
        if method == "session.events.since":
            return {"result": {"events": [], "last_sequence": 0, "replay_epoch": "ep-300"}}
        return {"result": {}}

    async def run():
        adapter, _ = wire_adapter(dispatch, canonical=True)
        node = make_node(hermes=adapter)
        try:
            snap = await replay_rpc(node, "session.snapshot", sessionId="st-300", provider="hermes")
            assert snap["source"] == "gateway"
            assert len(snap["snapshot"]["messages"]) == 80
            assert snap["hasMoreBefore"] is True
            assert snap["beforeCursor"] == "turn:t111"

            older = await replay_rpc(
                node, "session.older", session_id="st-300", provider="hermes",
                before_cursor=snap["beforeCursor"], limit=120,
            )
            assert older["source"] == "gateway"
            assert len(older["snapshot"]["messages"]) == 80
            assert older["snapshot"]["messages"][0]["turnId"] == "t71"
            assert older["snapshot"]["messages"][-1]["turnId"] == "t110"
            assert older["hasMoreBefore"] is True
            assert older["beforeCursor"] == "turn:t71"
            # Transcript source untouched
            assert len(rows) == 300
        finally:
            await adapter.close()

    asyncio.run(run())


def test_running_turn_is_always_included_even_when_exceeding_window_limit(make_node):
    async def run():
        node = make_node()
        log = node._session_event_log
        sid = "sess-long-running"
        with log.store as store:
            seq = _append_turns(store, sid, log.epoch, turns=10, msgs_per_turn=2)
            # Add a running turn with 150 messages (> 120 default window limit)
            live_tid = "turn-live-huge"
            seq += 1
            store.append(SessionEvent(
                sessionId=sid, epoch=log.epoch, seq=seq, turnId=live_tid,
                participantId="codex", type="turn.started", at=2000 + seq,
                payload={"startedAt": 2000},
            ))
            seq += 1
            store.append(SessionEvent(
                sessionId=sid, epoch=log.epoch, seq=seq, turnId=None,
                participantId="codex", type="session.running", at=2000 + seq,
                payload={"running": True, "runId": live_tid},
            ))
            for i in range(149):
                seq += 1
                store.append(SessionEvent(
                    sessionId=sid, epoch=log.epoch, seq=seq, turnId=live_tid,
                    participantId="codex", type="message.user", at=2000 + seq,
                    payload={"text": f"live-msg-{i}"},
                ))
            seq += 1
            store.append(SessionEvent(
                sessionId=sid, epoch=log.epoch, seq=seq, turnId=live_tid,
                participantId="codex", type="message.assistant.delta", at=2000 + seq,
                payload={"text": "still streaming..."},
            ))

            snap = await replay_rpc(node, "session.snapshot", sessionId=sid)
            msgs = snap["snapshot"]["messages"]
            assert snap["snapshot"]["running"] is True
            assert snap["snapshot"]["runId"] == live_tid
            assert len(msgs) == 150
            assert all(m["turnId"] == live_tid for m in msgs)
            assert snap["hasMoreBefore"] is True
            assert snap["beforeCursor"] == f"turn:{live_tid}"

            # Earlier 10 turns (20 messages) are still reachable via session.older
            older = await replay_rpc(node, "session.older", session_id=sid, before_cursor=snap["beforeCursor"])
            assert len(older["snapshot"]["messages"]) == 20
            assert older["hasMoreBefore"] is False
            assert older["beforeCursor"] is None

    asyncio.run(run())


def test_session_history_default_window_turn_boundary_and_running_turn(tmp_path):
    async def run():
        adapter = MockAdapter((tmp_path,))
        config = NodeConfig("http://127.0.0.1:48197", "local-test", (tmp_path,),
                            direct=DirectTransferConfig(enabled=False))
        daemon = AgentNodeDaemon(config, adapters={"mock": adapter}, staging_dir=tmp_path)
        sid = "hist-300"
        adapter._sessions[sid] = {"sessionId": sid, "cwd": str(tmp_path)}
        # 150 turns * 2 messages = 300 messages
        adapter._histories[sid] = [
            {"id": f"m-{t}-{role}", "role": role, "text": f"msg-{t}-{role}", "runId": f"run-{t:03d}"}
            for t in range(1, 151)
            for role in ("user", "assistant")
        ]

        ws = AsyncMock()
        await daemon.handle_command(ws, {"type": "session.history", "provider": "mock", "sessionId": sid})
        frame = json.loads(ws.send.await_args.args[0])
        assert frame["type"] == "SessionHistory"
        assert len(frame["messages"]) == 80
        assert frame["hasMoreBefore"] is True
        assert frame["beforeCursor"] == "id:m-111-user"
        assert frame["messages"][0]["runId"] == "run-111"
        assert frame["messages"][-1]["runId"] == "run-150"

        # Older page via session.history beforeCursor
        ws.send.reset_mock()
        await daemon.handle_command(ws, {
            "type": "session.history", "provider": "mock", "sessionId": sid,
            "beforeCursor": frame["beforeCursor"], "limit": 60,
        })
        older = json.loads(ws.send.await_args.args[0])
        assert len(older["messages"]) == 60
        assert older["messages"][0]["runId"] == "run-081"
        assert older["messages"][-1]["runId"] == "run-110"
        assert older["hasMoreBefore"] is True
        assert older["beforeCursor"] == "id:m-81-user"

        # Running turn > 120 messages is always included in full
        live_run = "run-live"
        for i in range(130):
            adapter._histories[sid].append({"id": f"live-{i}", "role": "user", "text": f"live-{i}", "runId": live_run})
        daemon._active_runs.add(("mock", sid))
        from agent_node.daemon import SessionStream
        daemon._session_streams[("mock", sid)] = SessionStream(run_id=live_run)
        ws.send.reset_mock()
        await daemon.handle_command(ws, {"type": "session.history", "provider": "mock", "sessionId": sid})
        live_frame = json.loads(ws.send.await_args.args[0])
        assert len(live_frame["messages"]) == 130
        assert all(m["runId"] == live_run for m in live_frame["messages"])
        assert live_frame["hasMoreBefore"] is True
        assert live_frame["beforeCursor"] == "id:live-0"

    asyncio.run(run())


def test_resume_cache_skips_repeat_within_5_minutes_and_expires_after(tmp_path, monkeypatch):
    async def run():
        assert _SESSION_RESUME_TTL == 300.0
        now = 1000.0
        monkeypatch.setattr(hermes_ws, "monotonic", lambda: now)

        adapter = HermesWsAdapter((tmp_path,))
        calls = []

        class FakeConnection:
            async def call(self, method, params=None, *, timeout=15):
                calls.append((method, params, timeout))
                return {"session_id": "rt-1", "stored_session_id": "s-1", "info": {"cwd": str(tmp_path)}}

        conn = FakeConnection()
        session = _Session("s-1")

        # 1st call -> real resume
        r1 = await adapter._resume(conn, "s-1", session)
        assert r1["session_id"] == "rt-1"
        assert len(calls) == 1
        assert calls[0][0] == "session.resume"
        assert calls[0][2] == 5.0

        # 2nd call within 5 minutes -> cache hit (no real resume)
        now += 299.0
        r2 = await adapter._resume(conn, "s-1", _Session("s-1"))
        assert r2["session_id"] == "rt-1"
        assert len(calls) == 1

        # After 5 minutes (300s) -> cache expired, performs real resume again
        now += 2.0
        r3 = await adapter._resume(conn, "s-1", _Session("s-1"))
        assert r3["session_id"] == "rt-1"
        assert len(calls) == 2

        # New connection (reconnect) bypasses previous connection's cache
        conn2 = FakeConnection()
        r4 = await adapter._resume(conn2, "s-1", _Session("s-1"))
        assert r4["session_id"] == "rt-1"
        assert len(calls) == 3

        await adapter.close()

    asyncio.run(run())


def test_resume_timeout_5s_returns_explicit_error_code(make_node, tmp_path, monkeypatch):
    async def run():
        assert _SESSION_RESUME_TIMEOUT == 5.0
        # Use a short timeout in unit test while verifying the real default above is 5.0s
        monkeypatch.setattr(hermes_ws, "_SESSION_RESUME_TIMEOUT", 0.08)

        adapter = HermesWsAdapter((tmp_path,))
        adapter._epoch = "gateway-epoch"
        seen_timeouts = []

        class StallingConnection:
            async def call(self, method, params=None, *, timeout=15):
                seen_timeouts.append((method, timeout))
                await asyncio.sleep(30)
                return {}

        conn = StallingConnection()
        monkeypatch.setattr(adapter, "_online", AsyncMock(return_value=conn))
        node = make_node(hermes=adapter)

        started = time.monotonic()
        with pytest.raises(ResumeTimeoutError) as exc_info:
            await adapter._resume(conn, "stuck", _Session("stuck"))
        elapsed = time.monotonic() - started
        assert exc_info.value.code == "session_resume_timeout"
        assert elapsed < 1.0
        assert seen_timeouts[-1] == ("session.resume", 0.08)

        # session.snapshot returns explicit error code (not silent empty data)
        snap_res = await replay_rpc(node, "session.snapshot", sessionId="stuck", provider="hermes")
        assert snap_res["code"] == "session_resume_timeout"
        assert snap_res["source"] == "gateway"
        assert "snapshot" not in snap_res

        # session.history returns Failed frame with explicit error code
        ws = AsyncMock()
        await node.handle_command(ws, {"type": "session.history", "provider": "hermes", "sessionId": "stuck"})
        hist_err = json.loads(ws.send.await_args.args[0])
        assert hist_err["type"] == "Failed"
        assert hist_err["code"] == "session_resume_timeout"

        # session.processes returns explicit error code
        proc_res = await replay_rpc(node, "session.processes", session_id="stuck", provider="hermes")
        assert proc_res["ok"] is False
        assert proc_res["code"] == "session_resume_timeout"

        await adapter.close()

    asyncio.run(run())


def test_resume_concurrent_dedup_five_requests_resume_once(tmp_path):
    async def run():
        adapter = HermesWsAdapter((tmp_path,))
        gate = asyncio.Event()
        calls = 0

        class SlowConnection:
            async def call(self, method, params=None, *, timeout=15):
                nonlocal calls
                assert method == "session.resume"
                calls += 1
                await gate.wait()
                return {"session_id": "rt-dedup", "stored_session_id": "s-dedup", "info": {"cwd": str(tmp_path)}}

        conn = SlowConnection()
        session = _Session("s-dedup")

        tasks = [asyncio.create_task(adapter._resume(conn, "s-dedup", session)) for _ in range(5)]
        await asyncio.sleep(0.02)
        assert calls == 1
        # Cancelling one waiter must not cancel the shared in-flight resume for the remaining 4
        tasks[0].cancel()
        with pytest.raises(asyncio.CancelledError):
            await tasks[0]
        gate.set()
        results = await asyncio.gather(*tasks[1:])
        assert calls == 1
        assert all(r["session_id"] == "rt-dedup" for r in results)

        await adapter.close()

    asyncio.run(run())


def test_session_older_disabled_returns_unsupported(make_node, monkeypatch):
    monkeypatch.setenv("STUDIOLO_SESSION_EVENTS", "0")

    async def run():
        node = make_node()
        res = await replay_rpc(node, "session.older", session_id="s1", before_cursor="turn:t1")
        assert res == {"code": "unsupported", "source": "node"}

    asyncio.run(run())
