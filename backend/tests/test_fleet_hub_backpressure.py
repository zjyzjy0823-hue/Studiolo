"""Core 客户端出站隔离、超时、显式断开与定向路由回归。"""

import asyncio
import logging
from unittest.mock import AsyncMock, Mock

import pytest

from app.fleet import audit as audit_module
from app.fleet import hub as hub_module
from app.fleet.hub import CLIENT_OUTBOUND_QUEUE_SIZE, CLIENT_SEND_TIMEOUT, FleetRelayHub


class FakeWebSocket:
    def __init__(self, *, block_type=None, fail_type=None, fail_close=False, block_close=False):
        self.block_type = block_type
        self.fail_type = fail_type
        self.fail_close = fail_close
        self.block_close = block_close
        self.sent = []
        self.messages = asyncio.Queue()
        self.send_started = asyncio.Event()
        self.send_cancelled = asyncio.Event()
        self.closed = asyncio.Event()
        self.close_codes = []
        self.active_sends = 0
        self.max_active_sends = 0

    async def send_json(self, frame):
        self.active_sends += 1
        self.max_active_sends = max(self.max_active_sends, self.active_sends)
        try:
            if frame["type"] == self.block_type:
                self.send_started.set()
                try:
                    await asyncio.Event().wait()  # 永不自行返回，但遵守 asyncio 取消。
                except asyncio.CancelledError:
                    self.send_cancelled.set()
                    raise
            if frame["type"] == self.fail_type:
                raise RuntimeError("SENTINEL_PRIVATE_CONTENT")
            self.sent.append(frame.copy())
            self.messages.put_nowait(frame.copy())
        finally:
            self.active_sends -= 1

    async def close(self, *, code):
        self.close_codes.append(code)
        self.closed.set()
        if self.fail_close:
            raise RuntimeError("SENTINEL_PRIVATE_CONTENT")
        if self.block_close:
            await asyncio.Event().wait()


async def receive(ws):
    return await asyncio.wait_for(ws.messages.get(), timeout=1)


async def register(hub, ws, workspace="workspace"):
    client_id = await asyncio.wait_for(hub.register_client(workspace, ws), timeout=1)
    snapshot = await receive(ws)
    assert snapshot == {"type": "FleetSnapshot", "nodes": [], "capabilities": ["active-runs"]}
    return client_id


async def cleanup(hub):
    for workspace, clients in list(hub._clients.items()):
        for client_id in list(clients):
            await hub.unregister_client(workspace, client_id)


def warnings_for(caplog, client_id):
    return [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING and client_id in r.getMessage()]


def test_hung_client_does_not_block_other_clients_and_times_out(caplog):
    async def run():
        # 使用真实的生产 10 秒超时，不替换计时器或缩短超时。
        assert CLIENT_SEND_TIMEOUT == 10.0
        hub = FleetRelayHub()
        slow = FakeWebSocket(block_type="TextDelta")
        healthy = FakeWebSocket()
        try:
            slow_id = await register(hub, slow)
            healthy_id = await register(hub, healthy)
            slow_client = hub._clients["workspace"][slow_id]
            frame = {"type": "TextDelta", "sessionId": "s1", "text": "hello", "seq": 1}
            await asyncio.wait_for(hub.broadcast_node_event("workspace", frame), timeout=1)
            await asyncio.wait_for(slow.send_started.wait(), timeout=1)
            assert await receive(healthy) == frame
            assert slow_id in hub._clients["workspace"]
            assert not slow.closed.is_set()

            frame2 = {**frame, "text": "world", "seq": 2}
            await asyncio.wait_for(hub.broadcast_node_event("workspace", frame2), timeout=1)
            assert await receive(healthy) == frame2
            # 1 个发送中 + 1 个队列中的帧都需要计入丢弃数。
            await asyncio.wait_for(slow.closed.wait(), timeout=CLIENT_SEND_TIMEOUT + 2)
            await asyncio.wait_for(slow_client.disconnect_task, timeout=1)
            assert slow.close_codes == [1011]
            assert slow.send_cancelled.is_set()
            assert slow_id not in hub._clients["workspace"]
            assert healthy_id in hub._clients["workspace"]
            assert slow_client.writer_task.done()
            assert slow_client.outbound.empty()
            await asyncio.wait_for(slow_client.outbound.join(), timeout=1)
            assert any("reason=send_timeout dropped_frames=2" in msg for msg in warnings_for(caplog, slow_id))
        finally:
            await cleanup(hub)

    asyncio.run(run())


