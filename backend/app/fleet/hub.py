"""纯内存 Multi-Device Fleet Relay Hub（零聊天正文持久化，只存连接路由与有界幂等键）。"""

import asyncio
from collections import OrderedDict
from contextlib import suppress
from dataclasses import dataclass, field
import logging
from typing import Any
from uuid import uuid4

from fastapi import WebSocket

from .audit import audit_event


MAX_DEDUP_KEYS = 2048
CLIENT_OUTBOUND_QUEUE_SIZE = 256
CLIENT_SEND_TIMEOUT = 10.0
SESSION_EVENTS_V1 = "session.events.v1"
logger = logging.getLogger(__name__)
ALLOWED_CLIENT_COMMANDS = frozenset({
    "sessions.list",
    "models.list",
    "agents.list",
    "mcp.list",
    "rules.list",
    "skills.list",
    "files.list",
    "files.tree",
    "file.read",
    "file.write",
    "file.blame",
    "files.revert",
    "diff.revert_hunk",
    "git.commit",
    "trust.list",
    "trust.add",
    "trust.remove",
    "project.permissions.list",
    "project.permissions.set",
    "terminal.open",
    "terminal.preview",
    "terminal.input",
    "terminal.signal",
    "terminal.resize",
    "terminal.close",
    "session.open",
    "session.history",
    "session.model.set",
    "session.effort.set",
    "session.active.list",
    "session.context.read",
    "session.diff",
    "session.compact",
    "session.rename",
    "session.delete",
    "session.subscribe",
    "checkpoint.revert",
    "worktree.merge",
    "workspace.open_external",
    "form.reply",
    "prompt.send",
    "prompt.cancel",
    "prompt.steer",
    "permission.respond",
    "handoff.send",
    "node.ping",
    "cron.list",
    "cron.create",
    "cron.update",
    "cron.delete",
    "cron.pause",
    "cron.run",
    "cron.runs",
})
ALLOWED_NODE_EVENTS = frozenset({
    "Accepted",
    "ThoughtDelta",
    "TextDelta",
    "ToolCall",
    "ToolCallUpdate",
    "TodoUpdated",
    "PermissionRequest",
    "FormRequest",
    "FormResolved",
    "ArtifactOffered",
    "TokenUsage",
    "ContextUsage",
    "ContextSnapshot",
    "SessionsSnapshot",
    "ModelsSnapshot",
    "AgentsSnapshot",
    "McpSnapshot",
    "RulesSnapshot",
    "SkillsSnapshot",
    "FilesSnapshot",
    "FilesTreeSnapshot",
    "FileContentSnapshot",
    "FileWritten",
    "FileBlameSnapshot",
    "DiffSnapshot",
    "GitCommitted",
    "TrustPolicySnapshot",
    "ProjectPermissionsSnapshot",
    "TerminalOpened",
    "TerminalOutput",
    "TerminalClosed",
    "CheckpointCreated",
    "CheckpointReverted",
    "WorktreeMerged",
    "ExternalOpened",
    "SessionOpened",
    "SessionHistory",
    "SessionStreamReplay",
    "ActiveRunsSnapshot",
    "SessionCompacted",
    "TerminalPreview",
    "RunStopStatus",
    "SteerAccepted",
    "SteerRejected",
    "SessionRenamed",
    "SessionDeleted",
    "DuplicateIgnored",
    "Completed",
    "Failed",
    "NodeHeartbeat",
    "CronRpcResult",
    "SubscriptionQuotaResult",
    "HermesMediaResult",
    "SessionReplayResult",
})


@dataclass
class ConnectedNode:
    node_id: str
    workspace_id: str
    user_id: int
    name: str
    platform: str
    websocket: WebSocket
    adapters: list[dict[str, Any]] = field(default_factory=list)
    allowed_roots: list[str] = field(default_factory=list)
    transfer_endpoints: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class ConnectedClient:
    websocket: WebSocket
    outbound: asyncio.Queue[dict[str, Any]] = field(
        default_factory=lambda: asyncio.Queue(maxsize=CLIENT_OUTBOUND_QUEUE_SIZE),
    )
    writer_task: asyncio.Task[None] | None = None
    disconnect_task: asyncio.Task[None] | None = None
    closing: bool = False
    in_flight: bool = False
    session_events_v1: bool = False

    def skips_frame(self, frame: dict[str, Any]) -> bool:
        return self.session_events_v1 and frame.get("type") == "SessionStreamReplay"


