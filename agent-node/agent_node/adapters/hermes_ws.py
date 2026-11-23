"""Hermes dashboard/gateway JSON-RPC over WebSocket."""

import asyncio
from collections import deque
from collections.abc import AsyncIterator, Callable
from contextlib import AsyncExitStack, asynccontextmanager, suppress
from copy import deepcopy
from dataclasses import dataclass, field
from inspect import signature
from ipaddress import ip_address
import json
import logging
from pathlib import Path
import re
from shlex import quote as quote_arg
from typing import Any
from urllib.parse import urlencode, urlsplit, urlunsplit
from uuid import uuid4

import httpx
import websockets
from websockets.asyncio.client import ClientConnection

from ..config import HermesMediaConfig, PathOutsideAllowedRootsError, ensure_allowed_path
from .base import (
    AdapterProbe, ApprovalCallback, EventEmitter, build_todo_updated_event,
    build_token_usage_event, build_tool_call_update, compaction_frame, compaction_record,
    extract_usage_counts, merge_prompt_with_attachments, prepare_session_dir,
)
from .hermes import HermesAdapter, _gateway_history, _hermes_context, _HISTORY_LIMIT
from .jsonrpc import JsonRpcError


_LOG = logging.getLogger(__name__)
_TRANSPORT_ERRORS = (OSError, TimeoutError, websockets.WebSocketException)
_TOKEN_SCRIPT = re.compile(r'window\.__HERMES_SESSION_TOKEN__\s*=\s*("(?:[^"\\]|\\.)*")')


def _loopback(host: str) -> bool:
    try:
        return ip_address(host).is_loopback
    except ValueError:
        return host == "localhost"


class _GatewayConnection:
    """Correlate RPCs on one physical connection, with a dedicated receive loop."""

    def __init__(self, socket: ClientConnection, on_frame: Callable[[dict[str, Any]], None]) -> None:
        self.socket = socket
        self.on_frame = on_frame
        self.ready: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self.pending: dict[int, asyncio.Future[dict[str, Any]]] = {}
        self.next_id = 0

    async def write(self, frame: dict[str, Any]) -> None:
        try:
            await self.socket.send(json.dumps({"jsonrpc": "2.0", **frame}))
        except websockets.ConnectionClosed:
            raise ConnectionError("Hermes WebSocket disconnected") from None

    async def call(self, method: str, params: dict[str, Any] | None = None, *, timeout: float = 15) -> dict[str, Any]:
        self.next_id += 1
        rid = self.next_id
        reply = asyncio.get_running_loop().create_future()
        self.pending[rid] = reply
        try:
            async with asyncio.timeout(timeout):
                await self.write({"id": rid, "method": method, "params": params or {}})
                return await reply
        finally:
            self.pending.pop(rid, None)
            if reply.done() and not reply.cancelled():
                reply.exception()
            else:
                reply.cancel()

    async def read(self) -> None:
        try:
            async for raw in self.socket:
                # The gateway sends one object per frame, with optional trailing newline.
                frame = json.loads(raw)
                if not isinstance(frame, dict):
                    continue
                if "method" in frame:
                    params = frame.get("params") or {}
                    if frame["method"] == "event" and params.get("type") == "gateway.ready":
                        if not self.ready.done():
                            self.ready.set_result(params.get("payload") or {})
                    else:
                        self.on_frame(frame)
                    continue
                reply = self.pending.get(frame.get("id"))
                if reply is None or reply.done():
                    continue
                if error := frame.get("error"):
                    reply.set_exception(JsonRpcError(error.get("code", -1), error.get("message", "RPC error")))
                else:
                    result = frame.get("result")
                    reply.set_result(result if isinstance(result, dict) else {})
        finally:
            for reply in (self.ready, *self.pending.values()):
                if not reply.done():
                    reply.set_exception(ConnectionError("Hermes WebSocket disconnected"))


@dataclass
class _Session:
    stored_id: str
    runtime_id: str = ""
    connection: _GatewayConnection | None = None
    epoch: str = ""
    seq: int = 0
    generation: int | None = None
    info: dict[str, Any] = field(default_factory=dict)
    transcript: list[dict[str, Any]] = field(default_factory=list)
    held: list[dict[str, Any]] | None = None


@dataclass
class _Turn:
    request_id: str
    emit: EventEmitter
    approve: ApprovalCallback
    events: asyncio.Queue[dict[str, Any]] = field(default_factory=asyncio.Queue)
    admitted: asyncio.Event = field(default_factory=asyncio.Event)
    admission_id: str = ""
    generation: int | None = None
    baseline: dict[str, int] | None = None
    text: str = ""
    thought: str = ""
    reply_tail: str = ""
    reply_offsets: dict[tuple[str, int], int] = field(default_factory=dict)
    legacy_queued: bool = False
    approvals: dict[str, str] = field(default_factory=dict)
    approval_tasks: dict[str, asyncio.Task[None]] = field(default_factory=dict)


def _usage_counts(raw: dict[str, Any]) -> dict[str, int]:
    return extract_usage_counts({
        **raw, "cache_read_input_tokens": raw.get("cache_read_tokens") or raw.get("cache_read"),
    })


