"""Short-lived, single-use Hermes attachment relay scoped to a Fleet session."""

import asyncio
from collections.abc import Callable
from dataclasses import dataclass
import math
import mimetypes
from tempfile import TemporaryFile
import time
from typing import Any, BinaryIO, Literal
from urllib.parse import quote, urlsplit
from uuid import uuid4

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.requests import ClientDisconnect

from .audit import audit_media_external

CAPABILITY = "hermes-media-v1"
MAX_TRANSFERS = 8
CHUNK_BYTES = 64 * 1024
PREVIEW_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"}
MEDIA_ERRORS = {
    "node_offline": (503, "所属节点未连接"),
    "node_disconnected": (503, "所属节点连接已断开"),
    "media_unsupported": (409, "当前节点未提供预览或下载服务"),
    "media_forbidden": (403, "附件不属于此会话或超出会话可读范围"),
    "media_missing": (404, "会话或附件已不存在"),
    "media_too_large": (413, "附件超过大小上限"),
    "media_empty": (422, "附件是空文件"),
    "media_preview_unsupported": (415, "此附件仅支持下载"),
    "media_timeout": (504, "附件传输超时"),
    "rpc_timeout": (504, "所属节点响应超时"),
    "media_upstream_unavailable": (502, "Hermes 文件服务不可用"),
    "media_relay_failed": (502, "附件中转失败"),
    "media_changed": (409, "附件在读取时发生变化"),
    "media_busy": (503, "附件中转繁忙"),
    "media_ticket_gone": (410, "附件票据已使用或过期"),
    "media_external_no_bytes": (409, "外链附件不接收中继字节流"),
}

MediaPurpose = Literal["preview", "download"]


def media_error(code: str) -> HTTPException:
    status, message = MEDIA_ERRORS[code]
    return HTTPException(status, detail={"code": code, "message": message})


class MediaResolveInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    nodeId: str = Field(min_length=1, max_length=36)
    provider: Literal["hermes"]
    sessionId: str = Field(pattern=r"^[A-Za-z0-9_-]{1,128}$")
    reference: str = Field(min_length=1, max_length=4096)
    purpose: MediaPurpose


class MediaTicketInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ticket: str = Field(pattern=r"^[0-9a-f]{32}$")


def _valid_filename(filename: Any) -> bool:
    return (
        isinstance(filename, str)
        and 0 < len(filename) <= 255
        and filename not in (".", "..")
        and not any(c in "/\\" or ord(c) < 32 or ord(c) == 127 for c in filename)
    )


def _valid_external_url(url: Any) -> str | None:
    if not isinstance(url, str) or not 0 < len(url) <= 4096:
        return None
    if any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in url):
        return None
    try:
        parts = urlsplit(url)
        _ = parts.port
    except ValueError:
        return None
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return None
    if parts.username is not None or parts.password is not None:
        return None
    return url


@dataclass
class MediaTransfer:
    scope: tuple[str, int, str]
    session_id: str
    purpose: MediaPurpose
    timer: asyncio.TimerHandle
    receiving: bool = False
    file: BinaryIO | None = None
    size: int = 0
    filename: str = ""
    content_type: str = ""
    external_url: str | None = None
    expires_at: float | None = None

    @property
    def is_external(self) -> bool:
        return self.external_url is not None


class MediaDownload(StreamingResponse):
    def __init__(self, relay: "MediaRelay", transfer_id: str, transfer: MediaTransfer):
        self.relay = relay
        self.transfer_id = transfer_id
        self.transfer = transfer
        disposition = "inline" if transfer.purpose == "preview" else "attachment"
        super().__init__(
            iter(lambda: transfer.file.read(CHUNK_BYTES), b""),
            media_type=transfer.content_type,
            headers={
                "Content-Length": str(transfer.size),
                "Content-Disposition": f"{disposition}; filename*=UTF-8''{quote(transfer.filename, safe='')}",
                "Cache-Control": "no-store, no-transform",
                "X-Content-Type-Options": "nosniff",
                "Content-Security-Policy": "sandbox",
            },
        )

    async def __call__(self, scope, receive, send):
        try:
            async with asyncio.timeout(self.relay.timeout_seconds):
                await super().__call__(scope, receive, send)
        finally:
            self.relay.discard(self.transfer_id)


