"""Serve an attachment referenced by a Hermes assistant turn through the Core relay."""

import asyncio
from collections.abc import Awaitable, Callable, Iterable, Set
from contextlib import contextmanager
from pathlib import Path
import json
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
_WRITE_TOOL_NAMES = ("write", "create", "save", "export")
_TOOL_PATH_KEYS = ("filePath", "path", "file", "target_file", "filename")
_FAILED_TOOL_STATUSES = ("error", "failed", "declined", "cancelled", "canceled")
_COMPLETED_TOOL_STATUSES = ("completed", "succeeded", "done")


class MediaError(Exception):
    """A stable result code that can safely cross the control channel."""


def _assistant_text(message: Any) -> str:
    if (not isinstance(message, dict) or message.get("role") != "assistant"
            or message.get("display_kind") == "hidden"):
        return ""
    content = message.get("content", message.get("text"))
    if isinstance(content, list):
        return "".join(part["text"] for part in content if isinstance(part, dict)
                       and part.get("type") in ("text", "output_text") and isinstance(part.get("text"), str))
    return content if isinstance(content, str) else ""


def references_attachment(messages: list[Any], reference: str) -> bool:
    return any(
        next(group for group in match.groups() if group is not None).strip() == reference
        for message in messages for match in _MEDIA_TAG.finditer(_assistant_text(message))
    )


def written_attachment_paths(messages: Iterable[dict[str, Any]], *, active: bool = False) -> set[str]:
    """Mirror collectMessageInlineAttachments on the merged assistant tool calls."""
    paths: set[str] = set()
    for message in messages:
        body = _assistant_text(message)
        if not body:
            continue
        for tool in message.get("toolCalls") or ():
            status = str(tool.get("status") or "").strip().lower()
            if status in _FAILED_TOOL_STATUSES or (not active and status and status not in _COMPLETED_TOOL_STATUSES):
                continue
            name, arguments = tool.get("name"), tool.get("input")
            if not isinstance(name, str) or not any(verb in name.lower() for verb in _WRITE_TOOL_NAMES):
                continue
            if not isinstance(arguments, dict):
                continue
            raw = next((arguments[key] for key in _TOOL_PATH_KEYS if arguments.get(key) is not None), None)
            if not isinstance(raw, str) or not (path := raw.strip()) or "://" in raw:
                continue
            basename = path.replace("\\", "/").rsplit("/", 1)[-1] or path
            if path in body or basename in body:
                paths.add(path)
    return paths


def _decoded_object(value: Any) -> dict[str, Any]:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return {}
    return value if isinstance(value, dict) else {}


def transcript_attachment_paths(rows: Iterable[Any], session_id: str, *, require_owner: bool = False) -> set[str]:
    """Rebuild live assistant messages from Hermes's persisted tool-call and tool-result rows."""
    paths: set[str] = set()
    body: list[str] = []
    calls: dict[str, dict[str, Any]] = {}
    after_tool = False

    def flush() -> None:
        nonlocal after_tool
        if body and calls:
            paths.update(written_attachment_paths([{"role": "assistant", "text": "\n".join(body),
                                                    "toolCalls": calls.values()}]))
        after_tool = False
        body.clear()
        calls.clear()

    for row in rows:
        if (not isinstance(row, dict) or row.get("session_id", None if require_owner else session_id) != session_id
                or row.get("display_kind") == "hidden" or row.get("row_kind") == "compaction"):
            flush()
            continue
        role = row.get("role")
        if role == "assistant":
            if not after_tool:
                flush()
            # A tool result followed by a reply is one assistant message in the live event stream.
            text = row["text"] if isinstance(row.get("text"), str) else _assistant_text(row)
            if text:
                body.append(text)
            after_tool = False
            tools = row.get("toolCalls") or row.get("tool_calls")
            tools = tools if isinstance(tools, list) else []
            content = row.get("content")
            if isinstance(content, list):
                tools = [*tools, *(part for part in content if isinstance(part, dict)
                                    and part.get("type") in ("tool", "tool_use"))]
            for tool in tools:
                if not isinstance(tool, dict):
                    continue
                call_id = tool.get("callId") or tool.get("toolCallId") or tool.get("id")
                if not isinstance(call_id, str) or not call_id:
                    continue
                function = _decoded_object(tool.get("function"))
                calls[call_id] = {
                    "name": tool.get("name") or function.get("name"),
                    "input": tool.get("input", _decoded_object(function.get("arguments"))),
                    "status": tool.get("status"),
                }
        elif role == "tool":
            call_id = row.get("tool_call_id") or row.get("callId") or row.get("row_id")
            if not isinstance(call_id, (str, int)) or not call_id:
                continue
            tool = calls.setdefault(str(call_id), {})
            name = row.get("name") or row.get("tool_name")
            if name and name != "tool":
                tool["name"] = name
            if row.get("args") is not None:
                tool["input"] = row["args"]
            if row.get("error") or _decoded_object(row.get("content")).get("error"):
                tool["status"] = "error"
            elif str(tool.get("status") or "").strip().lower() not in _FAILED_TOOL_STATUSES:
                tool["status"] = row.get("status") or "completed"
            after_tool = True
        else:
            flush()
    flush()
    return paths


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
    written_paths: Set[str] = frozenset(),
    restore_written_paths: Callable[[str, str], Awaitable[Set[str]]] | None = None,
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
                authorized = references_attachment(live_history, reference) or reference in written_paths
                if (not authorized and restore_written_paths is not None
                        and not metadata.get("parent_session_id") and metadata.get("end_reason") != "compression"):
                    # A stored transcript can include rows of older compression segments without row owners.
                    authorized = reference in await restore_written_paths(session_id, reference)
                if not authorized:
                    history = await upstream.get(f"{session_url}/messages", params={
                        "limit": 500, "order": "latest", "include_compacted": "true", "inline_images": "false",
                    })
                    _require_success(history)
                    data = history.json()
                    rows = data.get("messages") if isinstance(data, dict) else None
                    # Hermes can project compression ancestors into the requested transcript.
                    # Each attachment must still belong to the original session row.
                    if not isinstance(rows, list) or not (
                        references_attachment(
                            [row for row in rows if isinstance(row, dict) and row.get("session_id") == session_id],
                            reference,
                        ) or reference in transcript_attachment_paths(rows, session_id, require_owner=True)
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