@pytest.mark.parametrize("target_workspace", ["workspace", "empty-workspace"])
def test_missing_target_never_falls_back_to_broadcast(caplog, monkeypatch, target_workspace):
    audit = Mock()
    monkeypatch.setattr(hub_module, "audit_event", audit)

    async def run():
        hub = FleetRelayHub()
        sockets = [FakeWebSocket(), FakeWebSocket()]
        try:
            for ws in sockets:
                await register(hub, ws)
            await hub.broadcast_node_event(
                target_workspace, {"type": "SessionHistory", "messages": []}, target_client_id="missing-client",
            )
            # 哨兵排在错误广播之后，实际消费到哨兵才能证明之前没有泄漏帧。
            sentinel = {"type": "Pong", "requestId": "barrier"}
            await hub.broadcast_workspace("workspace", sentinel)
            for ws in sockets:
                assert await receive(ws) == sentinel
                assert [f["type"] for f in ws.sent] == ["FleetSnapshot", "Pong"]
            audit.assert_called_once_with(
                "core", session_id=None, run_id=None, stream_id=None, seq=None,
                event_type="SessionHistory", call_id=None, queued=0,
            )
            assert any("reason=target_missing dropped_frames=1" in msg for msg in warnings_for(caplog, "missing-client"))
        finally:
            await cleanup(hub)

    asyncio.run(run())


def test_full_queue_disconnects_only_slow_client_without_blocking(caplog):
    async def run():
        hub = FleetRelayHub()
        slow = FakeWebSocket(block_type="TextDelta")
        healthy = FakeWebSocket()
        try:
            slow_id = await register(hub, slow)
            healthy_id = await register(hub, healthy)
            slow_client = hub._clients["workspace"][slow_id]
            assert slow_client.outbound.maxsize == CLIENT_OUTBOUND_QUEUE_SIZE == 256
            first = {"type": "TextDelta", "seq": 0}
            await hub.broadcast_node_event("workspace", first)
            await asyncio.wait_for(slow.send_started.wait(), timeout=1)
            assert await receive(healthy) == first
            for seq in range(1, 257):
                frame = {"type": "TextDelta", "seq": seq}
                await asyncio.wait_for(hub.broadcast_node_event("workspace", frame), timeout=1)
                assert await receive(healthy) == frame
            assert slow_client.outbound.qsize() == 256
            assert slow.close_codes == []

            overflow = {"type": "TextDelta", "seq": 257}
            await asyncio.wait_for(hub.broadcast_node_event("workspace", overflow), timeout=1)
            assert await receive(healthy) == overflow
            await asyncio.wait_for(slow_client.disconnect_task, timeout=1)
            assert slow.close_codes == [1011]
            assert slow.send_cancelled.is_set()
            assert slow_id not in hub._clients["workspace"]
            assert healthy_id in hub._clients["workspace"]
            assert slow_client.writer_task.done()
            assert slow_client.outbound.empty()
            await asyncio.wait_for(slow_client.outbound.join(), timeout=1)
            assert any("reason=queue_full dropped_frames=258" in msg for msg in warnings_for(caplog, slow_id))
            after = {"type": "Completed"}
            await hub.broadcast_node_event("workspace", after)
            assert await receive(healthy) == after
        finally:
            await cleanup(hub)

    asyncio.run(run())


@pytest.mark.parametrize("fail_close", [False, True])
def test_send_exception_closes_and_unregisters_with_warning(caplog, monkeypatch, fail_close):
    audit = Mock()
    monkeypatch.setattr(hub_module, "audit_event", audit)

    async def run():
        hub = FleetRelayHub()
        ws = FakeWebSocket(fail_type="TextDelta", fail_close=fail_close)
        try:
            client_id = await register(hub, ws)
            client = hub._clients["workspace"][client_id]
            await hub.broadcast_node_event("workspace", {"type": "TextDelta"})
            await asyncio.wait_for(ws.closed.wait(), timeout=1)
            await asyncio.wait_for(client.disconnect_task, timeout=1)
            assert ws.close_codes == [1011]
            assert "workspace" not in hub._clients
            assert client.writer_task.done()
            assert any("reason=send_error:RuntimeError dropped_frames=1" in msg for msg in warnings_for(caplog, client_id))
            if fail_close:
                assert any("Fleet client close failed" in msg for msg in warnings_for(caplog, client_id))
            assert "SENTINEL_PRIVATE_CONTENT" not in caplog.text
        finally:
            await cleanup(hub)

    asyncio.run(run())


