"""Fleet 多设备控制节点管理、加密分块传输及双向 WebSocket 中继路由。"""

import asyncio
from contextlib import contextmanager
from datetime import date
import hashlib
import json
import logging
import mimetypes
from pathlib import Path
import secrets
from typing import Any, Literal
from uuid import uuid4
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.concurrency import run_in_threadpool
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import AgentNode, User, utcnow
from ..security import authenticate_node_token, authenticate_user_jwt, bearer, current_user
from ..utils.time import iso_utc
from ..workspaces import get_personal_workspace
from . import blobs, media, usage
from .hub import ALLOWED_NODE_EVENTS, SESSION_EVENTS_V1, ConnectedNode, fleet_hub, supports_session_events
from .schemas import (
    AdapterInfo,
    BlobCommitInput,
    BlobEndpointsOut,
    BlobInitInput,
    BlobOut,
    MAX_CHUNK_BYTES,
    NodeCreateInput,
    NodeHelloPayload,
    NodeOut,
    NodePatchInput,
    NodeTokenOut,
    SessionEventsSinceInput,
    SessionListInput,
    SessionOlderInput,
    SessionSnapshotInput,
    SubscriptionQuota,
    TransferEndpoint,
    valid_uuid,
)

router = APIRouter(prefix="/api/v1/fleet", tags=["fleet"])
ws_router = APIRouter(tags=["fleet-ws"])
logger = logging.getLogger(__name__)


def _node_to_out(item: AgentNode, *, live_online: bool | None = None) -> NodeOut:
    status = "online" if live_online else ("revoked" if item.revoked_at is not None else item.runtime_status)
    return NodeOut(
        id=item.id,
        workspaceId=item.workspace_id,
        name=item.name,
        platform=item.platform,
        hostname=item.hostname,
        status=status,
        tokenLast4=item.token_last4,
        tokenCreatedAt=iso_utc(item.token_created_at) if item.token_created_at else None,
        revokedAt=iso_utc(item.revoked_at) if item.revoked_at else None,
        allowedRoots=list(item.allowed_roots_json or []),
        adapters=[AdapterInfo.model_validate(a) for a in (item.adapters_json or [])],
        transferEndpoints=[TransferEndpoint.model_validate(e) for e in (item.transfer_endpoints_json or [])],
        lastSeenAt=iso_utc(item.last_seen_at) if item.last_seen_at else None,
        createdAt=iso_utc(item.created_at),
        updatedAt=iso_utc(item.updated_at),
    )


def _owned_node(db: Session, workspace_id: str, node_id: str) -> AgentNode:
    try:
        valid_id = valid_uuid(node_id)
    except ValueError as exc:
        raise HTTPException(404, "Node not found") from exc
    node = db.scalar(select(AgentNode).where(AgentNode.id == valid_id, AgentNode.workspace_id == workspace_id))
    if node is None:
        raise HTTPException(404, "Node not found")
    return node


def _fleet_actor(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: Session = Depends(get_db),
) -> tuple[str, str, int, str]:
    """统一鉴权依赖：允许工作区内的用户 JWT 或有效 sn_live_ 节点凭证存取分块文件。"""
    if credentials is None:
        raise HTTPException(401, "Authentication required")
    secret = credentials.credentials
    if secret.startswith("sn_live_"):
        node = authenticate_node_token(secret, db)
        if node is None:
            raise HTTPException(401, "Invalid node credential")
        return ("node", node.id, node.user_id, node.workspace_id)
    user = authenticate_user_jwt(secret, db)
    if user is None:
        raise HTTPException(401, "Invalid or expired token")
    workspace = get_personal_workspace(db, user)
    return ("user", str(user.id), user.id, workspace.id)


@router.post("/_debug/client-log", status_code=204)
def client_debug_log(payload: dict[str, Any], user: User = Depends(current_user)) -> Response:
    """客户端调试上报：把 JSON 追加写入 ~/.hermes/logs/studiolo-client-debug.log（排查用）。"""
    log_path = Path.home() / ".hermes" / "logs" / "studiolo-client-debug.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False) + "\n")
    return Response(status_code=204)


INBOX_DIR_NAME = ".studiolo-inbox"
INBOX_PREVIEW_SUFFIXES = {
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".heic",
    ".pdf", ".txt", ".md", ".csv", ".json", ".zip",
}
INBOX_PREVIEW_MAX_BYTES = 20 * 1024 * 1024


