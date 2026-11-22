"""Serve an attachment referenced by a Hermes assistant turn through the Core relay."""

import asyncio
from contextlib import contextmanager
from pathlib import Path
import os
import re
import stat
from typing import Any

import httpx

from .config import NodeConfig, ensure_allowed_path

CAPABILITY = "hermes-media-v1"
CHUNK_BYTES = 64 * 1024
_MEDIA_TAG = re.compile(
    r"""[`"']?(?:MEDIA|@file|@image):\s*(?:"([^"]+)"|'([^']+)'|`([^`]+)`|((?:~|/|[A-Za-z]:[/\\]|\.{1,2}[/\\])[^\s`"')]*))[`"']?""",
    re.IGNORECASE,
)
_SESSION_ID = re.compile(r"[A-Za-z0-9_-]{1,128}")
_TRANSFER_ID = re.compile(r"[A-Za-z0-9_-]{32,64}")


class MediaError(Exception):
    """A stable result code that can safely cross the control channel."""


def references_attachment(messages: list[Any], reference: str) -> bool:
    for message in messages:
        if (not isinstance(message, dict) or message.get("role") != "assistant"
                or message.get("display_kind") == "hidden"):
            continue
        content = message.get("content", message.get("text"))
        if isinstance(content, list):
            content = "".join(part["text"] for part in content if isinstance(part, dict)
                              and part.get("type") in ("text", "output_text") and isinstance(part.get("text"), str))
        if isinstance(content, str) and any(
            next(group for group in match.groups() if group is not None).strip() == reference
            for match in _MEDIA_TAG.finditer(content)
        ):
            return True
    return False


@contextmanager
def open_session_file(reference: str, cwd: str, roots: tuple[Path, ...], max_bytes: int):
    """Pin the checked file and disallow symlink swaps during the open."""
    try:
        base = ensure_allowed_path(cwd, roots)
        if not Path(cwd).is_absolute():
            raise MediaError("media_forbidden")
        ref = Path(reference).expanduser()
        is_absolute = ref.is_absolute()
        path = ensure_allowed_path(ref if is_absolute else base / ref, roots)
        if path == base or (not is_absolute and not path.is_relative_to(base)):
            raise MediaError("media_forbidden")

        directories = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        parent = os.open(path.anchor, directories)
        try:
            for component in path.parts[1:-1]:
                child = os.open(component, directories, dir_fd=parent)
                os.close(parent)
                parent = child
            fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        finally:
            os.close(parent)
    except FileNotFoundError:
        raise MediaError("media_missing") from None
    except (OSError, RuntimeError, ValueError):
        raise MediaError("media_forbidden") from None

    with os.fdopen(fd, "rb") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise MediaError("media_forbidden")
        if info.st_size > max_bytes:
            raise MediaError("media_too_large")
        if info.st_size == 0:
            raise MediaError("media_empty")
        yield path, handle, info.st_size


def _require_success(response: httpx.Response) -> None:
    if response.status_code == 200:
        return
    code = {403: "media_forbidden", 404: "media_missing", 413: "media_too_large"}.get(
        response.status_code, "media_upstream_unavailable"
    )
    raise MediaError(code)


async def relay_hermes_attachment(
    config: NodeConfig,
    frame: dict[str, Any],
    node_id: str | None,
    live_history: list[dict[str, Any]],
    *,
    transport: httpx.AsyncBaseTransport | None = None,
    core_transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, Any]:
    settings = config.hermes_media
    if settings is None or not node_id or frame.get("nodeId") != node_id or frame.get("provider") != "hermes":
        raise MediaError("media_forbidden")
    session_id = frame.get("sessionId")
    reference = frame.get("reference")
    transfer_id = frame.get("transferId")
    limit = frame.get("maxBytes")
    if not (isinstance(session_id, str) and _SESSION_ID.fullmatch(session_id)
            and isinstance(reference, str) and 0 < len(reference) <= 4096 and "\x00" not in reference
            and isinstance(transfer_id, str) and _TRANSFER_ID.fullmatch(transfer_id)
            and type(limit) is int and limit > 0):
        raise MediaError("media_forbidden")

    try:
        async with asyncio.timeout(settings.timeout_seconds):
            token = (await asyncio.to_thread(settings.token_file.read_text, encoding="utf-8-sig")).strip()
            if not token or not token.isascii() or any(c.isspace() for c in token):
                raise MediaError("media_upstream_unavailable")
            limits = httpx.Timeout(settings.timeout_seconds, connect=5)
            async with httpx.AsyncClient(
                base_url=settings.base_url, headers={"X-Hermes-Session-Token": token, "Accept-Encoding": "identity"},
                timeout=limits, trust_env=False, transport=transport,
            ) as upstream:
                session_url = f"/api/sessions/{session_id}"
                session = await upstream.get(session_url)
                _require_success(session)
                metadata = session.json()
                if (not isinstance(metadata, dict) or metadata.get("id") != session_id
                        or not isinstance(metadata.get("cwd"), str) or not metadata["cwd"]):
                    raise MediaError("media_forbidden")
                if not references_attachment(live_history, reference):
                    history = await upstream.get(f"{session_url}/messages", params={
                        "limit": 500, "order": "latest", "include_compacted": "true", "inline_images": "false",
                    })
                    _require_success(history)
                    data = history.json()
                    rows = data.get("messages") if isinstance(data, dict) else None
                    # Hermes can project compression ancestors into the requested transcript.
                    # Each attachment must still belong to the original session row.
                    if not isinstance(rows, list) or not references_attachment(
                        [row for row in rows if isinstance(row, dict) and row.get("session_id") == session_id],
                        reference,
                    ):
                        raise MediaError("media_forbidden")

                with open_session_file(reference, metadata["cwd"], config.allowed_roots,
                                       min(limit, settings.max_bytes)) as (path, source, size):
                    async with upstream.stream("GET", "/api/files/download", params={"path": str(path)}) as download:
                        _require_success(download)

                        async def verified_bytes():
                            # Compare each upstream block to the pinned file before sending it to Core.
                            # A path replacement between our check and Hermes' open cannot disclose bytes.
                            sent = 0
                            async for chunk in download.aiter_bytes(CHUNK_BYTES):
                                if sent + len(chunk) > size or chunk != await asyncio.to_thread(source.read, len(chunk)):
                                    raise MediaError("media_changed")
                                sent += len(chunk)
                                yield chunk
                            if sent != size or await asyncio.to_thread(source.read, 1):
                                raise MediaError("media_changed")

                        async with httpx.AsyncClient(timeout=limits, trust_env=False, transport=core_transport) as core:
                            uploaded = await core.put(
                                f"{config.core_url}/api/v1/fleet/media/relay/{transfer_id}",
                                content=verified_bytes(),
                                headers={"Authorization": f"Bearer {config.node_token}", "Content-Length": str(size)},
                            )
                        if uploaded.status_code != 204:
                            raise MediaError("media_relay_failed")
                        return {"fileName": Path(reference).name, "sizeBytes": size}
    except (TimeoutError, httpx.TimeoutException):
        raise MediaError("media_timeout") from None
    except (httpx.HTTPError, OSError, ValueError):
        # HTTPX exceptions may include the complete URL or header values.
        raise MediaError("media_upstream_unavailable") from None