def test_registration_is_nonblocking_and_snapshot_is_first():
    async def run():
        hub = FleetRelayHub()
        ws = FakeWebSocket(block_type="FleetSnapshot")
        try:
            client_id = await asyncio.wait_for(hub.register_client("workspace", ws), timeout=1)
            client = hub._clients["workspace"][client_id]
            await asyncio.wait_for(ws.send_started.wait(), timeout=1)
            frame = {"type": "TextDelta"}
            assert await hub.broadcast_workspace("workspace", frame) == 1
            assert client.outbound.qsize() == 1
            assert ws.sent == []
            await hub.unregister_client("workspace", client_id)
            assert ws.send_cancelled.is_set()
            assert client.writer_task.done()
            assert client.outbound.empty()
            assert hub._clients == {}
            # 正常断开后的重复注销也安全。
            await hub.unregister_client("workspace", client_id)
        finally:
            await cleanup(hub)

    asyncio.run(run())


def test_overflow_before_writer_starts_still_closes(caplog):
    async def run():
        hub = FleetRelayHub()
        ws = FakeWebSocket()
        try:
            # register_client / broadcast_workspace 在锁未被占用时不会让出事件循环。
            client_id = await hub.register_client("workspace", ws)
            client = hub._clients["workspace"][client_id]
            for seq in range(256):
                await hub.broadcast_workspace("workspace", {"type": "TextDelta", "seq": seq})
            assert client.closing
            assert client.disconnect_task is not None
            await asyncio.wait_for(client.disconnect_task, timeout=1)
            assert ws.sent == []
            assert ws.close_codes == [1011]
            assert hub._clients == {}
            assert client.writer_task.done()
            assert client.outbound.empty()
            await asyncio.wait_for(client.outbound.join(), timeout=1)
            assert any("reason=queue_full dropped_frames=257" in msg for msg in warnings_for(caplog, client_id))
        finally:
            await cleanup(hub)

    asyncio.run(run())


def test_peer_disconnect_logs_pending_frames_and_stops_writer(caplog):
    async def run():
        hub = FleetRelayHub()
        ws = FakeWebSocket(block_type="TextDelta")
        try:
            client_id = await register(hub, ws)
            client = hub._clients["workspace"][client_id]
            await hub.broadcast_node_event("workspace", {"type": "TextDelta", "seq": 1})
            await asyncio.wait_for(ws.send_started.wait(), timeout=1)
            await hub.broadcast_node_event("workspace", {"type": "TextDelta", "seq": 2})
            await hub.unregister_client("workspace", client_id)
            assert hub._clients == {}
            assert ws.send_cancelled.is_set()
            assert client.writer_task.done()
            assert client.outbound.empty()
            await asyncio.wait_for(client.outbound.join(), timeout=1)
            assert any("reason=client_disconnected dropped_frames=2" in msg
                       for msg in warnings_for(caplog, client_id))
        finally:
            await cleanup(hub)

    asyncio.run(run())


def test_audit_records_enqueue_results_for_every_frame(monkeypatch):
    audit = Mock()
    monkeypatch.setattr(hub_module, "audit_event", audit)

    async def run():
        hub = FleetRelayHub()
        ws = FakeWebSocket(block_type="TextDelta")
        frame = {"type": "TextDelta", "sessionId": "s1", "seq": 7}
        expected = dict(
            session_id="s1", run_id=None, stream_id=None, seq=7, event_type="TextDelta", call_id=None,
        )
        try:
            # 没有客户端时仍保留 Core 收帧证据。
            await hub.broadcast_node_event("workspace", frame)
            audit.assert_called_once_with("core", **expected, queued=0)
            audit.reset_mock()

            client_id = await register(hub, ws)
            client = hub._clients["workspace"][client_id]
            await hub.broadcast_node_event("workspace", frame, target_client_id=client_id)
            assert client.outbound.qsize() == 1
            assert ws.sent == [{"type": "FleetSnapshot", "nodes": [], "capabilities": ["active-runs"]}]
            audit.assert_called_once_with("core", **expected, queued=1)
            await asyncio.wait_for(ws.send_started.wait(), timeout=1)
            # 队列溢出的帧也必须审计，并明确记录零客户端入队。
            for seq in range(256):
                await hub.broadcast_workspace("workspace", {"type": "TextDelta", "seq": seq})
            audit.reset_mock()
            await hub.broadcast_node_event("workspace", frame, target_client_id=client_id)
            audit.assert_called_once_with("core", **expected, queued=0)
            await asyncio.wait_for(client.disconnect_task, timeout=1)
        finally:
            await cleanup(hub)

    asyncio.run(run())