def _transcript_history(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Fold Hermes display tool rows into assistant parts using the existing Fleet shape."""
    history: deque[dict[str, Any]] = deque()
    for row in rows:
        role = row.get("role")
        rid = row.get("row_id")
        if row.get("row_kind") == "compaction":
            at = row.get("timestamp")
            history.append(compaction_record(str(rid or at), at=int(at * 1000) if isinstance(at, (int, float)) else None,
                                             summary=str(row.get("text") or "")))
            continue
        if role == "tool":
            call_id = str(row.get("tool_call_id") or rid or f"tool-{len(history)}")
            tool = {"callId": call_id, "name": row.get("name") or "tool", "input": row.get("args"),
                    "detail": row.get("context"), "status": "completed", "output": _tool_output(row.get("content"))}
            HermesAdapter._record_history_update(history, "tool_call_update", None, tool, None)
            continue
        history.extend(_gateway_history([{**row, "id": rid, "thought": row.get("reasoning") or row.get("thought")}]))
    return list(history)


def _tool_output(value: Any) -> str | None:
    if isinstance(value, str) or value is None:
        return value
    return json.dumps(value, ensure_ascii=False)


class HermesWsAdapter(HermesAdapter):
    """Keep Hermes' public adapter contract, including daemon type checks and REST CronPort."""

    def __init__(
        self, allowed_roots: tuple[Path, ...], *, command: str = "hermes", mode: str = "acp",
        serve_url: str | None = None, api_key: str | None = None, ws_url: str | None = None,
        ws_port: int | str | None = None, token_file: str | Path | None = None, token: str | None = None,
        media: HermesMediaConfig | None = None,
    ) -> None:
        super().__init__(allowed_roots, command=command, mode=mode, serve_url=serve_url, api_key=api_key)
        if ws_url is None:
            if ws_port is not None:
                ws_url = f"ws://127.0.0.1:{int(ws_port)}/api/ws"
            elif base_url := serve_url or (media.base_url if media else None):
                base = urlsplit(base_url)
                ws_url = urlunsplit(("wss" if base.scheme == "https" else "ws", base.netloc,
                                     base.path.rstrip("/") + "/api/ws", base.query, base.fragment))
            else:
                ws_url = "ws://127.0.0.1:9119/api/ws"
        url = urlsplit(ws_url)
        self._local = _loopback(url.hostname or "")
        if (url.scheme not in ("ws", "wss") or not url.hostname or url.username is not None
                or url.port == 0 or url.query or url.fragment or (url.scheme == "ws" and not self._local)):
            raise ValueError("Hermes WS requires a credential-free ws:// loopback or wss:// URL")
        if url.path.rstrip("/").endswith("/api/ws"):
            prefix = url.path.rstrip("/")[:-len("/api/ws")]
        else:
            prefix = url.path.rstrip("/")
        self._ws_url = urlunsplit((url.scheme, url.netloc, prefix + "/api/ws", "", ""))
        self._http_base = urlunsplit(("https" if url.scheme == "wss" else "http", url.netloc, prefix, "", ""))
        self._token_file = Path(token_file).expanduser() if token_file else (
            media.token_file if media and media.base_url.rstrip("/") == self._http_base else None
        )
        self._token = token or (api_key if serve_url and serve_url.rstrip("/") == self._http_base else None)
        self._dashboard_token: str | None = None
        self._socket_task: asyncio.Task[None] | None = None
        self._ready = asyncio.Event()
        self._connection: _GatewayConnection | None = None
        self._canonical = False
        self._epoch = ""
        self._closed = False
        self._last_error = ""
        self._sessions: dict[str, _Session] = {}
        self._runtime_sessions: dict[str, str] = {}
        self._active: dict[str, _Turn] = {}

    async def _credentials(self) -> tuple[str, list[str] | None]:
        async with httpx.AsyncClient(timeout=4, trust_env=False, follow_redirects=False) as client:
            token = self._token
            if self._token_file:
                token = (await asyncio.to_thread(self._token_file.read_text, encoding="utf-8-sig")).strip()
                if not token:
                    raise ValueError("Hermes WebSocket token file is empty")
            if token:
                response = await client.post(f"{self._http_base}/api/auth/ws-ticket",
                                             headers={"Authorization": f"Bearer {token}"}, json={})
                if response.is_success:
                    ticket = response.json().get("ticket")
                    if isinstance(ticket, str) and ticket:
                        self._dashboard_token = token
                        return self._ws_url, ["hermes-gateway-v1", f"hermes-gateway-ticket.{ticket}"]
                if not self._local:
                    raise ConnectionError(f"Hermes WebSocket ticket request failed (HTTP {response.status_code})")
            elif self._local:
                response = await client.get(self._http_base + "/")
                if response.is_success and (match := _TOKEN_SCRIPT.search(response.text)):
                    token = json.loads(match[1])
            self._dashboard_token = token
            return (f"{self._ws_url}?{urlencode({'token': token})}" if token else self._ws_url), None

    async def _heartbeat(self, connection: _GatewayConnection) -> None:
        while True:
            await asyncio.sleep(15)
            await connection.call("gateway.ping", timeout=10)

    @asynccontextmanager
    async def _dial(self) -> AsyncIterator[ClientConnection]:
        url, protocols = await self._credentials()
        options: dict[str, Any] = {"open_timeout": 5, "close_timeout": 1, "max_size": 8 * 1024 * 1024}
        if self._local and "proxy" in signature(websockets.connect).parameters:
            options["proxy"] = None
        async with AsyncExitStack() as stack:
            try:
                socket = await stack.enter_async_context(websockets.connect(url, subprotocols=protocols, **options))
            except websockets.InvalidStatus as exc:
                # A non-gated standalone dashboard can expose the ticket route
                # yet accept only its local session token on this socket.
                if not (exc.response.status_code == 403 and protocols and self._local and self._dashboard_token):
                    raise
                query = urlencode({"token": self._dashboard_token})
                socket = await stack.enter_async_context(websockets.connect(f"{self._ws_url}?{query}", **options))
            yield socket

    async def _serve(self) -> None:
        delay = 1
        while not self._closed:
            try:
                async with self._dial() as socket:
                    connection = _GatewayConnection(socket, self._on_frame)
                    tasks = [asyncio.create_task(connection.read())]
                    try:
                        async with asyncio.timeout(10):
                            ready = await asyncio.shield(connection.ready)
                        self._canonical = bool(ready.get("session_authority"))
                        self._epoch = str(ready.get("replay_epoch") or "")
                        with suppress(JsonRpcError):
                            await connection.call("client.capabilities", {"server_requests": True})
                        self._connection = connection
                        tasks.append(asyncio.create_task(self._heartbeat(connection)))
                        for sid in sorted(self._sessions, key=lambda sid: sid not in self._active):
                            session = self._sessions.get(sid)
                            if session is not None and session.connection is not None:
                                await self._recover(connection, sid, session)
                        self._ready.set()
                        self._last_error = ""
                        delay = 1
                        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                        for task in done:
                            task.result()
                    finally:
                        self._ready.clear()
                        self._connection = None
                        for task in tasks:
                            task.cancel()
                        await asyncio.gather(*tasks, return_exceptions=True)
                        if connection.ready.done() and not connection.ready.cancelled():
                            connection.ready.exception()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                # WebSocket exceptions may contain the credential-bearing handshake URI.
                detail = f" (HTTP {exc.response.status_code})" if isinstance(exc, websockets.InvalidStatus) else ""
                self._last_error = f"{type(exc).__name__}{detail}"
                _LOG.debug("Hermes WebSocket retry in %ss after %s", delay, self._last_error)
            await asyncio.sleep(delay)
            delay = min(delay * 2, 30)

    async def _online(self, *, timeout: float = 10) -> _GatewayConnection:
        if self._closed:
            raise ConnectionError("Hermes WebSocket adapter is closed")
        if self._socket_task is None:
            self._socket_task = asyncio.create_task(self._serve())
        try:
            async with asyncio.timeout(timeout):
                while self._connection is None or not self._ready.is_set():
                    await self._ready.wait()
                    if self._closed:
                        raise ConnectionError("Hermes WebSocket adapter is closed")
        except TimeoutError:
            detail = f" ({self._last_error})" if self._last_error else ""
            raise ConnectionError(f"Hermes WebSocket unavailable{detail}") from None
        return self._connection

    async def close(self) -> None:
        self._closed = True
        self._ready.set()
        for turn in self._active.values():
            turn.events.put_nowait({"type": "_failed", "payload": {"error": "Hermes WebSocket adapter closed"}})
            for task in turn.approval_tasks.values():
                task.cancel()
        if self._socket_task is not None:
            self._socket_task.cancel()
            await asyncio.gather(self._socket_task, return_exceptions=True)
            self._socket_task = None
        await super().close()

    async def probe(self) -> AdapterProbe:
        caps = ("chat", "history", "approval", "worktree", "models", "cron", "files", "diff", "checkpoints",
                "todos", "context-usage", "session-model", "session-effort")
        try:
            connection = await self._online(timeout=3)
            await connection.call("gateway.ping", timeout=3)
            status = "ready"
        except (*_TRANSPORT_ERRORS, JsonRpcError):
            status = "unavailable"
        return AdapterProbe(provider=self.provider, version="gateway-ws", status=status, capabilities=caps)

    def _on_frame(self, frame: dict[str, Any]) -> None:
        params = frame.get("params") or {}
        sid = self._runtime_sessions.get(params.get("session_id"))
        if sid is None:
            if "id" in frame and self._connection is not None:
                asyncio.create_task(self._decline(self._connection, frame["id"]))
            return
        session = self._sessions[sid]
        if session.held is not None:
            session.held.append(frame)
        elif frame["method"] == "event" and params.get("type") == "session.replay_gap":
            if self._connection is not None:
                asyncio.create_task(self._connection.socket.close())
        else:
            self._deliver(sid, session, frame)

    def _deliver(self, sid: str, session: _Session, frame: dict[str, Any]) -> None:
        params = frame["params"]
        if frame["method"] != "event":
            if frame["method"] == "approval" and (turn := self._active.get(sid)):
                turn.events.put_nowait({"type": "approval.request", "payload": params, "rpc_id": frame["id"]})
            elif "id" in frame and self._connection is not None:
                asyncio.create_task(self._decline(self._connection, frame["id"]))
            return
        epoch = params.get("replay_epoch") or self._epoch
        if epoch != session.epoch:
            session.epoch, session.seq = epoch, 0
        if isinstance(seq := params.get("seq"), int):
            if seq <= session.seq:
                return
            session.seq = seq
        if (kind := params.get("type")) == "session.info" and not self._active.get(sid):
            # Apply metadata in the reader before resolving subsequent RPCs. No callback
            # may block this loop or make an RPC of its own.
            previous = self.session_effort_fields(sid)
            self._remember_info(sid, session, params.get("payload") or {})
            current = self.session_effort_fields(sid)
            if current != previous and self.on_effort_update:
                asyncio.create_task(self._notify_effort(sid, current))
        if turn := self._active.get(sid):
            turn.events.put_nowait(params)

    async def _notify_effort(self, sid: str, current: dict[str, Any]) -> None:
        if callback := self.on_effort_update:
            with suppress(OSError, websockets.ConnectionClosed):
                await callback({"type": "ContextUsage", "provider": self.provider, "sessionId": sid,
                                **current, **self.session_model_fields(sid)})

    @staticmethod
    async def _decline(connection: _GatewayConnection, rid: Any) -> None:
        with suppress(ConnectionError):
            await connection.write({"id": rid, "error": {"code": -32601, "message": "Unsupported client request"}})

    def _remember_info(self, sid: str, session: _Session, info: dict[str, Any]) -> None:
        session.info.update(info)
        model = info.get("model")
        provider = info.get("provider") or session.info.get("provider")
        if isinstance(model, str) and model:
            self._model_by_session[sid] = f"{provider}:{model}" if provider else model
        if isinstance(effort := info.get("reasoning_effort"), str):
            self._effort_current[sid] = effort if effort and effort != "default" else None
        if isinstance(cwd := info.get("cwd"), str) and cwd:
            self._session_cwds[sid] = None
            with suppress(PathOutsideAllowedRootsError):
                self._session_cwds[sid] = ensure_allowed_path(cwd, self.allowed_roots)

    def _remember_snapshot(self, connection: _GatewayConnection, sid: str, session: _Session,
                           result: dict[str, Any]) -> None:
        runtime_id = result.get("session_id")
        if not isinstance(runtime_id, str) or not runtime_id:
            raise ValueError("Hermes 未返回会话 ID")
        if session.runtime_id != runtime_id and self._runtime_sessions.get(session.runtime_id) == sid:
            self._runtime_sessions.pop(session.runtime_id)
        session.runtime_id = runtime_id
        session.stored_id = result.get("stored_session_id") or result.get("session_key") or session.stored_id or runtime_id
        session.connection = connection
        session.generation = result.get("execution_generation")
        self._runtime_sessions[runtime_id] = sid
        self._remember_info(sid, session, result.get("info") or {})
        self._require_cwd(sid)

    def _require_cwd(self, sid: str) -> Path:
        cwd = self._session_cwds.get(sid)
        if cwd is None:
            raise PathOutsideAllowedRootsError("Hermes 会话目录不在节点允许范围内")
        return ensure_allowed_path(cwd, self.allowed_roots)

    async def _resume(self, connection: _GatewayConnection, sid: str, session: _Session) -> dict[str, Any]:
        params = {"session_id": session.stored_id, "omit_messages": True}
        if not self._canonical:
            params["lazy"] = True
        result = await connection.call("session.resume", params, timeout=30)
        self._remember_snapshot(connection, sid, session, result)
        return result

    async def _session(self, connection: _GatewayConnection, sid: str) -> _Session:
        session = self._sessions.setdefault(sid, _Session(sid))
        if session.connection is not connection:
            # A previous path refusal is sticky until a fresh resume validates the actual cwd.
            result = await self._resume(connection, sid, session)
            session.epoch = result.get("replay_epoch") or self._epoch
            session.seq = result.get("last_sequence") or 0
        self._require_cwd(sid)
        return session

    async def _read_transcript(self, connection: _GatewayConnection, session: _Session,
                               limit: int = _HISTORY_LIMIT) -> list[dict[str, Any]]:
        rows: deque[dict[str, Any]] = deque()
        history: list[dict[str, Any]] = []
        cursor: str | None = None
        seen = set()
        try:
            while len(history) < limit:
                params: dict[str, Any] = {"session_id": session.stored_id, "order": "latest", "limit": limit}
                if cursor:
                    params["cursor"] = cursor
                result = await connection.call("session.transcript", params, timeout=30)
                page = result.get("rows") or []
                rows.extendleft(reversed(page))
                history = _transcript_history(list(rows))
                next_cursor = result.get("next_cursor")
                if result.get("reset") and cursor:
                    # A rotation invalidated the page being assembled. The fresh
                    # page replaces everything fetched under its previous cursor.
                    return _transcript_history(page)[-limit:]
                if not page or not next_cursor or next_cursor in seen:
                    break
                seen.add(next_cursor)
                cursor = next_cursor
        except JsonRpcError as exc:
            if self._canonical or exc.code != -32601:
                # A legacy fresh session may not have been persisted yet. Its history
                # comes from session.history when the transcript verb is unavailable.
                raise
            result = await connection.call("session.history", {"session_id": session.runtime_id})
            history = _transcript_history(result.get("messages") or [])
        return history[-limit:]

    async def _recover(self, connection: _GatewayConnection, sid: str, session: _Session) -> None:
        turn = self._active.get(sid)
        session.held = []
        try:
            replay: dict[str, Any] = {}
            previous_runtime_id = session.runtime_id
            replay_params = {"session_id": session.runtime_id, "last_seen": session.seq}
            if self._canonical and session.epoch:
                # On the authority, this read before resume installs a per-client
                # cursor so the attach flushes events that arrived between the RPCs.
                replay_params["replay_epoch"] = session.epoch
                with suppress(JsonRpcError):
                    replay = await connection.call("session.events.since", replay_params)
            snapshot = await self._resume(connection, sid, session)
            if not self._canonical and session.epoch == self._epoch and previous_runtime_id == session.runtime_id:
                replay_params["session_id"] = session.runtime_id
                with suppress(JsonRpcError):
                    replay = await connection.call("session.events.since", replay_params)

            gap = not replay or bool(replay.get("truncated") or replay.get("snapshot_required"))
            if gap:
                session.epoch = snapshot.get("replay_epoch") or self._epoch
                session.seq = snapshot.get("last_sequence") or 0
            try:
                session.transcript = await self._read_transcript(connection, session)
            except JsonRpcError as exc:
                _LOG.debug("Hermes transcript resync failed: %s", exc.code)

            for event in replay.get("events") or []:
                self._deliver(sid, session, {"method": "event", "params": event})
            receipt = None
            legacy_lost = False
            if turn is not None:
                # Keep the live overlay when the server hasn't committed its latest
                # text. A terminal receipt repairs a gap without resubmitting the turn.
                if gap and self._canonical and turn.admission_id:
                    receipt = await connection.call("prompt.receipt", {
                        "session_id": session.runtime_id, "admission_id": turn.admission_id, "include_result": True,
                    })
                elif gap and not self._canonical and not snapshot.get("running"):
                    legacy_lost = True
                for prompt in snapshot.get("prompts") or []:
                    if prompt.get("kind") == "approval":
                        turn.events.put_nowait({"type": "approval.request", "payload": prompt})
                if not snapshot.get("open_requests") and (pending := snapshot.get("pending_approval")):
                    turn.events.put_nowait({"type": "approval.request", "payload": pending})
                for request in [*(replay.get("open_requests") or []), *(snapshot.get("open_requests") or [])]:
                    if request.get("method") == "approval" and request.get("id"):
                        turn.events.put_nowait({"type": "approval.request", "rpc_id": request["id"],
                                                "payload": request.get("params") or {}})
            for frame in session.held:
                self._deliver(sid, session, frame)
            if turn is not None and receipt is not None:
                self._recover_receipt(turn, receipt)
            elif turn is not None and legacy_lost:
                turn.events.put_nowait({"type": "_failed", "payload": {
                    "error": "Hermes 重连后无法确认断线期间的回合终态",
                }})
        except (JsonRpcError, ValueError, PermissionError) as exc:
            session.connection = None
            if self._runtime_sessions.get(session.runtime_id) == sid:
                self._runtime_sessions.pop(session.runtime_id)
            if turn is not None:
                turn.events.put_nowait({"type": "_failed", "payload": {"error": str(exc)}})
        finally:
            session.held = None

    @staticmethod
    def _recover_receipt(turn: _Turn, receipt: dict[str, Any]) -> None:
        if receipt.get("status") == "unknown":
            turn.events.put_nowait({"type": "_failed", "payload": {"error": "Hermes 回合状态未知"}})
        if receipt.get("status") == "terminal":
            result = receipt.get("result") or {}
            if not isinstance(result, dict):
                result = {}
            turn.events.put_nowait({"type": "message.complete", "admission_id": turn.admission_id, "payload": {
                "status": receipt.get("outcome"), "text": result.get("final_response") or result.get("text"),
                "error": result.get("error"), "turn_usage": receipt.get("usage"),
            }})

    async def list_sessions(self, *, page: int = 1, limit: int = 30) -> list[dict[str, Any]]:
        connection = await self._online()
        limit = min(100, max(1, limit))
        offset = (min(100, max(1, page)) - 1) * limit
        params: dict[str, Any] = {"limit": offset + limit}
        if self._canonical:
            params.update(picker=True, limit=min(offset + limit, 200))
            stored, live = await asyncio.gather(
                connection.call("session.list", {**params, "scope": "stored"}),
                connection.call("session.list", {**params, "scope": "live"}),
            )
            by_id = {row.get("session_id") or row.get("id"): row
                     for row in [*stored.get("sessions", []), *live.get("sessions", [])]}
            listing = sorted(by_id.values(), key=lambda row: row.get("last_active_at") or row.get("started_at") or 0,
                             reverse=True)
        else:
            listing = (await connection.call("session.list", params)).get("sessions", [])
        rows = [
            {**row, "sessionId": row.get("session_id") or row.get("id"),
             "updatedAt": row.get("last_active_at") or row.get("last_active") or row.get("started_at")}
            for row in listing
        ][offset:offset + limit]
        if not self._canonical and any(not row.get("cwd") for row in rows):
            await self._enrich_legacy_list(rows, offset, limit)
        return self._session_summaries(rows)

    async def _enrich_legacy_list(self, rows: list[dict[str, Any]], offset: int, limit: int) -> None:
        """Standalone session.list omits cwd. Use the dashboard's read-only metadata API."""
        token = self._dashboard_token
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        try:
            async with httpx.AsyncClient(timeout=5, trust_env=False) as client:
                page = await client.get(f"{self._http_base}/api/sessions", headers=headers,
                                        params={"offset": offset, "limit": limit, "order": "recent"})
                page.raise_for_status()
            metadata = {row.get("id"): row for row in page.json().get("sessions") or []}
        except (httpx.HTTPError, ValueError):
            return
        for row in rows:
            if detail := metadata.get(row["sessionId"]):
                row.update({key: detail[key] for key in ("cwd", "model") if key in detail})
                # Legacy session.list only carries started_at, so a long-running session that was
                # active minutes ago sorts as if it were a day old and sinks out of the client's
                # preview list. Prefer the dashboard's authoritative last-active timestamp.
                last_active = detail.get("last_active") or detail.get("last_active_at") or detail.get("updated_at")
                if isinstance(last_active, (int, float)) and last_active > 0:
                    row["updatedAt"] = last_active

    async def open_session(self, *, cwd: str, session_id: str | None = None,
                           use_worktree: bool = False) -> dict[str, Any]:
        connection = await self._online()
        seed = session_id or f"hermes-{uuid4().hex[:8]}"
        path, worktree = prepare_session_dir(cwd, self.allowed_roots, session_id=seed, use_worktree=use_worktree)
        async with self._history_lock:
            if session_id:
                sid = session_id
                session = await self._session(connection, sid)
                if use_worktree and sid not in self._active and self._session_cwds[sid] != path:
                    if self._canonical:
                        await self._mutate(connection, session, "workspace", {"cwd": str(path)})
                    else:
                        await connection.call("session.cwd.set", {"session_id": session.runtime_id, "cwd": str(path)})
                    self._session_cwds[sid] = path
                path = self._require_cwd(sid)
            else:
                params = {"cwd": str(path), "source": "acp"}
                params["request_id" if self._canonical else "idempotency_key"] = seed
                result = await connection.call("session.create", params, timeout=30)
                sid = result.get("stored_session_id") or result.get("session_id")
                if not isinstance(sid, str) or not sid:
                    raise ValueError("Hermes 未返回会话 ID")
                session = self._sessions.setdefault(sid, _Session(sid))
                self._session_cwds[sid] = path
                self._remember_snapshot(connection, sid, session, result)
                session.epoch = result.get("replay_epoch") or self._epoch
                session.seq = result.get("last_sequence") or 0
        return {"sessionId": sid, "provider": self.provider, "cwd": str(path), "worktreePath": worktree,
                "title": session.info.get("title") or f"Hermes ({path.name})",
                **self.session_effort_fields(sid), **self.session_model_fields(sid)}

    async def get_history(self, *, session_id: str, limit: int = 50) -> list[dict[str, Any]]:
        limit = max(1, min(limit, _HISTORY_LIMIT))
        if session_id in self._active:
            return deepcopy(list(self._history.get(session_id, ()))[-limit:])
        connection = await self._online()
        async with self._history_lock:
            session = await self._session(connection, session_id)
            history = await self._read_transcript(connection, session, limit)
            session.transcript = history
        return deepcopy(history[-limit:])

    async def fetch_transcript(self, *, session_id: str, limit: int = 20) -> list[dict]:
        """Read the latest persisted messages in chronological order for idle polling."""
        try:
            connection = await self._online()
            async with self._history_lock:
                if session_id in self._active:
                    return []
                session = await self._session(connection, session_id)
            rows = await self._read_transcript(connection, session, max(1, min(limit, _HISTORY_LIMIT)))
            return [{**row, "id": row.get("id"), "created_at": row.get("createdAt")} for row in rows]
        except Exception as exc:
            _LOG.debug("Hermes idle transcript unavailable: %s", type(exc).__name__)
            return []

    async def list_models(self) -> list[dict[str, Any]]:
        connection = await self._online()
        result = await connection.call("model.options")
        efforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]
        models = []
        for provider in result.get("providers") or []:
            slug = provider.get("slug") or ""
            capabilities = provider.get("capabilities") or {}
            for model in provider.get("models") or []:
                flags = capabilities.get(model) or {}
                models.append({
                    "id": f"{slug}:{model}" if slug else model, "label": model, "provider": slug,
                    "efforts": efforts if flags.get("reasoning", True) else [],
                })
        current = result.get("model")
        slug = result.get("provider") or ""
        if not models and current:
            models.append({"id": f"{slug}:{current}" if slug else current, "label": current,
                           "provider": slug, "efforts": efforts})
        self._picker_models = models
        return models

    async def _mutate(self, connection: _GatewayConnection, session: _Session, operation: str,
                      payload: dict[str, Any], *, timeout: float = 30) -> dict[str, Any]:
        # Fetch current revision/generation together. Mutations race other viewers
        # and must use the owner's fence instead of overwriting their changes.
        snapshot = await connection.call("session.resume", {"session_id": session.stored_id, "omit_messages": True})
        return await connection.call("session.mutate", {
            "session_id": snapshot["session_id"], "request_id": uuid4().hex, "operation": operation,
            "payload": payload, "expected_revision": snapshot["revision"],
            "expected_generation": snapshot["execution_generation"],
        }, timeout=timeout)

    async def _set_model(self, connection: _GatewayConnection, sid: str, session: _Session,
                         model_id: str) -> dict[str, Any]:
        if self._model_by_session.get(sid) == model_id:
            return self.session_model_fields(sid)
        slugs = {row["provider"] for row in self._picker_models or []}
        slugs.add(str(session.info.get("provider") or ""))
        provider = next((slug for slug in sorted(slugs, key=len, reverse=True)
                         if slug and model_id.startswith(slug + ":")), "")
        model = model_id[len(provider) + 1:] if provider else model_id
        if not provider and ":" in model_id:
            provider, _, model = model_id.partition(":")
        if self._canonical:
            result = await self._mutate(connection, session, "model", {
                "model": model, **({"provider": provider} if provider else {}),
            })
            info = await connection.call("session.info", {"session_id": session.runtime_id})
        else:
            command = quote_arg(model) + (f" --provider {quote_arg(provider)}" if provider else "")
            result = await connection.call("config.set", {
                "session_id": session.runtime_id, "key": "model", "value": command, "scope": "session",
            })
            info = (await connection.call("session.activate", {
                "session_id": session.runtime_id, "omit_messages": True,
            })).get("info") or {}
        if result.get("status") in ("confirm_required", "selection_required", "refused") or result.get("confirm_required"):
            raise ValueError(str(result.get("message") or "Hermes 需要确认模型切换"))
        self._context_usage.pop(sid, None)
        self._effort_by_session.pop(sid, None)
        self._remember_info(sid, session, info)
        fields = self.session_model_fields(sid)
        if not fields:
            raise ValueError("Hermes 未返回当前会话模型")
        return fields

    async def set_session_model(self, *, session_id: str, model_id: str) -> dict[str, Any] | None:
        connection = await self._online()
        async with self._history_lock:
            if session_id in self._active:
                raise ValueError("当前会话已有任务运行中")
            session = await self._session(connection, session_id)
            return await self._set_model(connection, session_id, session, model_id)

    async def _set_effort(self, connection: _GatewayConnection, sid: str, session: _Session,
                          effort: str) -> dict[str, Any]:
        if self._canonical:
            await self._mutate(connection, session, "reasoning", {"effort": None if effort == "default" else effort})
            info = await connection.call("session.info", {"session_id": session.runtime_id})
        else:
            if effort == "default":
                profile = await connection.call("config.get", {"key": "reasoning"})
                effort = profile["value"]
            result = await connection.call("config.set", {
                "session_id": session.runtime_id, "key": "reasoning", "value": effort, "scope": "session",
            })
            info = {"reasoning_effort": result.get("value")}
        self._remember_info(sid, session, info)
        fields = self.session_effort_fields(sid)
        if not fields:
            raise ValueError("Hermes 未返回当前思考强度")
        return fields

    async def set_session_effort(self, *, session_id: str, effort: str) -> dict[str, Any]:
        connection = await self._online()
        async with self._history_lock:
            if session_id in self._active:
                raise ValueError("当前会话已有任务运行中")
            session = await self._session(connection, session_id)
            return await self._set_effort(connection, session_id, session, effort)

    async def _usage(self, connection: _GatewayConnection, session: _Session) -> dict[str, Any]:
        method = "session.stats" if self._canonical else "session.usage"
        return await connection.call(method, {"session_id": session.runtime_id}, timeout=5)

    @staticmethod
    def _context(usage: dict[str, Any]) -> dict[str, Any] | None:
        if "context_tokens" in usage and "context_used" not in usage:
            usage = {**usage, "context_used": usage["context_tokens"], "context_max": usage.get("context_length"),
                     "context_estimated": usage.get("context_source") not in (None, "provider_usage")}
        return _hermes_context(usage)

    async def get_context_usage(self, *, session_id: str) -> dict[str, Any] | None:
        connection = await self._online()
        async with self._history_lock:
            session = await self._session(connection, session_id)
        params = {"session_id": session.runtime_id}
        usage = None
        with suppress(JsonRpcError, TimeoutError):
            usage = self._context(await self._usage(connection, session))
        if not usage or not usage.get("capacityTokens"):
            with suppress(JsonRpcError, TimeoutError):
                usage = self._context(await connection.call("session.context_breakdown", params, timeout=2)) or usage
        return usage or self._context_usage.get(session_id)

    async def rename_session(self, *, session_id: str, title: str) -> dict[str, Any]:
        connection = await self._online()
        async with self._history_lock:
            session = await self._session(connection, session_id)
            if self._canonical:
                result = await self._mutate(connection, session, "rename", {"title": title})
            else:
                result = await connection.call("session.title", {"session_id": session.runtime_id, "title": title})
            session.info["title"] = result.get("title") or title
        return {"sessionId": session_id, "title": session.info["title"]}

    async def delete_session(self, *, session_id: str) -> None:
        connection = await self._online()
        async with self._history_lock:
            if session_id in self._active:
                raise ValueError("当前会话已有任务运行中")
            session = await self._session(connection, session_id)
            if self._canonical:
                await self._mutate(connection, session, "delete", {})
            else:
                snapshot = await connection.call("session.activate", {"session_id": session.runtime_id,
                                                                     "omit_messages": True})
                if snapshot.get("running"):
                    raise ValueError("Hermes 会话仍有运行中的回合")
                await connection.call("session.close", {"session_id": session.runtime_id})
                session.connection = None
                await connection.call("session.delete", {"session_id": session.stored_id})
            self._runtime_sessions.pop(session.runtime_id, None)
            for cache in (self._sessions, self._session_cwds, self._history, self._context_usage,
                          self._model_by_session, self._effort_current):
                cache.pop(session_id, None)

    async def compact_session(self, *, session_id: str) -> dict[str, Any]:
        connection = await self._online()
        async with self._history_lock:
            if session_id in self._active:
                raise ValueError("当前会话已有任务运行中")
            session = await self._session(connection, session_id)
            if self._canonical:
                result = await self._mutate(connection, session, "compress", {}, timeout=120)
                changed = bool(result.get("target_session_id"))
            else:
                result = await connection.call("session.compress", {"session_id": session.runtime_id}, timeout=120)
                changed = bool(result.get("compressed"))
            if not changed:
                return {"supported": True}
            rows = await self._read_transcript(connection, session)
            session.transcript = rows
            for row in reversed(rows):
                if row.get("systemEvents"):
                    return compaction_frame(row)
        summary = result.get("summary")
        return compaction_frame(compaction_record(uuid4().hex, summary=summary if isinstance(summary, str) else ""))

    async def send_prompt(
        self,
        *,
        session_id: str,
        text: str,
        request_id: str,
        emit: EventEmitter,
        request_approval: ApprovalCallback,
        attachments: list[dict[str, Any]] | None = None,
        options: dict[str, Any] | None = None,
    ) -> None:
        sid = session_id
        connection = await self._online()
        turn = _Turn(request_id, emit, request_approval)
        async with self._history_lock:
            if sid in self._active:
                raise ValueError("当前会话已有任务运行中")
            session = await self._session(connection, sid)
            if not self._canonical:
                snapshot = await connection.call("session.activate", {"session_id": session.runtime_id,
                                                                     "omit_messages": True})
                self._remember_snapshot(connection, sid, session, snapshot)
                if snapshot.get("running"):
                    raise ValueError("当前会话已有任务运行中")
            if (options or {}).get("model"):
                await self._set_model(connection, sid, session, str(options["model"]))
            if (effort := str((options or {}).get("effort") or "").strip().lower()) and (
                    effort != self._effort_by_session.get(sid)):
                await self._set_effort(connection, sid, session, effort)
                self._effort_by_session[sid] = effort
            with suppress(JsonRpcError, TimeoutError):
                turn.baseline = _usage_counts(await self._usage(connection, session))
            with suppress(JsonRpcError, TimeoutError):
                session.transcript = await self._read_transcript(connection, session)
            messages = deque(session.transcript, maxlen=_HISTORY_LIMIT)
            self._active[sid] = turn
            self._turns[sid] = (request_id, emit)
            self._save_history(sid, messages)
            messages.append({"role": "user", "text": text, "runId": request_id})
        try:
            await self._emit_turn(sid, turn, {"type": "Accepted", "provider": self.provider,
                                              **self.session_effort_fields(sid), **self.session_model_fields(sid)})
            canonical = self._canonical
            params = {"session_id": session.runtime_id, "text": merge_prompt_with_attachments(text, attachments)}
            if canonical:
                params["submission_id"] = request_id
            else:
                # Another viewer may start a turn after activate. Never redirect
                # that viewer's active generation as a side effect of send.
                params["queued"] = True
            try:
                receipt = await connection.call("prompt.submit", params)
            except (ConnectionError, TimeoutError):
                if not canonical:
                    raise ConnectionError("Hermes 连接中断，无法确认是否接收了消息") from None
                # The owner keys admissions on submission_id, so an ambiguous
                # delivery can be looked up by retrying the exact same input.
                connection = await self._online(timeout=30)
                if not self._canonical or session.connection is not connection:
                    raise ConnectionError("Hermes 重连后无法确认是否接收了消息") from None
                receipt = await connection.call("prompt.submit", {**params, "session_id": session.runtime_id})
            turn.admission_id = str(receipt.get("admission_id") or "")
            turn.generation = receipt.get("execution_generation")
            turn.legacy_queued = not canonical and receipt.get("status") == "queued"
            turn.admitted.set()
            if receipt.get("voice_stopped") or receipt.get("status") == "stopped":
                await self._emit_turn(sid, turn, {"type": "Completed"})
                return
            if canonical and not turn.admission_id:
                raise RuntimeError("Hermes 未返回回合接收回执")
            if canonical and receipt.get("status") in ("unknown", "terminal"):
                receipt = await connection.call("prompt.receipt", {
                    "session_id": session.runtime_id, "admission_id": turn.admission_id, "include_result": True,
                })
                self._recover_receipt(turn, receipt)

            while not await self._handle_event(sid, session, turn, await turn.events.get()):
                pass
        finally:
            self._active.pop(sid, None)
            self._turns.pop(sid, None)
            turn.admitted.set()
            for task in turn.approval_tasks.values():
                task.cancel()
            await asyncio.gather(*turn.approval_tasks.values(), return_exceptions=True)

    @staticmethod
    async def _emit_turn(sid: str, turn: _Turn, event: dict[str, Any]) -> None:
        await turn.emit({**event, "sessionId": sid, "runId": turn.request_id, "requestId": turn.request_id})

    async def steer(self, *, session_id: str, text: str) -> bool:
        if not (turn := self._active.get(session_id)) or not text.strip():
            return False
        await turn.admitted.wait()
        connection = await self._online()
        if self._active.get(session_id) is not turn:
            return False
        session = self._sessions[session_id]
        if session.connection is not connection or turn.legacy_queued:
            return False
        params = {"session_id": session.runtime_id, "text": text}
        if self._canonical:
            if turn.generation is None:
                return False
            params["execution_generation"] = turn.generation
        try:
            result = await connection.call("session.steer", params)
        except JsonRpcError as exc:
            if exc.code == 4010 or exc.message in ("session_idle", "stale_generation", "steer_unavailable"):
                return False
            raise
        return result.get("status") == "queued"

    async def cancel(self, *, session_id: str, run_id: str | None = None, request_id: str | None = None) -> None:
        turn = self._active.get(session_id)
        if turn is None or any(value and value != turn.request_id for value in (run_id, request_id)):
            return
        await turn.admitted.wait()
        connection = await self._online()
        if self._active.get(session_id) is not turn:
            return
        session = self._sessions[session_id]
        if session.connection is not connection:
            raise ConnectionError("Hermes 会话尚未恢复")
        if turn.legacy_queued:
            raise ValueError("当前 Hermes 连接无法单独取消排队中的回合")
        params = {"session_id": session.runtime_id}
        if self._canonical and turn.generation is None:
            receipt = await connection.call("prompt.cancel", {**params, "admission_id": turn.admission_id})
            self._recover_receipt(turn, receipt)
        else:
            if self._canonical:
                params["execution_generation"] = turn.generation
            await connection.call("session.interrupt", params)

    async def _handle_event(self, sid: str, session: _Session, turn: _Turn, frame: dict[str, Any]) -> bool:
        kind = frame.get("type")
        payload = frame.get("payload") or {}
        if kind == "session.info":
            self._remember_info(sid, session, payload)
            await self._emit_context(sid, turn, payload.get("usage") or {}, metadata=True)
            return False
        if turn.legacy_queued and kind != "_failed":
            if kind != "message.start":
                return False
            turn.legacy_queued = False
        admission_id = frame.get("admission_id") or payload.get("admission_id")
        generation = frame.get("execution_generation", payload.get("execution_generation"))
        if admission_id and admission_id != turn.admission_id:
            return False
        if self._canonical:
            if admission_id and generation is not None:
                turn.generation = generation
            if generation is not None and generation != turn.generation:
                return False
            if turn.generation is None and not admission_id and kind != "_failed":
                return False

        if kind in ("message.delta", "message.token"):
            if text := payload.get("text"):
                await self._append_reply(sid, turn, payload, text)
        elif kind in ("reasoning.delta", "thinking.delta") or (kind == "reasoning.available" and not turn.thought):
            await self._append_delta(sid, turn, payload.get("text"), thought=True)
        elif kind == "message.interim":
            if isinstance(text := payload.get("text"), str) and not payload.get("already_streamed") and text != turn.reply_tail:
                await self._append_delta(sid, turn, text)
            turn.reply_tail = ""
        elif kind in ("tool.start", "tool.progress", "tool.complete"):
            await self._emit_tool(sid, turn, kind, payload)
            if kind == "tool.complete" and isinstance(payload.get("todos"), list):
                await self._emit_turn(sid, turn, build_todo_updated_event(session_id=sid, items=payload["todos"]))
        elif kind == "todo.updated" and isinstance(payload.get("todos"), list):
            await self._emit_turn(sid, turn, build_todo_updated_event(session_id=sid, items=payload["todos"]))
        elif kind == "session.usage":
            if isinstance(payload.get("usage"), dict):
                payload = {**payload, **payload["usage"]}
            session.info["usage"] = payload
            await self._emit_context(sid, turn, payload)
        elif kind == "approval.request":
            self._start_approval(sid, session, turn, payload, frame.get("rpc_id"))
        elif kind in ("approval.settled", "request.cancel"):
            key = str(payload.get("prompt_id") or payload.get("id") or "")
            if task := turn.approval_tasks.get(key):
                task.cancel()
        elif kind in ("message.complete", "_failed"):
            await self._finish_turn(sid, session, turn, payload, failed=kind == "_failed")
            return True
        return False

    async def _append_delta(self, sid: str, turn: _Turn, text: Any, *, thought: bool = False) -> None:
        if not isinstance(text, str) or not text:
            return
        if thought:
            turn.thought += text
        else:
            turn.text += text
            turn.reply_tail += text
        self._record_history_update(self._history[sid], "agent_thought_chunk" if thought else "agent_message_chunk",
                                    text, None, turn.request_id)
        await self._emit_turn(sid, turn, {"type": "ThoughtDelta" if thought else "TextDelta", "text": text})

    async def _append_reply(self, sid: str, turn: _Turn, payload: dict[str, Any], text: str) -> None:
        turn_id, segment, offset = (payload.get(key) for key in ("turn_id", "segment", "offset"))
        if isinstance(turn_id, str) and isinstance(segment, int) and isinstance(offset, int):
            key = (turn_id, segment)
            encoded = text.encode("utf-16-le")
            previous = turn.reply_offsets.get(key, 0)
            if previous and offset < previous:
                text = encoded[(previous - offset) * 2:].decode("utf-16-le", errors="ignore")
            if key not in turn.reply_offsets and turn.reply_offsets:
                turn.reply_tail = ""
            turn.reply_offsets[key] = max(previous, offset + len(encoded) // 2)
        await self._append_delta(sid, turn, text)

    async def _emit_tool(self, sid: str, turn: _Turn, kind: str, payload: dict[str, Any]) -> None:
        if not (call_id := payload.get("tool_id")):
            return
        name = payload.get("name")
        result = payload.get("result")
        error = payload.get("error") or (result.get("error") if isinstance(result, dict) else None)
        status = ("error" if error else "completed") if kind == "tool.complete" else "running"
        duration = payload.get("duration_s")
        duration_ms = int(duration * 1000) if isinstance(duration, (int, float)) else None
        title = payload.get("context")
        output = _tool_output(payload.get("result_text") or result or payload.get("summary"))
        params = dict(session_id=sid, call_id=str(call_id), name=name, title=title, status=status,
                      tool_input=payload.get("args"), output=output, duration_ms=duration_ms,
                      error=_tool_output(error) if error else None)
        update = build_tool_call_update(**params, delta_output=payload.get("message") if kind == "tool.progress" else None)
        if kind != "tool.progress":
            self._record_history_update(self._history[sid], "tool_call" if kind == "tool.start" else "tool_call_update",
                                        None, {key: value for key, value in update.items()
                                               if key not in ("type", "sessionId")}, turn.request_id)
        if kind == "tool.start":
            turn.reply_tail = ""
            await self._emit_turn(sid, turn, {"type": "ToolCall", "callId": str(call_id),
                                              "name": name or "tool", "title": title, "toolKind": None})
        await self._emit_turn(sid, turn, update)

    async def _emit_context(self, sid: str, turn: _Turn, usage: dict[str, Any], *, metadata: bool = False) -> None:
        context = self._context(usage)
        if not metadata and (context is None or context == self._context_usage.get(sid)):
            return
        if context is not None:
            self._context_usage[sid] = context
        fields = {**self.session_effort_fields(sid), **self.session_model_fields(sid)}
        if context or fields:
            await self._emit_turn(sid, turn, {"type": "ContextUsage",
                                              **({"contextUsage": context} if context else {}), **fields})

    def _start_approval(self, sid: str, session: _Session, turn: _Turn,
                        payload: dict[str, Any], rpc_id: Any) -> None:
        key = str(rpc_id or payload.get("prompt_id") or payload.get("request_id") or "")
        if key and (key not in turn.approval_tasks or turn.approval_tasks[key].done()):
            turn.approval_tasks[key] = asyncio.create_task(self._answer_approval(sid, session, turn, key, payload, rpc_id))

    async def _answer_approval(self, sid: str, session: _Session, turn: _Turn, key: str,
                               payload: dict[str, Any], rpc_id: Any) -> None:
        try:
            if key not in turn.approvals:
                timeout = payload.get("timeout_s")
                timeout = min(300, timeout) if isinstance(timeout, (int, float)) and timeout > 0 else 300
                command = str(payload.get("command") or payload.get("description") or "tool action")
                try:
                    async with asyncio.timeout(timeout):
                        decision = await turn.approve(sid, key, command, "medium")
                except TimeoutError:
                    decision = "deny"
                choices = payload.get("choices") or ["once", "session", "deny"]
                choice = "session" if decision == "allow_session" and "session" in choices else (
                    "once" if decision in ("allow_once", "allow_session") and "once" in choices else "deny")
                turn.approvals[key] = choice
            choice = turn.approvals[key]
            connection = await self._online(timeout=30)
            if self._active.get(sid) is not turn or session.connection is not connection:
                return
            if rpc_id is not None:
                await connection.write({"id": rpc_id, "result": {"choice": choice}})
            elif prompt_id := payload.get("prompt_id"):
                await connection.call("approval.respond", {"session_id": session.runtime_id, "prompt_id": prompt_id,
                                                           "execution_generation": payload.get("execution_generation"),
                                                           "choice": choice})
            else:
                await connection.call("approval.respond", {"session_id": session.runtime_id,
                                                           "request_id": payload.get("request_id"), "choice": choice})
        except (JsonRpcError, *_TRANSPORT_ERRORS) as exc:
            _LOG.debug("Hermes approval reply did not settle on this socket: %s", type(exc).__name__)
        except Exception:
            _LOG.exception("Hermes approval callback failed")

    async def _finish_turn(self, sid: str, session: _Session, turn: _Turn,
                           payload: dict[str, Any], *, failed: bool) -> None:
        status = payload.get("status") or payload.get("outcome")
        cancelled = status in ("cancelled", "canceled", "interrupted")
        if cancelled or failed or status in ("error", "failed", "unknown"):
            message = "已中断当前 Hermes 任务" if cancelled else str(
                payload.get("error") or payload.get("warning") or payload.get("text") or "Hermes 回合失败")
            terminal = {"type": "Failed", "code": "cancelled" if cancelled else "node_execution_error", "message": message}
        else:
            terminal = {"type": "Completed"}

        if not turn.thought:
            await self._append_delta(sid, turn, payload.get("reasoning"), thought=True)
        if (terminal["type"] == "Completed" or payload.get("partial") or cancelled) and not (
                payload.get("response_reused") or payload.get("response_previewed")):
            final = payload.get("text")
            if isinstance(final, str) and final and not turn.text.endswith(final):
                if final.startswith(turn.text):
                    await self._append_delta(sid, turn, final[len(turn.text):])
                elif final.startswith(turn.reply_tail):
                    await self._append_delta(sid, turn, final[len(turn.reply_tail):])
        usage = payload.get("usage") or {}
        await self._emit_context(sid, turn, usage)
        counts = _usage_counts(payload["turn_usage"]) if payload.get("turn_usage") else None
        if counts is None and turn.baseline is not None and usage:
            last = session.info.get("usage") or {}
            merged = {**usage}
            if last.get("total") == usage.get("total"):
                merged.update({key: last[key] for key in ("cache_read_tokens", "cache_read") if key in last})
            totals = _usage_counts(merged)
            if totals["totalTokens"] >= turn.baseline["totalTokens"]:
                counts = {key: max(0, value - turn.baseline[key]) for key, value in totals.items()}
        if counts and any(counts.values()):
            await self._emit_turn(sid, turn, build_token_usage_event(
                session_id=sid, run_id=turn.request_id, request_id=turn.request_id, scope="turn",
                input_tokens=counts["inputTokens"], cached_input_tokens=counts["cachedInputTokens"],
                output_tokens=counts["outputTokens"], reasoning_tokens=counts["reasoningTokens"],
                total_tokens=counts["totalTokens"], source="exact",
            ))
        await self._emit_turn(sid, turn, terminal)
