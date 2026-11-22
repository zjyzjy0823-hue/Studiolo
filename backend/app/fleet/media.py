"""Short-lived, single-use Hermes attachment relay scoped to a Fleet session."""

import asyncio
from dataclasses import dataclass
import mimetypes
from tempfile import TemporaryFile
from typing import BinaryIO, Literal
from urllib.parse import quote
from uuid import uuid4

from fastapi import HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.requests import ClientDisconnect

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
    def __init__(self, max_bytes: int, timeout_seconds: int, ticket_seconds: int):
        self.max_bytes = max_bytes
        self.timeout_seconds = timeout_seconds
        self.ticket_seconds = ticket_seconds
        self.transfers: dict[str, MediaTransfer] = {}

    def reserve(self, scope: tuple[str, int, str], payload: MediaResolveInput) -> str:
        if len(self.transfers) >= MAX_TRANSFERS:
            raise media_error("media_busy")
        transfer_id = uuid4().hex
        timer = asyncio.get_running_loop().call_later(self.timeout_seconds, self.discard, transfer_id)
        self.transfers[transfer_id] = MediaTransfer(scope, payload.sessionId, payload.purpose, timer)
        return transfer_id

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
        if (transfer is None or transfer.file is None or transfer.session_id != result.get("sessionId")
                or transfer.size != result.get("sizeBytes")
                or not isinstance(filename, str) or not 0 < len(filename) <= 255
                or filename in (".", "..") or any(c in "/\\" or ord(c) < 32 or ord(c) == 127 for c in filename)):
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
        if transfer.scope[:2] != (workspace_id, user_id):
            raise media_error("media_forbidden")
        return transfer

    def redeem(self, ticket: str, transfer: MediaTransfer) -> MediaDownload:
        transfer.timer.cancel()
        return MediaDownload(self, ticket, transfer)