@pytest.mark.parametrize("queued_kwargs, suffix", [
    ({}, ""),
    ({"queued": None}, ""),
    ({"queued": 0}, " queued=0"),
    ({"queued": 1}, " queued=1"),
])
def test_audit_log_format_preserves_default_and_appends_enqueue_result(monkeypatch, caplog, queued_kwargs, suffix):
    logger = logging.getLogger("test.fleet.audit")
    monkeypatch.setattr(audit_module, "audit_logger", lambda: logger)
    with caplog.at_level(logging.INFO, logger=logger.name):
        audit_module.audit_event(
            "node", session_id="session-123", run_id="run-123456", stream_id="stream-123",
            seq=7, event_type="TextDelta", call_id="call-12345", **queued_kwargs,
        )
    assert [record.getMessage() for record in caplog.records if record.name == logger.name] == [
        "side=node session=session- run=run-1234 stream=stream-1 seq=7 type=TextDelta call=call-123" + suffix,
    ]


def test_targeting_fifo_and_workspace_isolation():
    async def run():
        hub = FleetRelayHub()
        target, peer, other = FakeWebSocket(), FakeWebSocket(), FakeWebSocket()
        try:
            target_id = await register(hub, target)
            await register(hub, peer)
            await register(hub, other, "other-workspace")
            frames = [{"type": "SessionHistory", "messages": []}, {"type": "Error", "code": "unsupported_command"}]
            for frame in frames:
                assert await hub.broadcast_workspace("workspace", frame, target_client_id=target_id) == 1
            sentinel = {"type": "Pong"}
            await hub.broadcast_workspace("workspace", sentinel)
            await hub.broadcast_workspace("other-workspace", sentinel)
            assert [await receive(target) for _ in range(3)] == [*frames, sentinel]
            assert await receive(peer) == sentinel
            assert await receive(other) == sentinel
            assert target.max_active_sends == peer.max_active_sends == other.max_active_sends == 1
        finally:
            await cleanup(hub)

    asyncio.run(run())


def test_blocked_close_is_bounded_and_does_not_block_healthy_client(caplog, monkeypatch):
    # 单独覆盖 close 的防挂起保护；发送的真实 10 秒超时由上面的用例验证。
    monkeypatch.setattr(hub_module, "CLIENT_SEND_TIMEOUT", 0.05)

    async def run():
        hub = FleetRelayHub()
        slow = FakeWebSocket(fail_type="TextDelta", block_close=True)
        healthy = FakeWebSocket()
        try:
            slow_id = await register(hub, slow)
            await register(hub, healthy)
            slow_client = hub._clients["workspace"][slow_id]
            frame = {"type": "TextDelta", "seq": 1}
            await hub.broadcast_node_event("workspace", frame)
            assert await receive(healthy) == frame
            await asyncio.wait_for(slow.closed.wait(), timeout=1)
            assert slow_id in hub._clients["workspace"]
            frame2 = {"type": "TextDelta", "seq": 2}
            await hub.broadcast_node_event("workspace", frame2)
            assert await receive(healthy) == frame2
            # 与读循环 finally 的注销竞争时，也不能取消或重复执行 close。
            await asyncio.wait_for(hub.unregister_client("workspace", slow_id), timeout=1)
            assert slow_id not in hub._clients["workspace"]
            assert slow.close_codes == [1011]
            assert slow_client.writer_task.done()
            assert slow_client.disconnect_task.done()
            assert any("Fleet client close failed" in msg and "reason=TimeoutError" in msg
                       for msg in warnings_for(caplog, slow_id))
            assert any("reason=client_closing dropped_frames=1" in msg for msg in warnings_for(caplog, slow_id))
        finally:
            await cleanup(hub)

    asyncio.run(run())


def test_client_route_enqueues_immediate_replies(client, users, monkeypatch):
    owner, _ = users
    hub = hub_module.fleet_hub
    enqueue = AsyncMock(wraps=hub.broadcast_workspace)
    monkeypatch.setattr(hub, "broadcast_workspace", enqueue)
    with client.websocket_connect("/ws/fleet/client", headers=owner) as ws:
        assert ws.receive_json()["type"] == "FleetSnapshot"
        ws.send_json({"type": "unknown", "requestId": "invalid"})
        error = ws.receive_json()
        assert error == {"type": "Error", "code": "unsupported_command", "requestId": "invalid",
                         "message": "Unsupported command: unknown"}
        ws.send_json({"type": "node.ping", "requestId": "ping"})
        pong = ws.receive_json()
        assert pong == {"type": "Pong", "requestId": "ping"}
        assert enqueue.await_count == 2
        calls = enqueue.await_args_list
        assert [call.args[1] for call in calls] == [error, pong]
        target_id = calls[0].kwargs["target_client_id"]
        assert target_id in hub._clients[calls[0].args[0]]
        assert calls[1].kwargs == {"target_client_id": target_id}