@router.get("/inbox/preview")
def inbox_preview(
    node_id: str,
    path: str,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> FileResponse:
    """把 agent-node 解密后落在 <workspace>/.studiolo-inbox 的文件回传给客户端预览。

    安全边界：节点必须属于当前用户；文件必须真实存在、位于 .studiolo-inbox 内、
    在节点上报的 allowedRoots 之内（未上报时退化为仅校验 inbox 目录），扩展名白名单。
    """
    node = db.scalar(select(AgentNode).where(AgentNode.id == node_id, AgentNode.user_id == user.id))
    if node is None:
        raise HTTPException(404, "Not found")
    try:
        target = Path(path).expanduser().resolve(strict=True)
    except (OSError, RuntimeError):
        raise HTTPException(404, "Not found")
    if not target.is_file() or INBOX_DIR_NAME not in target.parts:
        raise HTTPException(404, "Not found")
    if target.stat().st_size > INBOX_PREVIEW_MAX_BYTES:
        raise HTTPException(400, "File too large")
    roots = [str(item) for item in (node.allowed_roots_json or []) if str(item).strip()]
    if roots:
        allowed = False
        for root in roots:
            try:
                root_path = Path(root).expanduser().resolve(strict=True)
            except (OSError, RuntimeError):
                continue
            if target == root_path or root_path in target.parents:
                allowed = True
                break
        if not allowed:
            raise HTTPException(404, "Not found")
    suffix = target.suffix.lower()
    if suffix not in INBOX_PREVIEW_SUFFIXES:
        raise HTTPException(400, "Unsupported file type")
    media_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    return FileResponse(
        target,
        media_type=media_type,
        headers={"Cache-Control": "private, max-age=86400"},
    )


@router.get("/nodes", response_model=list[NodeOut])
async def list_nodes(user: User = Depends(current_user), db: Session = Depends(get_db)):
    workspace = get_personal_workspace(db, user)
    rows = db.scalars(
        select(AgentNode).where(AgentNode.workspace_id == workspace.id).order_by(AgentNode.created_at.desc())
    ).all()
    out: list[NodeOut] = []
    for item in rows:
        online = await fleet_hub.get_online_node(workspace.id, item.id)
        out.append(_node_to_out(item, live_online=online is not None))
    return out


@router.get("/usage/daily")
def usage_daily(
    start: date, end: date, tz: str = Query(default="UTC", max_length=64),
    user: User = Depends(current_user), db: Session = Depends(get_db),
):
    if not date.min < start <= end < date.max or (end - start).days >= 31:
        raise HTTPException(422, "Invalid usage date range (maximum 31 days)")
    try:
        zone = ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise HTTPException(422, "Invalid time zone") from exc
    workspace = get_personal_workspace(db, user)
    return usage.daily_totals(db, workspace.id, start, end, zone)


@router.post("/nodes/{node_id}/subscription-quota", response_model=SubscriptionQuota)
async def read_subscription_quota(
    node_id: str, provider: Literal["codex", "opencode"] = "codex",
    user: User = Depends(current_user), db: Session = Depends(get_db),
):
    workspace = get_personal_workspace(db, user)
    node = _owned_node(db, workspace.id, node_id)
    connected = await fleet_hub.get_online_node(workspace.id, node.id)
    if connected is None or node.revoked_at is not None:
        return SubscriptionQuota(status="offline")
    if not any(
        adapter.get("provider") == provider and "subscription-quota" in adapter.get("capabilities", [])
        and (provider == "opencode" or adapter.get("status") == "ready")
        for adapter in connected.adapters
    ):
        return SubscriptionQuota(status="unsupported")
    result = await fleet_hub.call_node_rpc(
        workspace.id, node.id, {"type": "subscription.quota.read", "provider": provider}, timeout=10,
    )
    if result.get("code") in ("node_offline", "node_disconnected"):
        return SubscriptionQuota(status="offline")
    try:
        return SubscriptionQuota.model_validate(result)
    except ValidationError:
        return SubscriptionQuota(status="unavailable")


async def _session_replay_rpc(
    node_id: str, method: str, payload: SessionSnapshotInput | SessionEventsSinceInput | SessionListInput | SessionOlderInput,
    user: User, db: Session, response: Response,
) -> dict[str, Any]:
    workspace = get_personal_workspace(db, user)
    node = _owned_node(db, workspace.id, node_id)
    response.headers["Cache-Control"] = "no-store"
    if node.revoked_at is not None:
        return {"ok": False, "code": "node_offline", "error": "Target device node is offline"}
    # Session RPC results are opaque to Core, including the owner-generated epoch and seq.
    return await fleet_hub.call_node_rpc(
        workspace.id, node.id, {"type": method, **payload.model_dump(exclude_none=True)}, timeout=45,
    )


@router.post("/nodes/{node_id}/session/snapshot", response_model=None)
async def session_snapshot(
    node_id: str, payload: SessionSnapshotInput, response: Response,
    user: User = Depends(current_user), db: Session = Depends(get_db),
) -> dict[str, Any]:
    return await _session_replay_rpc(node_id, "session.snapshot", payload, user, db, response)


@router.post("/nodes/{node_id}/session/older", response_model=None)
async def session_older(
    node_id: str, payload: SessionOlderInput, response: Response,
    user: User = Depends(current_user), db: Session = Depends(get_db),
) -> dict[str, Any]:
    """P10：按 beforeCursor 翻更早一页（窗口化后的向上分页）。"""
    return await _session_replay_rpc(node_id, "session.older", payload, user, db, response)


@router.post("/nodes/{node_id}/session/events/since", response_model=None)
async def session_events_since(
    node_id: str, payload: SessionEventsSinceInput, response: Response,
    user: User = Depends(current_user), db: Session = Depends(get_db),
) -> dict[str, Any]:
    return await _session_replay_rpc(node_id, "session.events.since", payload, user, db, response)


@router.post("/nodes/{node_id}/session/processes", response_model=None)
async def session_processes(
    node_id: str, payload: SessionListInput, response: Response,
    user: User = Depends(current_user), db: Session = Depends(get_db),
) -> dict[str, Any]:
    return await _session_replay_rpc(node_id, "session.processes", payload, user, db, response)


@router.post("/nodes/{node_id}/session/subagents", response_model=None)
async def session_subagents(
    node_id: str, payload: SessionListInput, response: Response,
    user: User = Depends(current_user), db: Session = Depends(get_db),
) -> dict[str, Any]:
    return await _session_replay_rpc(node_id, "session.subagents", payload, user, db, response)


@router.post("/nodes", status_code=201, response_model=NodeTokenOut)
def create_node(payload: NodeCreateInput, user: User = Depends(current_user), db: Session = Depends(get_db)):
    workspace = get_personal_workspace(db, user)
    now = utcnow()
    plaintext = "sn_live_" + secrets.token_urlsafe(32)
    node = AgentNode(
        id=str(uuid4()),
        user_id=user.id,
        workspace_id=workspace.id,
        name=payload.name,
        platform=payload.platform,
        hostname=payload.hostname,
        token_hash=hashlib.sha256(plaintext.encode()).hexdigest(),
        token_last4=plaintext[-4:],
        token_created_at=now,
        runtime_status="offline",
        created_at=now,
        updated_at=now,
    )
    db.add(node)
    db.commit()
    db.refresh(node)
    return NodeTokenOut(node=_node_to_out(node, live_online=False), nodeToken=plaintext)


@router.patch("/nodes/{node_id}", response_model=NodeOut)
async def update_node(
    node_id: str,
    payload: NodePatchInput,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    workspace = get_personal_workspace(db, user)
    node = _owned_node(db, workspace.id, node_id)
    if payload.name is not None:
        node.name = payload.name
    if payload.platform is not None:
        node.platform = payload.platform
    if payload.hostname is not None:
        node.hostname = payload.hostname
    node.updated_at = utcnow()
    db.commit()
    db.refresh(node)
    online = await fleet_hub.get_online_node(workspace.id, node.id)
    return _node_to_out(node, live_online=online is not None)


@router.post("/nodes/{node_id}/token", response_model=NodeTokenOut)
async def rotate_node_token(node_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    workspace = get_personal_workspace(db, user)
    node = _owned_node(db, workspace.id, node_id)
    await fleet_hub.kick_node(workspace.id, node.id, reason="token_rotated")
    plaintext = "sn_live_" + secrets.token_urlsafe(32)
    now = utcnow()
    node.token_hash = hashlib.sha256(plaintext.encode()).hexdigest()
    node.token_last4 = plaintext[-4:]
    node.token_created_at = now
    node.revoked_at = None
    node.runtime_status = "offline"
    node.updated_at = now
    db.commit()
    db.refresh(node)
    return NodeTokenOut(node=_node_to_out(node, live_online=False), nodeToken=plaintext)


@router.post("/nodes/{node_id}/revoke", response_model=NodeOut)
async def revoke_node_token(node_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    workspace = get_personal_workspace(db, user)
    node = _owned_node(db, workspace.id, node_id)
    await fleet_hub.kick_node(workspace.id, node.id, reason="token_revoked")
    now = utcnow()
    node.token_hash = None
    node.token_last4 = None
    node.revoked_at = now
    node.runtime_status = "offline"
    node.updated_at = now
    db.commit()
    db.refresh(node)
    return _node_to_out(node, live_online=False)


@router.delete("/nodes/{node_id}", status_code=204)
async def delete_node(node_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    workspace = get_personal_workspace(db, user)
    node = _owned_node(db, workspace.id, node_id)
    await fleet_hub.kick_node(workspace.id, node.id, reason="node_deleted")
    db.delete(node)
    db.commit()
    return Response(status_code=204)


@router.post("/media/resolve")
async def resolve_hermes_media(
    payload: media.MediaResolveInput, request: Request, response: Response,
    user: User = Depends(current_user), db: Session = Depends(get_db),
):
    workspace = get_personal_workspace(db, user)
    node = _owned_node(db, workspace.id, payload.nodeId)
    if node.user_id != user.id:
        raise HTTPException(404, "Node not found")
    scope = (workspace.id, user.id, node.id)
    if node.revoked_at is not None:
        raise media.media_error("node_offline")
    db.close()
    connected = await fleet_hub.get_online_node(scope[0], scope[2])
    if connected is None:
        raise media.media_error("node_offline")
    if not any(
        adapter.get("provider") == "hermes" and media.CAPABILITY in adapter.get("capabilities", [])
        for adapter in connected.adapters
    ):
        raise media.media_error("media_unsupported")

    relay: media.MediaRelay = request.app.state.hermes_media
    transfer_id = relay.reserve(scope, payload)
    try:
        result = await fleet_hub.call_node_rpc(scope[0], scope[2], {
            "type": "hermes.media.relay",
            **payload.model_dump(),
            "nodeId": scope[2],
            "transferId": transfer_id,
            "maxBytes": relay.max_bytes,
        }, timeout=relay.timeout_seconds)
        # Fleet chat is scoped to the user's personal workspace. The authenticated
        # owning node is authoritative for native session and attachment membership.
        if result.get("ok") is not True or result.get("type") != "HermesMediaResult":
            code = result.get("code")
            raise media.media_error(code if isinstance(code, str) and code in media.MEDIA_ERRORS else "media_relay_failed")
        ticket = relay.issue(transfer_id, result)
        response.headers["Cache-Control"] = "no-store"
        return {"ticket": ticket, "expiresIn": relay.ticket_seconds, "sizeBytes": result["sizeBytes"]}
    finally:
        relay.discard(transfer_id)


@router.put("/media/relay/{transfer_id}", status_code=204)
async def accept_hermes_media_bytes(
    transfer_id: str, request: Request,
    actor: tuple[str, str, int, str] = Depends(_fleet_actor), db: Session = Depends(get_db),
):
    db.close()
    relay: media.MediaRelay = request.app.state.hermes_media
    await relay.accept_bytes(transfer_id, actor, request)
    return Response(status_code=204)


@router.post("/media/redeem")
async def redeem_hermes_media(
    payload: media.MediaTicketInput, request: Request,
    user: User = Depends(current_user), db: Session = Depends(get_db),
):
    workspace = get_personal_workspace(db, user)
    relay: media.MediaRelay = request.app.state.hermes_media
    transfer = relay.get_ticket(payload.ticket, workspace.id, user.id)
    node = _owned_node(db, workspace.id, transfer.scope[2])
    if node.user_id != user.id or node.revoked_at is not None:
        raise media.media_error("media_forbidden")
    db.close()
    as_json = request.headers.get("x-studiolo-media-link", "").strip() == "1"
    return relay.redeem(payload.ticket, transfer, as_json=as_json)


# ---------------- 加密分块文件总线（/chat 附件与后续 Shared Space 共用） ----------------


@router.post("/artifacts/init", status_code=201, response_model=BlobEndpointsOut)
async def init_artifact(
    payload: BlobInitInput,
    actor: tuple[str, str, int, str] = Depends(_fleet_actor),
    db: Session = Depends(get_db),
):
    actor_kind, actor_id, user_id, workspace_id = actor
    blob = blobs.init_blob(
        db,
        user_id=user_id,
        workspace_id=workspace_id,
        uploader_kind=actor_kind,
        uploader_id=actor_id,
        payload=payload,
    )
    return BlobEndpointsOut(
        blob=blobs.blob_to_out(blob),
        endpoints=blobs.build_resolved_endpoints(blob, actor_id=actor_id),
    )


@router.put("/artifacts/{artifact_id}/chunks/{index}")
async def upload_artifact_chunk(
    artifact_id: str,
    index: int,
    request: Request,
    x_chunk_sha256: str | None = Header(default=None),
    actor: tuple[str, str, int, str] = Depends(_fleet_actor),
    db: Session = Depends(get_db),
):
    _, _, _, workspace_id = actor
    blob = blobs.get_workspace_blob(db, workspace_id, artifact_id)
    raw = await request.body()
    if len(raw) > MAX_CHUNK_BYTES:
        raise HTTPException(413, "Chunk exceeds maximum limit")
    written = blobs.store_chunk(blob, index, raw, expected_sha256=x_chunk_sha256)
    return {"artifactId": blob.id, "chunkIndex": index, "bytesWritten": written}


@router.post("/artifacts/{artifact_id}/commit", response_model=BlobOut)
def commit_artifact(
    artifact_id: str,
    payload: BlobCommitInput | None = None,
    actor: tuple[str, str, int, str] = Depends(_fleet_actor),
    db: Session = Depends(get_db),
):
    _, _, _, workspace_id = actor
    blob = blobs.get_workspace_blob(db, workspace_id, artifact_id)
    committed = blobs.commit_blob(db, blob, payload)
    return blobs.blob_to_out(committed)


@router.get("/artifacts/{artifact_id}", response_model=BlobOut)
def get_artifact(
    artifact_id: str,
    actor: tuple[str, str, int, str] = Depends(_fleet_actor),
    db: Session = Depends(get_db),
):
    _, _, _, workspace_id = actor
    return blobs.blob_to_out(blobs.get_workspace_blob(db, workspace_id, artifact_id))


@router.get("/artifacts/{artifact_id}/endpoints", response_model=BlobEndpointsOut)
async def get_artifact_endpoints(
    artifact_id: str,
    actor: tuple[str, str, int, str] = Depends(_fleet_actor),
    db: Session = Depends(get_db),
):
    _, actor_id, _, workspace_id = actor
    blob = blobs.get_workspace_blob(db, workspace_id, artifact_id)
    peer_eps: list[TransferEndpoint] = []
    if blob.uploader_kind == "node":
        online = await fleet_hub.get_online_node(workspace_id, blob.uploader_id)
        if online is not None:
            peer_eps = [TransferEndpoint.model_validate(ep) for ep in online.transfer_endpoints]
    return BlobEndpointsOut(
        blob=blobs.blob_to_out(blob),
        endpoints=blobs.build_resolved_endpoints(blob, actor_id=actor_id, peer_endpoints=peer_eps),
    )


@router.get("/artifacts/{artifact_id}/chunks/{index}")
def download_artifact_chunk(
    artifact_id: str,
    index: int,
    range_header: str | None = Header(default=None, alias="Range"),
    actor: tuple[str, str, int, str] = Depends(_fleet_actor),
    db: Session = Depends(get_db),
):
    _, _, _, workspace_id = actor
    blob = blobs.get_workspace_blob(db, workspace_id, artifact_id)
    return blobs.stream_chunk_response(blob, index, range_header=range_header)


@router.delete("/artifacts/{artifact_id}", status_code=204)
def delete_artifact(
    artifact_id: str,
    actor: tuple[str, str, int, str] = Depends(_fleet_actor),
    db: Session = Depends(get_db),
):
    _, _, _, workspace_id = actor
    blob = blobs.get_workspace_blob(db, workspace_id, artifact_id)
    blobs.delete_blob(db, blob)
    return Response(status_code=204)


# ---------------- WebSocket 实时控制面中继（零聊天正文持久化） ----------------


@contextmanager
def _open_ws_db(websocket: WebSocket):
    """按请求获取短生命周期数据库会话，兼容 dependency_overrides[get_db] 并避免阻塞连接池。"""
    provider = websocket.app.dependency_overrides.get(get_db, get_db)
    gen = provider()
    db = next(gen)
    try:
        yield db
    finally:
        gen.close()


def _persist_node_usage(websocket: WebSocket, workspace_id: str, node_id: str, frame: dict) -> None:
    try:
        with _open_ws_db(websocket) as db:
            usage.record_frame(db, workspace_id, node_id, frame)
    except SQLAlchemyError:
        logger.warning("Could not persist Fleet usage for node %s", node_id)


async def _recv_first_auth_frame(websocket: WebSocket) -> dict[str, Any] | None:
    try:
        frame = await asyncio.wait_for(websocket.receive_json(), timeout=5.0)
    except Exception:
        return None
    if not isinstance(frame, dict) or frame.get("type") != "auth":
        return None
    return frame


@ws_router.websocket("/ws/fleet/node")
async def fleet_node_ws(websocket: WebSocket):
    """AgentNode 反向认证长连入口（禁止在 Query 参数中传 Token）。"""
    if websocket.query_params.get("token"):
        await websocket.close(code=4401, reason="Token must not be passed in URL query")
        return

    await websocket.accept()
    auth_header = websocket.headers.get("authorization", "")
    token = auth_header[7:].strip() if auth_header.lower().startswith("bearer ") else ""
    hello_raw: dict[str, Any] = {}
    if not token:
        frame = await _recv_first_auth_frame(websocket)
        if frame is None:
            await websocket.close(code=4401, reason="Missing auth frame")
            return
        token = str(frame.get("token") or "")
        if isinstance(frame.get("hello"), dict):
            hello_raw = frame["hello"]

    try:
        hello = NodeHelloPayload.model_validate(hello_raw)
    except ValidationError:
        await websocket.close(code=4400, reason="Invalid node hello metadata")
        return

    with _open_ws_db(websocket) as db:
        node = authenticate_node_token(token, db)
        if node is None:
            await websocket.close(code=4401, reason="Invalid node credential")
            return
        now = utcnow()
        if hello.hostname is not None:
            node.hostname = hello.hostname
        if hello.platform is not None:
            node.platform = hello.platform
        if hello.allowedRoots:
            node.allowed_roots_json = hello.allowedRoots
        if hello.adapters:
            node.adapters_json = [item.model_dump(mode="json") for item in hello.adapters]
        if hello.transferEndpoints:
            node.transfer_endpoints_json = [item.model_dump(mode="json") for item in hello.transferEndpoints]
        node.runtime_status = "online"
        node.last_seen_at = now
        node.updated_at = now
        db.commit()
        node_id = node.id
        workspace_id = node.workspace_id
        user_id = node.user_id
        node_name = node.name
        node_platform = node.platform
        adapters = list(node.adapters_json or [])
        roots = list(node.allowed_roots_json or [])
        endpoints = list(node.transfer_endpoints_json or [])

    conn = ConnectedNode(
        node_id=node_id,
        workspace_id=workspace_id,
        user_id=user_id,
        name=node_name,
        platform=node_platform,
        websocket=websocket,
        adapters=adapters,
        allowed_roots=roots,
        transfer_endpoints=endpoints,
    )
    await fleet_hub.register_node(conn)
    await websocket.send_json({
        "type": "NodeReady", "nodeId": node_id, "workspaceId": workspace_id,
        "serverCapabilities": [SESSION_EVENTS_V1],
    })

    try:
        while True:
            frame = await websocket.receive_json()
            if not isinstance(frame, dict):
                continue
            evt_type = str(frame.get("type") or "")
            if evt_type not in ALLOWED_NODE_EVENTS:
                continue
            if evt_type == "NodeHeartbeat":
                with _open_ws_db(websocket) as db:
                    item = db.get(AgentNode, node_id)
                    if item is None or item.revoked_at is not None:
                        await websocket.close(code=4401, reason="Credential revoked")
                        break
                    item.last_seen_at = utcnow()
                    if isinstance(frame.get("adapters"), list):
                        validated = [AdapterInfo.model_validate(a).model_dump(mode="json") for a in frame["adapters"]]
                        item.adapters_json = validated
                        conn.adapters = validated
                    if isinstance(frame.get("transferEndpoints"), list):
                        validated_ep = [TransferEndpoint.model_validate(e).model_dump(mode="json") for e in frame["transferEndpoints"]]
                        item.transfer_endpoints_json = validated_ep
                        conn.transfer_endpoints = validated_ep
                    db.commit()
                continue

            if evt_type in ("CronRpcResult", "SubscriptionQuotaResult", "HermesMediaResult", "SessionReplayResult"):
                rpc_id = str(frame.get("_rpcId") or "").strip()
                payload = frame.get("result") if evt_type == "SessionReplayResult" else frame
                if rpc_id and isinstance(payload, dict):
                    await fleet_hub.resolve_node_rpc(workspace_id, node_id, rpc_id, payload)
                continue

            if evt_type == "TokenUsage" or (evt_type == "Completed" and isinstance(frame.get("usage"), dict)):
                await run_in_threadpool(_persist_node_usage, websocket, workspace_id, node_id, frame)

            target_client_id = frame.pop("_clientConnId", None)
            outbound = {**frame, "nodeId": node_id}
            await fleet_hub.broadcast_node_event(
                workspace_id,
                outbound,
                target_client_id=target_client_id if evt_type in (
                    "SessionsSnapshot",
                    "SessionHistory",
                    "ContextSnapshot",
                    "SessionStreamReplay",
                    "ActiveRunsSnapshot",
                    "RunStopStatus",
                    "TerminalPreview",
                    "DuplicateIgnored",
                    "ModelsSnapshot",
                    "AgentsSnapshot",
                    "McpSnapshot",
                    "RulesSnapshot",
                    "FilesSnapshot",
                    "FilesTreeSnapshot",
                    "FileContentSnapshot",
                    "TrustPolicySnapshot",
                    "DiffSnapshot",
                ) else None,
            )
    except WebSocketDisconnect:
        pass
    finally:
        await fleet_hub.unregister_node(workspace_id, node_id, websocket)
        with _open_ws_db(websocket) as db:
            item = db.get(AgentNode, node_id)
            if item is not None:
                item.runtime_status = "offline"
                item.updated_at = utcnow()
                db.commit()


@ws_router.websocket("/ws/fleet/client")
async def fleet_client_ws(websocket: WebSocket):
    """桌面端/移动端浏览器 Fleet 控制台双向 WS（首帧 JWT 鉴权）。"""
    if websocket.query_params.get("token"):
        await websocket.close(code=4401, reason="Token must not be passed in URL query")
        return

    await websocket.accept()
    auth_header = websocket.headers.get("authorization", "")
    token = auth_header[7:].strip() if auth_header.lower().startswith("bearer ") else ""
    session_events_v1 = False
    if not token:
        frame = await _recv_first_auth_frame(websocket)
        if frame is None:
            await websocket.close(code=4401, reason="Missing auth frame")
            return
        token = str(frame.get("token") or "")
        session_events_v1 = supports_session_events(frame.get("capabilities"))

    with _open_ws_db(websocket) as db:
        user = authenticate_user_jwt(token, db)
        if user is None:
            await websocket.close(code=4401, reason="Invalid or expired token")
            return
        workspace_id = get_personal_workspace(db, user).id

    conn_id = await fleet_hub.register_client(workspace_id, websocket, session_events_v1=session_events_v1)
    try:
        while True:
            frame = await websocket.receive_json()
            if not isinstance(frame, dict):
                continue
            error_reply = await fleet_hub.forward_client_command(workspace_id, conn_id, frame)
            if error_reply is not None:
                await fleet_hub.broadcast_workspace(workspace_id, error_reply, target_client_id=conn_id)
    except WebSocketDisconnect:
        pass
    finally:
        await fleet_hub.unregister_client(workspace_id, conn_id)