class MediaRelay:
    def __init__(
        self,
        max_bytes: int,
        timeout_seconds: int,
        ticket_seconds: int,
        *,
        clock: Callable[[], float] = time.time,
    ):
        self.max_bytes = max_bytes
        self.timeout_seconds = timeout_seconds
        self.ticket_seconds = ticket_seconds
        self._clock = clock
        self.transfers: dict[str, MediaTransfer] = {}

    def reserve(self, scope: tuple[str, int, str], payload: MediaResolveInput) -> str:
        if len(self.transfers) >= MAX_TRANSFERS:
            raise media_error("media_busy")
        transfer_id = uuid4().hex
        timer = asyncio.get_running_loop().call_later(self.timeout_seconds, self.discard, transfer_id)
        self.transfers[transfer_id] = MediaTransfer(scope, payload.sessionId, payload.purpose, timer)
        return transfer_id

    def register_external(
        self,
        scope: tuple[str, int, str],
        session_id: str,
        purpose: MediaPurpose,
        *,
        url: str,
        expires_at: int | float,
        size: int,
        filename: str,
        content_type: str | None = None,
    ) -> str:
        """登记不接收中继字节流的外链型 transfer，返回一次性票据。"""
        if len(self.transfers) >= MAX_TRANSFERS:
            raise media_error("media_busy")
        validated_url = _valid_external_url(url)
        if (
            validated_url is None
            or not _valid_filename(filename)
            or type(size) is not int
            or size <= 0
            or isinstance(expires_at, bool)
            or not isinstance(expires_at, (int, float))
            or not math.isfinite(expires_at)
            or expires_at <= 0
        ):
            raise media_error("media_relay_failed")
        resolved_type = content_type or mimetypes.guess_type(filename)[0] or "application/octet-stream"
        if purpose == "preview" and resolved_type not in PREVIEW_TYPES:
            raise media_error("media_preview_unsupported")
        ticket = uuid4().hex
        timer = asyncio.get_running_loop().call_later(self.ticket_seconds, self.discard, ticket)
        self.transfers[ticket] = MediaTransfer(
            scope=scope,
            session_id=session_id,
            purpose=purpose,
            timer=timer,
            size=size,
            filename=filename,
            content_type=resolved_type,
            external_url=validated_url,
            expires_at=float(expires_at),
        )
        return ticket

    def discard(self, transfer_id: str) -> None:
        transfer = self.transfers.pop(transfer_id, None)
        if transfer:
            transfer.timer.cancel()
            if transfer.file is not None:
                transfer.file.close()

    async def accept_bytes(self, transfer_id: str, actor: tuple[str, str, int, str], request: Request) -> None:
        transfer = self.transfers.get(transfer_id)
        kind, node_id, user_id, workspace_id = actor
        if transfer is None or kind != "node" or transfer.scope != (workspace_id, user_id, node_id):
            raise media_error("media_forbidden")
        if transfer.is_external:
            raise media_error("media_external_no_bytes")
        if transfer.receiving or transfer.file is not None or transfer.filename:
            raise media_error("media_relay_failed")
        length = request.headers.get("content-length", "")
        if not length.isascii() or not length.isdecimal() or len(length) > 12:
            raise media_error("media_relay_failed")
        expected = int(length)
        if expected > self.max_bytes:
            raise media_error("media_too_large")
        if expected == 0:
            raise media_error("media_empty")
        transfer.receiving = True
        file = TemporaryFile(mode="w+b")
        try:
            async with asyncio.timeout_at(transfer.timer.when()):
                size = 0
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > self.max_bytes:
                        raise media_error("media_too_large")
                    if size > expected:
                        raise media_error("media_relay_failed")
                    file.write(chunk)
                if size != expected or self.transfers.get(transfer_id) is not transfer:
                    raise media_error("media_relay_failed")
                file.seek(0)
                transfer.file, transfer.size = file, size
        except TimeoutError:
            raise media_error("media_timeout") from None
        except ClientDisconnect:
            raise media_error("media_relay_failed") from None
        finally:
            transfer.receiving = False
            if transfer.file is not file:
                file.close()

    def issue(self, transfer_id: str, result: dict) -> str:
        transfer = self.transfers.get(transfer_id)
        filename = result.get("fileName")
        if result.get("external") is True:
            validated_url = _valid_external_url(result.get("url"))
            size_bytes = result.get("sizeBytes")
            expires_at = result.get("expiresAt")
            if (
                transfer is None
                or transfer.receiving
                or transfer.file is not None
                or transfer.is_external
                or transfer.session_id != result.get("sessionId")
                or validated_url is None
                or not _valid_filename(filename)
                or type(size_bytes) is not int
                or size_bytes <= 0
                or isinstance(expires_at, bool)
                or not isinstance(expires_at, (int, float))
                or not math.isfinite(expires_at)
                or expires_at <= 0
            ):
                raise media_error("media_relay_failed")
            content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
            if transfer.purpose == "preview" and content_type not in PREVIEW_TYPES:
                raise media_error("media_preview_unsupported")

            ticket = uuid4().hex
            self.transfers.pop(transfer_id)
            transfer.timer.cancel()
            transfer.timer = asyncio.get_running_loop().call_later(self.ticket_seconds, self.discard, ticket)
            transfer.size = size_bytes
            transfer.filename = filename
            transfer.content_type = content_type
            transfer.external_url = validated_url
            transfer.expires_at = float(expires_at)
            self.transfers[ticket] = transfer
            return ticket

        if (transfer is None or transfer.file is None or transfer.is_external
                or transfer.session_id != result.get("sessionId")
                or transfer.size != result.get("sizeBytes")
                or not _valid_filename(filename)):
            raise media_error("media_relay_failed")
        content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        if transfer.purpose == "preview" and content_type not in PREVIEW_TYPES:
            raise media_error("media_preview_unsupported")

        ticket = uuid4().hex
        self.transfers.pop(transfer_id)
        transfer.timer.cancel()
        transfer.timer = asyncio.get_running_loop().call_later(self.ticket_seconds, self.discard, ticket)
        transfer.filename = filename
        transfer.content_type = content_type
        self.transfers[ticket] = transfer
        return ticket

    def get_ticket(self, ticket: str, workspace_id: str, user_id: int) -> MediaTransfer:
        transfer = self.transfers.get(ticket)
        if (transfer is None or not transfer.filename or transfer.timer.cancelled()
                or transfer.timer.when() <= asyncio.get_running_loop().time()):
            raise media_error("media_ticket_gone")
        if transfer.is_external and transfer.expires_at is not None and transfer.expires_at <= self._clock():
            self.discard(ticket)
            raise media_error("media_ticket_gone")
        if transfer.scope[:2] != (workspace_id, user_id):
            raise media_error("media_forbidden")
        return transfer

    def redeem(self, ticket: str, transfer: MediaTransfer, *, as_json: bool = False) -> MediaDownload | RedirectResponse | JSONResponse:
        if transfer.is_external:
            if transfer.expires_at is not None and transfer.expires_at <= self._clock():
                self.discard(ticket)
                raise media_error("media_ticket_gone")
            url = transfer.external_url
            assert url is not None
            size = transfer.size
            expires_at = transfer.expires_at or 0
            session_id = transfer.session_id
            filename = transfer.filename
            self.discard(ticket)
            audit_media_external(session_id=session_id, url=url, size=size, expires_at=expires_at)
            if as_json:
                # fetch(redirect: 'manual') 在浏览器里只会得到 opaque-redirect（状态 0、读不到 Location），
                # 所以给客户端一个显式的 JSON 模式，而不是依赖重定向头。
                return JSONResponse(
                    status_code=200,
                    content={
                        "url": url,
                        "expiresAt": int(expires_at),
                        "sizeBytes": size,
                        "fileName": filename,
                    },
                    headers={"Cache-Control": "no-store"},
                )
            return RedirectResponse(
                url=url,
                status_code=307,
                headers={"Cache-Control": "no-store"},
            )
        transfer.timer.cancel()
        return MediaDownload(self, ticket, transfer)