def supports_session_events(capabilities: Any) -> bool:
    return isinstance(capabilities, list) and SESSION_EVENTS_V1 in capabilities


def client_ready() -> dict[str, Any]:
    return {"type": "Ready", "serverCapabilities": [SESSION_EVENTS_V1]}


class FleetRelayHub:
    """维护活跃 AgentNode 与客户端 WebSocket 连接，无磁盘消息落库。"""

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._nodes: dict[tuple[str, str], ConnectedNode] = {}
        self._clients: dict[str, dict[str, ConnectedClient]] = {}
        self._seen_requests: OrderedDict[tuple[str, str, str], bool] = OrderedDict()
        self._forwarding_requests: dict[tuple[str, str, str], asyncio.Future[bool]] = {}
        # Core REST -> AgentNode 同步 RPC 挂起表（纯内存，不落盘）
        self._pending_rpcs: dict[str, tuple[str, str, asyncio.Future[dict[str, Any]]]] = {}

    async def register_node(self, conn: ConnectedNode) -> None:
        async with self._lock:
            self._nodes[(conn.workspace_id, conn.node_id)] = conn
        await self.broadcast_workspace(
            conn.workspace_id,
            {
                "type": "NodePresence",
                "nodeId": conn.node_id,
                "name": conn.name,
                "platform": conn.platform,
                "status": "online",
                "adapters": conn.adapters,
                "allowedRoots": conn.allowed_roots,
                "transferEndpoints": conn.transfer_endpoints,
            },
        )

    async def unregister_node(self, workspace_id: str, node_id: str, websocket: WebSocket | None = None) -> None:
        removed: ConnectedNode | None = None
        stale_futs: list[asyncio.Future[dict[str, Any]]] = []
        async with self._lock:
            current = self._nodes.get((workspace_id, node_id))
            if current is not None and (websocket is None or current.websocket is websocket):
                removed = self._nodes.pop((workspace_id, node_id))
                stale_ids = [
                    rid for rid, (ws_id, n_id, _) in self._pending_rpcs.items()
                    if ws_id == workspace_id and n_id == node_id
                ]
                for rid in stale_ids:
                    stale_futs.append(self._pending_rpcs.pop(rid)[2])
        for fut in stale_futs:
            if not fut.done():
                fut.set_result({"ok": False, "code": "node_disconnected", "error": "Target device node disconnected"})
        if removed is not None:
            await self.broadcast_workspace(
                workspace_id,
                {
                    "type": "NodePresence",
                    "nodeId": node_id,
                    "name": removed.name,
                    "platform": removed.platform,
                    "status": "offline",
                },
            )

    async def kick_node(self, workspace_id: str, node_id: str, reason: str = "revoked") -> None:
        """吊销或删除节点时立即断开活跃 WSS 会话，防止遗留长连接继续收发。"""
        async with self._lock:
            current = self._nodes.get((workspace_id, node_id))
        if current is None:
            return
        try:
            await current.websocket.close(code=4401, reason=reason)
        except Exception:
            pass
        await self.unregister_node(workspace_id, node_id, current.websocket)

    async def register_client(
        self, workspace_id: str, websocket: WebSocket, *, session_events_v1: bool = False,
    ) -> str:
        conn_id = str(uuid4())
        client = ConnectedClient(websocket=websocket, session_events_v1=session_events_v1)
        async with self._lock:
            online_snapshot = [
                {
                    "nodeId": n.node_id,
                    "name": n.name,
                    "platform": n.platform,
                    "status": "online",
                    "adapters": n.adapters,
                    "allowedRoots": n.allowed_roots,
                    "transferEndpoints": n.transfer_endpoints,
                }
                for (ws_id, _), n in self._nodes.items()
                if ws_id == workspace_id
            ]
            # 首帧先入队再公开连接，保证快照先于后续事件，且所有写操作由同一个 writer 串行执行。
            client.outbound.put_nowait({
                "type": "FleetSnapshot", "nodes": online_snapshot, "capabilities": ["active-runs"],
            })
            if session_events_v1:
                client.outbound.put_nowait(client_ready())
            self._clients.setdefault(workspace_id, {})[conn_id] = client
            client.writer_task = asyncio.create_task(self._write_client(workspace_id, conn_id, client))
        return conn_id

    async def unregister_client(self, workspace_id: str, conn_id: str) -> None:
        async with self._lock:
            clients = self._clients.get(workspace_id)
            client = clients.get(conn_id) if clients else None
            if client is None:
                return
            if client.disconnect_task is None:
                client.closing = True
                clients.pop(conn_id, None)
                if not clients:
                    self._clients.pop(workspace_id, None)
        if client.disconnect_task is not None:
            # 读循环可能在 close 后立刻退出；让故障清理完成，避免重复关闭或取消它自己。
            await asyncio.shield(client.disconnect_task)
        else:
            dropped = client.outbound.qsize() + int(client.in_flight)
            if dropped:
                logger.warning(
                    "Fleet client frame dropped client_id=%s reason=client_disconnected dropped_frames=%d",
                    conn_id, dropped,
                )
            await self._stop_client_writer(client)
            self._drain_client_queue(client)

    @staticmethod
    async def _stop_client_writer(client: ConnectedClient) -> None:
        if client.writer_task is not None:
            client.writer_task.cancel()
            with suppress(asyncio.CancelledError):
                await client.writer_task

    @staticmethod
    def _drain_client_queue(client: ConnectedClient) -> None:
        while not client.outbound.empty():
            client.outbound.get_nowait()
            client.outbound.task_done()

    def _fail_client(
        self, workspace_id: str, conn_id: str, client: ConnectedClient, reason: str,
        *, rejected_frames: int = 0,
    ) -> None:
        if client.closing:
            return
        client.closing = True
        logger.warning(
            "Fleet client outbound failure client_id=%s reason=%s dropped_frames=%d",
            conn_id, reason, rejected_frames + client.outbound.qsize() + int(client.in_flight),
        )
        if client.writer_task is not None and client.writer_task is not asyncio.current_task():
            client.writer_task.cancel()
        # 不在生产者中等待取消或 close；即使 writer 尚未启动，独立清理任务也一定会执行。
        client.disconnect_task = asyncio.create_task(self._disconnect_client(workspace_id, conn_id, client))

    async def _disconnect_client(self, workspace_id: str, conn_id: str, client: ConnectedClient) -> None:
        try:
            await self._stop_client_writer(client)
            try:
                # close 本身也可能阻塞，不能让注销与内存释放无限等待。
                async with asyncio.timeout(CLIENT_SEND_TIMEOUT):
                    await client.websocket.close(code=1011)
            except Exception as exc:
                logger.warning(
                    "Fleet client close failed client_id=%s reason=%s dropped_frames=0",
                    conn_id, type(exc).__name__,
                )
        finally:
            async with self._lock:
                clients = self._clients.get(workspace_id)
                if clients and clients.get(conn_id) is client:
                    clients.pop(conn_id)
                    if not clients:
                        self._clients.pop(workspace_id, None)
            self._drain_client_queue(client)

    async def _write_client(self, workspace_id: str, conn_id: str, client: ConnectedClient) -> None:
        while not client.closing:
            frame = await client.outbound.get()
            # A hello can arrive after this frame was queued.
            if client.skips_frame(frame):
                client.outbound.task_done()
                continue
            client.in_flight = True
            try:
                async with asyncio.timeout(CLIENT_SEND_TIMEOUT):
                    await client.websocket.send_json(frame)
            except TimeoutError:
                self._fail_client(workspace_id, conn_id, client, "send_timeout")
                return
            except Exception as exc:
                self._fail_client(workspace_id, conn_id, client, f"send_error:{type(exc).__name__}")
                return
            finally:
                client.in_flight = False
                client.outbound.task_done()

    def _queue_client_frame(
        self, workspace_id: str, conn_id: str, client: ConnectedClient, frame: dict[str, Any],
    ) -> bool:
        if client.closing:
            logger.warning(
                "Fleet client frame dropped client_id=%s reason=client_closing dropped_frames=1", conn_id,
            )
            return False
        try:
            client.outbound.put_nowait(frame)
            return True
        except asyncio.QueueFull:
            self._fail_client(workspace_id, conn_id, client, "queue_full", rejected_frames=1)
            return False

    async def get_online_node(self, workspace_id: str, node_id: str) -> ConnectedNode | None:
        async with self._lock:
            return self._nodes.get((workspace_id, node_id))

    async def call_node_rpc(
        self,
        workspace_id: str,
        node_id: str,
        frame: dict[str, Any],
        *,
        timeout: float = 10.0,
    ) -> dict[str, Any]:
        """向工作区内目标在线 AgentNode 发送一次性控制 RPC 并等待回执。"""
        node = await self.get_online_node(workspace_id, node_id)
        if node is None:
            return {"ok": False, "code": "node_offline", "error": "Target device node is offline"}

        rpc_id = str(uuid4())
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[dict[str, Any]] = loop.create_future()
        async with self._lock:
            self._pending_rpcs[rpc_id] = (workspace_id, node_id, fut)

        outbound = {**frame, "_rpcId": rpc_id}
        try:
            async with asyncio.timeout(timeout):
                try:
                    await node.websocket.send_json(outbound)
                except Exception:
                    await self.unregister_node(workspace_id, node_id, node.websocket)
                    return {"ok": False, "code": "node_disconnected", "error": "Target device node disconnected"}
                return await fut
        except TimeoutError:
            return {"ok": False, "code": "rpc_timeout", "error": "Remote node did not respond in time"}
        finally:
            fut.cancel()
            async with self._lock:
                self._pending_rpcs.pop(rpc_id, None)

    async def resolve_node_rpc(self, workspace_id: str, node_id: str, rpc_id: str, payload: dict[str, Any]) -> bool:
        """收到节点回执时唤醒等待中的 Core REST 调用。"""
        async with self._lock:
            entry = self._pending_rpcs.get(rpc_id)
            if entry is None:
                return False
            ws_id, n_id, fut = entry
            if ws_id != workspace_id or n_id != node_id:
                return False
            self._pending_rpcs.pop(rpc_id, None)
        if not fut.done():
            fut.set_result(payload)
        return True

    async def list_online_endpoints(self, workspace_id: str) -> list[dict[str, Any]]:
        async with self._lock:
            out: list[dict[str, Any]] = []
            for (ws_id, _), conn in self._nodes.items():
                if ws_id == workspace_id:
                    for ep in conn.transfer_endpoints:
                        out.append({"nodeId": conn.node_id, **ep})
            return out

    async def _begin_forward(self, key: tuple[str, str, str]) -> bool:
        while True:
            async with self._lock:
                if key in self._seen_requests:
                    self._seen_requests.move_to_end(key)
                    return False
                pending = self._forwarding_requests.get(key)
                if pending is None:
                    self._forwarding_requests[key] = asyncio.get_running_loop().create_future()
                    return True
            if await asyncio.shield(pending):
                return False

    def _finish_forward(self, key: tuple[str, str, str], delivered: bool) -> None:
        if delivered:
            self._seen_requests[key] = True
            while len(self._seen_requests) > MAX_DEDUP_KEYS:
                self._seen_requests.popitem(last=False)
        self._forwarding_requests.pop(key).set_result(delivered)

    async def forward_client_command(
        self,
        workspace_id: str,
        client_conn_id: str,
        frame: dict[str, Any],
    ) -> dict[str, Any] | None:
        """将前端指令校验并路由至工作区内的目标在线 AgentNode，返回即时错误帧或 None。"""
        cmd_type = str(frame.get("type") or "")
        session_events_v1 = supports_session_events(frame.get("capabilities"))
        if cmd_type == "hello" or session_events_v1:
            async with self._lock:
                client = self._clients.get(workspace_id, {}).get(client_conn_id)
                if client is not None and (cmd_type == "hello" or not client.session_events_v1):
                    client.session_events_v1 |= session_events_v1
                    self._queue_client_frame(workspace_id, client_conn_id, client, client_ready())
            if cmd_type == "hello":
                return None

        if cmd_type not in ALLOWED_CLIENT_COMMANDS:
            return {"type": "Error", "code": "unsupported_command", "requestId": frame.get("requestId"),
                    "message": f"Unsupported command: {cmd_type}"}

        if cmd_type == "node.ping":
            return {"type": "Pong", "requestId": frame.get("requestId")}

        target_node_id = str(frame.get("nodeId") or "").strip()
        if not target_node_id:
            return {"type": "Error", "code": "missing_node_id", "message": "nodeId is required"}

        node = await self.get_online_node(workspace_id, target_node_id)
        command_id = str(frame.get("commandId") or frame.get("requestId") or "").strip()
        request_id = str(frame.get("requestId") or command_id).strip()
        if node is None:
            return {
                "type": "NodeUnavailable",
                "code": "node_offline",
                "nodeId": target_node_id,
                "requestId": request_id or None,
                "message": "Target device node is offline",
            }

        key = None
        if cmd_type in ("prompt.send", "handoff.send") and command_id:
            if len(command_id) > 128:
                return {"type": "Error", "code": "invalid_command_id", "requestId": request_id}
            key = (workspace_id, target_node_id, command_id)
            if not await self._begin_forward(key):
                return {"type": "DuplicateIgnored", "nodeId": target_node_id, "requestId": request_id, "commandId": command_id}

        forwarded = {**frame, "_clientConnId": client_conn_id}
        if key:
            forwarded.update(requestId=request_id, commandId=command_id)
        delivered = False
        try:
            await node.websocket.send_json(forwarded)
            delivered = True
        except Exception:
            await self.unregister_node(workspace_id, target_node_id, node.websocket)
            return {
                "type": "NodeUnavailable",
                "code": "node_disconnected",
                "nodeId": target_node_id,
                "requestId": request_id or None,
                "message": "Target device node disconnected",
            }
        finally:
            if key:
                self._finish_forward(key, delivered)
        return None

    async def broadcast_node_event(
        self,
        workspace_id: str,
        frame: dict[str, Any],
        *,
        target_client_id: str | None = None,
    ) -> None:
        queued = await self.broadcast_workspace(workspace_id, frame, target_client_id=target_client_id)
        # 每帧都审计；queued 表示成功入队的客户端数，不代表 socket 已送达。
        sequence = frame.get("seq")
        audit_event(
            "core",
            session_id=frame.get("sessionId"),
            run_id=frame.get("runId"),
            stream_id=frame.get("streamId"),
            seq=sequence if sequence is not None else frame.get("sequence"),
            event_type=frame.get("type"),
            call_id=frame.get("callId"),
            queued=queued,
        )

    async def broadcast_workspace(
        self,
        workspace_id: str,
        frame: dict[str, Any],
        *,
        target_client_id: str | None = None,
    ) -> int:
        """只做非阻塞入队，返回成功入队的客户端数；禁止在节点收帧路径执行 socket 写操作。"""
        async with self._lock:
            clients = dict(self._clients.get(workspace_id, {}))
        if target_client_id is not None:
            client = clients.get(target_client_id)
            if client is None:
                logger.warning(
                    "Fleet client frame dropped client_id=%s reason=target_missing dropped_frames=1",
                    target_client_id,
                )
                return 0
            targets = [(target_client_id, client)]
        else:
            targets = list(clients.items())
        return sum(
            self._queue_client_frame(workspace_id, cid, client, frame)
            for cid, client in targets if not client.skips_frame(frame)
        )


fleet_hub = FleetRelayHub()
