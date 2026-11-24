"""AgentNode 守护进程主循环：连接 Core WSS、响应会话与审批指令、启动直传端点。"""

import asyncio
from collections import OrderedDict, deque
from contextlib import closing, suppress
from dataclasses import asdict, dataclass, field
from hashlib import sha256
import json
import logging
import os
from pathlib import Path
import platform as py_platform
import re
import socket
import sqlite3
import tempfile
import time
from typing import Any
from urllib.parse import urlsplit
from uuid import uuid4

import uvicorn
import websockets

from .adapters.base import AgentAdapter, ApprovalCallback, EventEmitter
from .adapters.hermes import HermesAdapter
from .adapters.hermes_ws import HermesWsAdapter, ProviderError
from .adapters.jsonrpc import JsonRpcError
from .adapters.registry import build_adapter_registry
from .alist_publish import LinkPublisher, PublishResult
from .audit import audit_event
from .config import NodeConfig, PathOutsideAllowedRootsError, detect_lan_urls, ensure_allowed_path
from .crypto_chunks import generate_file_key
from .hermes_media import CAPABILITY as HERMES_MEDIA_CAPABILITY, MediaError, relay_hermes_attachment
from .terminal_session import TerminalManager
from .port_preview import PortPreviewManager
from .session_events import MAX_SESSION_SEQ, EventStore, PromptEvents, SessionEventLog
from .transfer import (
    DirectArtifactStore,
    create_direct_transfer_app,
    download_and_decrypt_artifact,
    publish_file_artifact,
)
from .workspace_tools import (
    create_git_checkpoint,
    discover_workspace_skills,
    get_file_git_blame,
    get_workspace_diff,
    git_commit_changes,
    list_workspace_files,
    list_workspace_tree,
    load_workspace_rules,
    merge_worktree_to_base,
    open_workspace_external,
    read_workspace_file,
    restore_git_checkpoint,
    revert_diff_hunk,
    revert_workspace_files,
    write_workspace_file,
)
from .worktree import current_session_ref, project_identity, recover_session_worktree, remove_session_worktree


_LOG = logging.getLogger(__name__)
_PROJECT_PERMISSION_MODES = ("default", "read", "deny")
IDLE_TRANSCRIPT_INTERVAL_SECONDS = 2.0


@dataclass
class IdleTranscript:
    opened_at: float = field(default_factory=lambda: time.time() * 1000)
    last_event_at: float = float("-inf")
    seen: deque[str] = field(default_factory=lambda: deque(maxlen=50))


@dataclass
class SessionStream:
    stream_id: str = field(default_factory=lambda: uuid4().hex)
    sequence: int = 0
    turn_start: int = 0
    run_id: str | None = None
    byte_count: int = 0
    events: deque[tuple[int, dict[str, Any]]] = field(default_factory=deque)

    def append(self, event: dict[str, Any]) -> dict[str, Any]:
        self.sequence += 1
        frame = {**event, "seq": self.sequence, "sequence": self.sequence, "streamId": self.stream_id}
        size = len(json.dumps(frame, ensure_ascii=False).encode("utf-8"))
        self.events.append((size, frame))
        self.byte_count += size
        while len(self.events) > 500 or self.byte_count > 4 * 1024 * 1024:
            self.byte_count -= self.events.popleft()[0]
        return frame


def _history_cursor(message: dict[str, Any], previous: dict[str, Any]) -> str:
    anchor = [(row.get("role"), row.get("id") if row.get("systemEvents") else row.get("text"))
              for row in (previous, message)]
    return sha256(json.dumps(anchor, ensure_ascii=False).encode("utf-8")).hexdigest()


class AgentNodeDaemon:
    """运行在每台受控机器上的轻量级节点守护进程。"""

    def __init__(
        self,
        config: NodeConfig,
        *,
        adapters: dict[str, AgentAdapter] | None = None,
        staging_dir: Path | None = None,
    ) -> None:
        self.config = config
        self.adapters = adapters if adapters is not None else build_adapter_registry(config)
        self.staging_dir = staging_dir or (Path(tempfile.gettempdir()) / "studiolo-node-direct")
        self.direct_store = DirectArtifactStore(self.staging_dir) if config.direct.enabled else None
        self.terminal_manager = TerminalManager(config.allowed_roots)
        self.port_previews = PortPreviewManager()
        self._pending_approvals: dict[str, asyncio.Future[str]] = {}
        self._pending_approval_cmds: dict[str, str] = {}
        self._pending_approval_events: dict[str, dict[str, Any]] = {}
        self._session_allowed_commands: dict[tuple[str, str], set[str]] = {}
        self._trust_file = self.staging_dir / "trust-allowlist.json"
        self._trust_patterns: list[str] = self._load_trust_patterns()
        self._session_cwds: dict[tuple[str, str], Path] = {}
        self._session_worktrees: dict[tuple[str, str], tuple[Path, Path]] = {}
        self._checkpoints: dict[tuple[str, str, str], dict[str, Any]] = {}
        self._checkpoint_order: dict[tuple[str, str], list[str]] = {}
        self._active_runs: set[tuple[str, str]] = set()
        self._idle_transcripts: dict[str, IdleTranscript] = {}
        self._compacting_sessions: set[tuple[str, str]] = set()
        self._session_streams: OrderedDict[tuple[str, str], SessionStream] = OrderedDict()
        self._command_db = (staging_dir or Path.home() / ".studiolo" / "agent-node") / "chat-commands.sqlite3"
        self._project_permissions_file = self._command_db.with_name("project-permissions.json")
        self._project_permissions = self._load_project_permissions()
        self._adapter_capabilities: dict[str, tuple[str, ...]] = {}
        self._alist_publisher: LinkPublisher | None = (
            LinkPublisher(config.alist) if config.alist is not None else None
        )
        self._alist_cache: dict[tuple[str, int, int], PublishResult] = {}
        self._command_scope = sha256(f"{config.core_url}\n{config.node_token}".encode()).hexdigest()
        self._send_lock = asyncio.Lock()
        self._session_event_log = (
            SessionEventLog(EventStore()) if os.getenv("STUDIOLO_SESSION_EVENTS") == "1" else None
        )

    def _load_trust_patterns(self) -> list[str]:
        try:
            if self._trust_file.is_file():
                data = json.loads(self._trust_file.read_text(encoding="utf-8"))
                if isinstance(data, list):
                    return [str(x).strip() for x in data if isinstance(x, str) and x.strip()][:100]
        except Exception:
            pass
        return []

    def _save_trust_patterns(self) -> None:
        try:
            self.staging_dir.mkdir(parents=True, exist_ok=True)
            self._trust_file.write_text(json.dumps(self._trust_patterns, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception:
            pass

    def _load_project_permissions(self) -> dict[Path, str]:
        try:
            data = json.loads(self._project_permissions_file.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}
        if not isinstance(data, dict) or any(mode not in _PROJECT_PERMISSION_MODES for mode in data.values()):
            raise ValueError("项目权限配置无效")
        return {Path(path): mode for path, mode in data.items()}

    def _set_project_permission(self, directory: Path, mode: str) -> None:
        policies = dict(self._project_permissions)
        if mode == "inherit":
            policies.pop(directory, None)
        else:
            policies[directory] = mode
        self._project_permissions_file.parent.mkdir(parents=True, exist_ok=True)
        pending = self._project_permissions_file.with_suffix(f".{uuid4().hex}.tmp")
        try:
            pending.write_text(json.dumps({str(path): value for path, value in policies.items()}, ensure_ascii=False), encoding="utf-8")
            pending.replace(self._project_permissions_file)
        finally:
            pending.unlink(missing_ok=True)
        self._project_permissions = policies

    async def _resolve_run_permissions(
        self, provider: str, session_id: str, adapter: AgentAdapter, options: dict[str, Any],
    ) -> dict[str, Any]:
        mode = options.get("permissionOverride")
        if mode is not None and mode not in _PROJECT_PERMISSION_MODES:
            raise ValueError("会话的临时权限设置无效")
        key = (provider, session_id)
        if self._project_permissions and key not in self._session_cwds and mode is None:
            # A resumed session can send a prompt before its directory has been announced.
            for page in range(1, 21):
                sessions = await adapter.list_sessions(page=page, limit=50)
                metadata = next((row for row in sessions if row.get("sessionId") == session_id), None)
                if metadata:
                    await asyncio.to_thread(self._remember_session_checkout, provider, metadata)
                    break
                if len(sessions) < 50:
                    break
            if key not in self._session_cwds:
                raise ValueError("无法核实当前会话的项目权限，请刷新节点会话列表或临时选择本会话权限")
        if mode is None:
            worktree = self._session_worktrees.get(key)
            directory = worktree[0] if worktree else self._session_cwds.get(key)
            if directory is not None:
                mode = next((self._project_permissions[path] for path in (directory, *directory.parents)
                             if path in self._project_permissions), None)
            if options.get("readOnly"):
                mode = "read"
            elif options.get("denyRequests") and mode not in (None, "read"):
                mode = "deny"
        if mode is None:
            return options
        if mode == "read" and provider not in ("codex", "mock"):
            raise ValueError("当前代理不支持项目的只读权限，请切换代理或选择本会话的临时权限")
        if mode == "deny":
            caps = self._adapter_capabilities.get(provider)
            if caps is None:
                caps = (await adapter.probe()).capabilities
                self._adapter_capabilities[provider] = caps
            if "approval" not in caps:
                raise ValueError("当前代理由宿主管理审批，请切换代理或选择本会话的临时权限")
        return {**options, "readOnly": mode == "read", "denyRequests": mode == "deny", "autoApprove": False}

    @staticmethod
    def _derive_trust_prefix(command: str) -> str:
        clean = " ".join(str(command or "").strip().split())
        if not clean or any(tok in clean for tok in ("&&", "||", ";", "|", "$(", "`", "\n", "\r", ">", "<")):
            return ""
        parts = clean.split(" ")
        head = parts[0].lower()
        if head in ("npm", "pnpm", "yarn", "git", "python", "python3", "cargo", "go") and len(parts) >= 2:
            return f"{parts[0]} {parts[1]}"
        return parts[0]

    def _is_command_trusted(self, command: str) -> bool:
        clean = " ".join(str(command or "").strip().split())
        if not clean or not self._trust_patterns:
            return False
        if any(tok in clean for tok in ("&&", "||", ";", "|", "$(", "`", "\n", "\r", ">", "<")):
            return False
        lower_cmd = clean.lower()
        for pat in self._trust_patterns:
            p = " ".join(pat.strip().lower().split())
            if not p:
                continue
            if lower_cmd == p or lower_cmd.startswith(f"{p} "):
                return True
        return False

    def _resolve_session_dir(
        self,
        provider: str,
        session_id: str | None = None,
        fallback_cwd: Any = None,
    ) -> Path:
        if session_id and (provider, session_id) in self._session_cwds:
            try:
                return ensure_allowed_path(self._session_cwds[(provider, session_id)], self.config.allowed_roots)
            except PathOutsideAllowedRootsError:
                pass
        if fallback_cwd:
            try:
                return ensure_allowed_path(str(fallback_cwd), self.config.allowed_roots)
            except PathOutsideAllowedRootsError:
                pass
        return ensure_allowed_path(self.config.allowed_roots[0], self.config.allowed_roots)

    def _remember_session_checkout(
        self, provider: str, meta: dict[str, Any], *, new: bool = False,
        projects: dict[Path, dict[str, str]] | None = None,
    ) -> dict[str, Any]:
        sid = str(meta.get("sessionId") or "")
        raw_cwd = meta.get("worktreePath") or meta.get("cwd")
        if not sid or not raw_cwd:
            return meta
        try:
            cwd = ensure_allowed_path(raw_cwd, self.config.allowed_roots)
        except (PathOutsideAllowedRootsError, OSError):
            return meta
        key = (provider, sid)
        self._session_cwds[key] = cwd
        worktree = None
        try:
            worktree = self._session_worktrees.get(key) or recover_session_worktree(cwd, self.config.allowed_roots)
            if worktree:
                self._session_worktrees[key] = worktree
                meta = {**meta, "worktreePath": str(worktree[1])}
            if new or worktree:
                meta = {**meta, "branch": current_session_ref(cwd)}
        except (RuntimeError, OSError, PathOutsideAllowedRootsError):
            pass
        if provider != "hermes" and cwd.is_dir():
            project_dir = worktree[0] if worktree else cwd
            cache = projects if projects is not None else {}
            if project_dir not in cache:
                cache[project_dir] = project_identity(project_dir, self.config.allowed_roots)
            meta = {**meta, **cache[project_dir]}
        return {**meta, "projectDirectory": str(worktree[0] if worktree else cwd)}

    async def probe_adapters(self) -> list[dict[str, Any]]:
        results = []
        for name, adapter in self.adapters.items():
            try:
                p = await adapter.probe()
                self._adapter_capabilities[name] = p.capabilities
                results.append({
                    "provider": p.provider,
                    "version": p.version,
                    "status": p.status,
                    "capabilities": [
                        *p.capabilities,
                        "project-permissions",
                        *(["deny-requests", "auto-approve"] if "approval" in p.capabilities else []),
                        *([HERMES_MEDIA_CAPABILITY] if isinstance(adapter, HermesAdapter)
                           and self.config.hermes_media and os.open in os.supports_dir_fd else []),
                    ],
                })
            except Exception:
                results.append({"provider": name, "version": "", "status": "error", "capabilities": []})
        return results

    def build_transfer_endpoints(self) -> list[dict[str, Any]]:
        if not self.config.direct.enabled:
            return []
        eps: list[dict[str, Any]] = []
        for idx, url in enumerate(self.config.direct.advertise_urls):
            eps.append({"kind": "lan", "url": url.rstrip("/"), "priority": 5 + idx, "label": "Configured Direct"})
        for lan in detect_lan_urls(self.config.direct.port):
            eps.append({"kind": "lan", "url": lan, "priority": 15, "label": "LAN Direct"})
        return eps

    async def build_hello(self) -> dict[str, Any]:
        sys_map = {"Darwin": "macos", "Windows": "windows", "Linux": "linux"}
        return {
            "hostname": socket.gethostname(),
            "platform": sys_map.get(py_platform.system(), "linux"),
            "allowedRoots": [str(r) for r in self.config.allowed_roots],
            "adapters": await self.probe_adapters(),
            "transferEndpoints": self.build_transfer_endpoints(),
        }

    async def _send_ws(
        self, ws: Any, frame: dict[str, Any], *, prompt: PromptEvents | None = None, forward: bool = True,
        stream: SessionStream | None = None, provider: str | None = None,
    ) -> None:
        async with self._send_lock:
            if self._session_event_log is not None:
                event_frame = {"provider": provider, **frame} if provider is not None else frame
                await asyncio.to_thread(self._session_event_log.record, event_frame, prompt)
            if not forward:
                return
            if stream is not None:
                frame = stream.append(frame)
            if provider is not None:
                frame = {"provider": provider, **frame}
            sequence = frame.get("seq")
            audit_event(
                "node",
                session_id=frame.get("sessionId"),
                run_id=frame.get("runId"),
                stream_id=frame.get("streamId"),
                seq=sequence if sequence is not None else frame.get("sequence"),
                event_type=frame.get("type"),
                call_id=frame.get("callId"),
            )
            await ws.send(json.dumps(frame, ensure_ascii=False))

    def _claim_prompt_command(self, command_id: str) -> bool:
        self._command_db.parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(self._command_db)) as db, db:
            db.execute("""CREATE TABLE IF NOT EXISTS chat_commands (
                scope TEXT NOT NULL, command_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
                PRIMARY KEY (scope, command_hash)
            )""")
            receipt = sha256(command_id.encode()).hexdigest()
            inserted = db.execute("INSERT OR IGNORE INTO chat_commands VALUES (?, ?, unixepoch())", (self._command_scope, receipt))
            db.execute("""DELETE FROM chat_commands WHERE rowid IN (
                SELECT rowid FROM chat_commands ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET 16384
            )""")
            return inserted.rowcount == 1

    async def _request_approval(
        self,
        ws: Any,
        *,
        provider: str,
        session_id: str,
        call_id: str,
        command: str,
        risk: str,
    ) -> str:
        session = (provider, session_id)
        if risk != "high" and command and command in self._session_allowed_commands.get(session, ()):
            return "allow_once"
        if risk != "high" and self._is_command_trusted(command):
            return "allow_once"
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[str] = loop.create_future()
        self._pending_approvals[call_id] = fut
        self._pending_approval_cmds[call_id] = command
        stream = self._session_streams.get((provider, session_id))
        event = {
            "type": "PermissionRequest", "provider": provider, "sessionId": session_id,
            "callId": call_id, "command": command, "risk": risk,
            **({"runId": stream.run_id} if stream and stream.run_id else {}),
        }
        self._pending_approval_events[call_id] = event
        try:
            await self._send_ws(ws, event)
            decision = await asyncio.wait_for(fut, timeout=300.0)
        except asyncio.TimeoutError:
            decision = "deny"
        finally:
            self._pending_approvals.pop(call_id, None)
            self._pending_approval_cmds.pop(call_id, None)
            self._pending_approval_events.pop(call_id, None)
        if self._session_event_log is not None:
            await self._send_ws(ws, {**event, "type": "ApprovalResolved", "decision": decision}, forward=False)
        if decision == "allow_session":
            if risk != "high" and command:
                allowed = self._session_allowed_commands.setdefault(session, set())
                if len(allowed) < 100:
                    allowed.add(command)
            return "allow_once"
        return decision

    def _build_run_callbacks(
        self,
        ws: Any,
        *,
        provider: str,
        options: dict[str, Any],
    ) -> tuple[EventEmitter, ApprovalCallback]:
        async def on_event(evt: dict[str, Any]) -> None:
            await self._send_ws(ws, {"provider": provider, **evt})

        async def on_approval(s_id: str, call_id: str, command: str, risk: str) -> str:
            if options.get("denyRequests") or options.get("readOnly"):
                return "deny"
            if options.get("autoApprove") and risk != "high":
                return "allow_once"
            return await self._request_approval(
                ws, provider=provider, session_id=s_id, call_id=call_id, command=command, risk=risk
            )

        return on_event, on_approval

    async def _materialize_attachments(
        self,
        provider: str,
        session_id: str,
        attachments: list[dict[str, Any]] | None,
    ) -> list[dict[str, Any]] | None:
        """将前端上传并传入的 E2EE ArtifactRef 附件解密落盘至当前会话允许工作区下的 `.studiolo-inbox/`。"""
        if not attachments:
            return None
        base_dir = self._session_cwds.get((provider, session_id)) or self.config.allowed_roots[0]
        safe_base = ensure_allowed_path(base_dir, self.config.allowed_roots)
        inbox_dir = safe_base / ".studiolo-inbox"

        out: list[dict[str, Any]] = []
        for idx, raw in enumerate(attachments):
            if not isinstance(raw, dict):
                continue
            item = dict(raw)
            artifact_id = str(item.get("artifactId") or "")
            key_b64 = str(item.get("keyB64") or "")
            if artifact_id and key_b64:
                raw_name = Path(str(item.get("fileName") or f"attachment-{idx}")).name
                safe_name = re.sub(r"[^A-Za-z0-9._\-\u4e00-\u9fff]", "_", raw_name) or f"attachment-{idx}"
                prefix = re.sub(r"[^A-Za-z0-9_-]", "", artifact_id)[:8] or str(idx)
                dest = inbox_dir / f"{prefix}-{safe_name}"
                local_path = await download_and_decrypt_artifact(
                    core_url=self.config.core_url,
                    node_token=self.config.node_token,
                    artifact_ref=item,
                    destination=dest,
                    allowed_roots=self.config.allowed_roots,
                )
                item["localPath"] = str(local_path)
            out.append(item)
        return out or None

    async def publish_session_artifact(
        self,
        ws: Any,
        *,
        provider: str,
        session_id: str,
        file_path: Path,
        mime: str = "application/octet-stream",
        run_id: str | None = None,
        request_id: str | None = None,
    ) -> dict[str, Any]:
        """将节点工作区产物分块 AES-256-GCM 加密发布，并向控制台推送 `ArtifactOffered` 事件。"""
        key = generate_file_key()
        artifact_ref = await publish_file_artifact(
            core_url=self.config.core_url,
            node_token=self.config.node_token,
            file_path=file_path,
            allowed_roots=self.config.allowed_roots,
            key=key,
            mime=mime,
            direct_store=self.direct_store,
        )
        evt: dict[str, Any] = {
            "type": "ArtifactOffered",
            "provider": provider,
            "sessionId": session_id,
            "artifact": artifact_ref,
        }
        if run_id:
            evt["runId"] = run_id
        if request_id:
            evt["requestId"] = request_id
        await self._send_ws(ws, evt)
        return artifact_ref

    async def _read_session_replay(self, frame: dict[str, Any]) -> dict[str, Any]:
        log = self._session_event_log
        if log is None:
            return {"code": "unsupported", "source": "node"}

        is_snapshot = frame["type"] == "session.snapshot"
        session_id = frame.get("sessionId")
        provider = frame.get("provider") if is_snapshot else None
        if not isinstance(session_id, str) or not session_id.strip():
            return {"code": "invalid_params", "source": "node"}
        if provider is not None and (not isinstance(provider, str) or not provider.strip()):
            return {"code": "invalid_params", "source": "node"}
        epoch, last_seq, limit = None, 0, 500
        if not is_snapshot:
            epoch, last_seq, limit = frame.get("epoch"), frame.get("lastSeq"), frame.get("limit", 500)
            if (not isinstance(epoch, str) or not epoch.strip()
                    or type(last_seq) is not int or not 0 <= last_seq <= MAX_SESSION_SEQ
                    or type(limit) is not int or not 0 < limit <= MAX_SESSION_SEQ):
                return {"code": "invalid_params", "source": "node"}

        hermes = self.adapters.get("hermes")
        recorded_epoch = None
        if provider is None:
            owner = await asyncio.to_thread(log.store.session_owner, session_id, epoch or log.epoch)
            if owner is not None:
                recorded_epoch, provider = owner
            else:
                provider = next((p for p, sid in self._session_cwds if sid == session_id), None)
            if provider is None and epoch != log.epoch and isinstance(hermes, HermesWsAdapter):
                # An unrecorded Hermes session may have been opened by another gateway client.
                provider = "hermes"

        result = {"sessionId": session_id, "source": "node"}
        if provider == "hermes" and isinstance(hermes, HermesWsAdapter):
            try:
                async with asyncio.timeout(40):
                    replay = await hermes.read_session_replay(session_id, epoch=epoch, last_seq=last_seq, limit=limit)
            except PathOutsideAllowedRootsError:
                return {**result, "source": "gateway", "code": "path_not_allowed"}
            except (OSError, TimeoutError, websockets.WebSocketException, JsonRpcError):
                return {**result, "source": "gateway", "code": "gateway_replay_error"}
            except (KeyError, TypeError, ValueError):
                _LOG.exception("Invalid Hermes session replay response")
                return {**result, "source": "gateway", "code": "gateway_replay_error"}
            if replay is not None:
                return replay

        if epoch is None:
            snapshot = await asyncio.to_thread(log.store.snapshot, session_id, log.epoch)
            return {**result, "epoch": log.epoch, "lastSeq": snapshot.lastSeq,
                    "snapshot": asdict(snapshot), "incomplete": provider == "hermes"}
        if epoch not in (log.epoch, recorded_epoch):
            # Neither an unknown epoch nor a gateway cursor belongs to this node log.
            return {**result, "epoch": log.epoch, "events": [], "hasMore": False, "snapshotRequired": True}
        events = await asyncio.to_thread(log.store.events_since, session_id, epoch, last_seq, min(limit + 1, MAX_SESSION_SEQ))
        return {**result, "epoch": epoch, "events": events[:limit], "hasMore": len(events) > limit}

    async def _read_session_list(self, frame: dict[str, Any]) -> dict[str, Any]:
        session_id = frame.get("session_id")
        provider = frame.get("provider")
        if (not isinstance(session_id, str) or not session_id.strip()
                or (provider is not None and (not isinstance(provider, str) or not provider.strip()))):
            return {"ok": False, "code": "invalid_params", "error": "Invalid session ID or provider"}
        if provider is None:
            provider = next((p for p, sid in self._session_cwds if sid == session_id), "hermes")
        adapter = self.adapters.get(provider)
        if not isinstance(adapter, HermesWsAdapter):
            return {"unsupported": True}

        read = adapter.processes if frame["type"] == "session.processes" else adapter.subagents
        try:
            result = await read(session_id)
        except ProviderError as exc:
            return {"ok": False, "code": "provider_error", "error": str(exc)}
        return {**result, "provider": "hermes"}

    async def handle_command(self, ws: Any, frame: dict[str, Any], *, node_id: str | None = None) -> None:
        cmd = str(frame.get("type") or "")
        req_id = frame.get("requestId")
        client_conn_id = frame.get("_clientConnId")
        provider = str(frame.get("provider") or "mock")
        adapter = self.adapters.get(provider)
        watch_idle = provider == "hermes" and hasattr(adapter, "fetch_transcript")

        async def send_back(payload: dict[str, Any]) -> None:
            if client_conn_id and "_clientConnId" not in payload:
                payload["_clientConnId"] = client_conn_id
            if req_id and "requestId" not in payload:
                payload["requestId"] = req_id
            await self._send_ws(ws, payload)

        if cmd in ("session.snapshot", "session.events.since"):
            rpc_id = frame.get("_rpcId")
            if not isinstance(rpc_id, str) or not rpc_id:
                return
            try:
                result = await self._read_session_replay(frame)
            except (OSError, sqlite3.Error, ValueError):
                _LOG.exception("Cannot read node session event log")
                result = {"code": "node_execution_error", "source": "node"}
            await send_back({"type": "SessionReplayResult", "_rpcId": rpc_id, "result": result})
            return

        if cmd in ("session.processes", "session.subagents"):
            rpc_id = frame.get("_rpcId")
            if not isinstance(rpc_id, str) or not rpc_id:
                return
            result = await self._read_session_list(frame)
            await send_back({"type": "SessionReplayResult", "_rpcId": rpc_id, "result": result})
            return

        if cmd == "hermes.media.relay":
            rpc_id = frame.get("_rpcId")
            if not isinstance(rpc_id, str) or not isinstance(adapter, HermesAdapter):
                return
            sid = frame.get("sessionId")
            history = adapter.live_attachment_history(sid) if isinstance(sid, str) else []
            result = {"type": "HermesMediaResult", "_rpcId": rpc_id, "sessionId": sid}
            try:
                result.update(await relay_hermes_attachment(
                    self.config, frame, node_id, history,
                    written_paths=adapter.attachment_writes(sid) if isinstance(sid, str) else frozenset(),
                    restore_written_paths=adapter.restore_attachment_writes if isinstance(adapter, HermesWsAdapter) else None,
                    publisher=self._alist_publisher,
                    publish_cache=self._alist_cache,
                ), ok=True)
            except MediaError as exc:
                result.update(ok=False, code=str(exc))
            await send_back(result)
            return

        if cmd == "session.active.list":
            hermes = self.adapters.get("hermes")
            probed_runs = set()
            if isinstance(hermes, HermesWsAdapter):
                probed_runs = {("hermes", sid) for sid in hermes.cached_running_sessions()}
            runs = []
            for key in self._active_runs | probed_runs:
                run_provider, sid = key
                stream = self._session_streams.get(key)
                if key in probed_runs or (stream and stream.run_id):
                    runs.append({
                        "provider": run_provider, "sessionId": sid, "runId": stream.run_id if stream else None,
                        **({"streamId": stream.stream_id, "lastSeq": stream.sequence} if stream else {}),
                    })
            await send_back({"type": "ActiveRunsSnapshot", "runs": runs})
            return

        if cmd in ("project.permissions.list", "project.permissions.set"):
            if cmd == "project.permissions.set":
                try:
                    mode = frame.get("mode")
                    if mode not in (*_PROJECT_PERMISSION_MODES, "inherit"):
                        raise ValueError("项目默认权限无效")
                    if not isinstance(frame.get("cwd"), str) or not frame["cwd"].strip():
                        raise ValueError("请选择项目目录")
                    directory = ensure_allowed_path(frame["cwd"], self.config.allowed_roots)
                    if not directory.is_dir():
                        raise ValueError("项目目录不存在")
                    self._set_project_permission(directory, mode)
                except (ValueError, OSError, PathOutsideAllowedRootsError) as err:
                    await send_back({"type": "Failed", "code": "project_permission_error", "message": str(err)})
                    return
            await send_back({
                "type": "ProjectPermissionsSnapshot",
                "projectPermissions": [{"cwd": str(path), "mode": mode} for path, mode in self._project_permissions.items()],
            })
            return

        if cmd == "permission.respond":
            call_id = str(frame.get("callId") or "")
            fut = self._pending_approvals.get(call_id)
            if not fut or fut.done():
                return
            decision = str(frame.get("decision") or "deny")
            if decision == "allow_trust":
                raw_pat = str(frame.get("trustPattern") or "") or self._derive_trust_prefix(
                    self._pending_approval_cmds.get(call_id, "")
                )
                clean_pat = " ".join(raw_pat.strip().split())
                approval = self._pending_approval_events.get(call_id, {})
                if approval.get("risk") != "high" and clean_pat and not any(tok in clean_pat for tok in ("&&", "||", ";", "|", "$(", "`", "\n", "\r", ">", "<")):
                    if clean_pat not in self._trust_patterns:
                        self._trust_patterns = [*self._trust_patterns, clean_pat][-100:]
                        self._save_trust_patterns()
                        await self._send_ws(ws, {"type": "TrustPolicySnapshot", "patterns": list(self._trust_patterns)})
                decision = "allow_once"
            elif decision not in ("allow_once", "allow_session", "deny"):
                decision = "deny"
            if not fut.done():
                fut.set_result(decision)
            return

        if cmd == "trust.list":
            await send_back({"type": "TrustPolicySnapshot", "patterns": list(self._trust_patterns)})
            return
        if cmd == "trust.add":
            pat = " ".join(str(frame.get("pattern") or "").strip().split())
            if not pat or any(tok in pat for tok in ("&&", "||", ";", "|", "$(", "`", "\n", "\r", ">", "<")):
                await send_back({"type": "Failed", "code": "invalid_trust_pattern", "message": "安全策略不允许包含管道或连接符的白名单前缀"})
                return
            if pat not in self._trust_patterns:
                self._trust_patterns = [*self._trust_patterns, pat][-100:]
                self._save_trust_patterns()
            await self._send_ws(ws, {"type": "TrustPolicySnapshot", "patterns": list(self._trust_patterns)})
            return
        if cmd == "trust.remove":
            pat = " ".join(str(frame.get("pattern") or "").strip().split())
            self._trust_patterns = [p for p in self._trust_patterns if p != pat]
            self._save_trust_patterns()
            await self._send_ws(ws, {"type": "TrustPolicySnapshot", "patterns": list(self._trust_patterns)})
            return

        if cmd == "subscription.quota.read":
            rpc_id = frame.get("_rpcId")
            if not isinstance(rpc_id, str) or not rpc_id:
                return
            result = await adapter.read_subscription_quota() if adapter is not None else {"status": "unsupported"}
            await send_back({"type": "SubscriptionQuotaResult", "_rpcId": rpc_id, **result})
            return

        if cmd.startswith("cron."):
            rpc_id = str(frame.get("_rpcId") or "").strip()

            async def reply_cron(payload: dict[str, Any]) -> None:
                await send_back({"type": "CronRpcResult", "_rpcId": rpc_id, "provider": provider, **payload})

            if adapter is None:
                await reply_cron({"ok": False, "code": "provider_unavailable", "error": f"Provider {provider} not enabled on node"})
                return
            caps = adapter.cron_capabilities()
            if not caps.get("supported"):
                await reply_cron(
                    {
                        "ok": False,
                        "code": "cron_unsupported",
                        "capabilities": caps,
                        "error": f"{provider} cron gateway is not configured on this node",
                    }
                )
                return
            try:
                profile = str(frame.get("ownerProfile") or "").strip() or None
                if cmd == "cron.list":
                    jobs = await adapter.cron_list(profile=profile)
                    await reply_cron({"ok": True, "capabilities": caps, "jobs": jobs})
                elif cmd == "cron.create":
                    job = await adapter.cron_create(dict(frame.get("payload") or {}))
                    await reply_cron({"ok": True, "capabilities": caps, "job": job})
                elif cmd == "cron.update":
                    job = await adapter.cron_update(
                        native_job_id=str(frame.get("nativeJobId") or ""),
                        payload=dict(frame.get("payload") or {}),
                    )
                    await reply_cron({"ok": True, "capabilities": caps, "job": job})
                elif cmd == "cron.delete":
                    await adapter.cron_delete(
                        native_job_id=str(frame.get("nativeJobId") or ""),
                        profile=profile,
                    )
                    await reply_cron({"ok": True, "capabilities": caps, "deleted": True})
                elif cmd == "cron.pause":
                    job = await adapter.cron_pause(
                        native_job_id=str(frame.get("nativeJobId") or ""),
                        paused=bool(frame.get("paused", True)),
                        profile=profile,
                    )
                    await reply_cron({"ok": True, "capabilities": caps, "job": job})
                elif cmd == "cron.run":
                    run = await adapter.cron_run_now(
                        native_job_id=str(frame.get("nativeJobId") or ""),
                        request_id=str(frame.get("requestId") or ""),
                        profile=profile,
                    )
                    await reply_cron({"ok": True, "capabilities": caps, "run": run})
                elif cmd == "cron.runs":
                    runs = await adapter.cron_list_runs(
                        native_job_id=str(frame.get("nativeJobId") or ""),
                        limit=int(frame.get("limit") or 20),
                        profile=profile,
                    )
                    await reply_cron({"ok": True, "capabilities": caps, "runs": runs})
                else:
                    await reply_cron({"ok": False, "code": "unsupported_cron_cmd", "error": f"Unknown cron command: {cmd}"})
            except Exception as err:
                await reply_cron({"ok": False, "code": "upstream_cron_error", "capabilities": caps, "error": str(err)})
            return

        if adapter is None and cmd != "prompt.steer":
            await send_back({"type": "Failed", "code": "provider_unavailable", "message": f"Provider {provider} not enabled on node"})
            return

        try:
            if cmd == "models.list":
                try:
                    models = await adapter.list_models()
                    await send_back({"type": "ModelsSnapshot", "provider": provider, "models": models})
                except Exception:
                    await send_back({"type": "ModelsSnapshot", "provider": provider, "models": [], "message": "节点无法读取模型列表"})
            elif cmd == "agents.list":
                agents = await adapter.list_agents()
                await send_back({"type": "AgentsSnapshot", "provider": provider, "agents": agents})
            elif cmd == "mcp.list":
                try:
                    servers = await adapter.list_mcp_servers()
                except Exception:
                    await send_back({"type": "McpSnapshot", "provider": provider, "servers": [], "message": "节点无法读取 MCP 服务状态"})
                else:
                    await send_back({"type": "McpSnapshot", "provider": provider, "servers": servers})
            elif cmd == "rules.list":
                sid = str(frame.get("sessionId") or "")
                target_dir = self._resolve_session_dir(provider, sid or None, frame.get("cwd"))
                rules = await asyncio.to_thread(load_workspace_rules, target_dir, self.config.allowed_roots)
                await send_back(
                    {
                        "type": "RulesSnapshot",
                        "provider": provider,
                        **({"sessionId": sid} if sid else {}),
                        "cwd": str(target_dir),
                        "rules": rules,
                    }
                )
            elif cmd == "file.read":
                sid = str(frame.get("sessionId") or "")
                rel_path = str(frame.get("path") or "").strip()
                if not rel_path:
                    raise ValueError("文件路径不能为空")
                target_dir = self._resolve_session_dir(provider, sid or None, frame.get("cwd"))
                file_data = await asyncio.to_thread(
                    read_workspace_file, target_dir, self.config.allowed_roots, rel_path
                )
                await send_back(
                    {
                        "type": "FileContentSnapshot",
                        "provider": provider,
                        **({"sessionId": sid} if sid else {}),
                        **file_data,
                    }
                )
            elif cmd == "file.write":
                sid = str(frame.get("sessionId") or "")
                rel_path = str(frame.get("path") or "").strip()
                content = str(frame.get("content") or "")
                if not rel_path:
                    raise ValueError("文件路径不能为空")
                target_dir = self._resolve_session_dir(provider, sid or None, frame.get("cwd"))
                write_res = await asyncio.to_thread(
                    write_workspace_file, target_dir, self.config.allowed_roots, rel_path, content
                )
                await send_back(
                    {
                        "type": "FileWritten",
                        "provider": provider,
                        **({"sessionId": sid} if sid else {}),
                        **write_res,
                    }
                )
                diff_after = await asyncio.to_thread(get_workspace_diff, target_dir, self.config.allowed_roots)
                await self._send_ws(
                    ws,
                    {
                        "type": "DiffSnapshot",
                        "provider": provider,
                        **({"sessionId": sid} if sid else {}),
                        "cwd": str(target_dir),
                        "perTurn": False,
                        **diff_after,
                    },
                )
            elif cmd == "file.blame":
                sid = str(frame.get("sessionId") or "")
                rel_path = str(frame.get("path") or "").strip()
                if not rel_path:
                    raise ValueError("文件路径不能为空")
                target_dir = self._resolve_session_dir(provider, sid or None, frame.get("cwd"))
                blame_data = await asyncio.to_thread(
                    get_file_git_blame, target_dir, self.config.allowed_roots, rel_path
                )
                await send_back(
                    {
                        "type": "FileBlameSnapshot",
                        "provider": provider,
                        **({"sessionId": sid} if sid else {}),
                        **blame_data,
                    }
                )
            elif cmd == "skills.list":
                sid = str(frame.get("sessionId") or "")
                target_dir = self._resolve_session_dir(provider, sid or None, frame.get("cwd"))
                skills = await asyncio.to_thread(
                    discover_workspace_skills, target_dir, self.config.allowed_roots
                )
                await send_back(
                    {
                        "type": "SkillsSnapshot",
                        "provider": provider,
                        **({"sessionId": sid} if sid else {}),
                        "cwd": str(target_dir),
                        "skills": skills,
                    }
                )
            elif cmd == "workspace.open_external":
                sid = str(frame.get("sessionId") or "")
                target_dir = self._resolve_session_dir(provider, sid or None, frame.get("cwd"))
                rel_path = str(frame.get("path") or "")
                target_app = str(frame.get("target") or "editor")
                opened = await asyncio.to_thread(
                    open_workspace_external,
                    target_dir,
                    self.config.allowed_roots,
                    rel_path=rel_path,
                    target=target_app,
                )
                await send_back(
                    {
                        "type": "ExternalOpened",
                        "provider": provider,
                        **({"sessionId": sid} if sid else {}),
                        **opened,
                    }
                )
            elif cmd == "session.model.set":
                sid = frame.get("sessionId")
                model_id = frame.get("modelId")
                if not isinstance(sid, str) or not sid.strip() or not isinstance(model_id, str) or not model_id.strip():
                    raise ValueError("缺少会话 ID 或模型 ID")
                key = (provider, sid)
                if key in self._active_runs or key in self._compacting_sessions:
                    raise ValueError("当前会话忙碌，请稍后切换模型")
                fields = await adapter.set_session_model(session_id=sid, model_id=model_id)
                if fields is None:
                    raise ValueError("当前适配器不支持直接切换会话模型")
                # The confirmed model applies to every client viewing this session.
                await self._send_ws(ws, {"type": "ContextUsage", "provider": provider, "sessionId": sid,
                                         "requestId": req_id, **fields})
            elif cmd == "session.effort.set":
                sid = frame.get("sessionId")
                effort = frame.get("effort")
                if not isinstance(sid, str) or not sid.strip() or not isinstance(effort, str) or not effort.strip():
                    raise ValueError("缺少会话 ID 或思考强度")
                key = (provider, sid)
                if key in self._active_runs or key in self._compacting_sessions:
                    raise ValueError("当前会话忙碌，请稍后切换思考强度")
                if not isinstance(adapter, HermesAdapter):
                    raise ValueError("当前适配器不支持直接切换思考强度")
                fields = await adapter.set_session_effort(session_id=sid, effort=effort.strip().lower())
                await self._send_ws(ws, {"type": "ContextUsage", "provider": provider, "sessionId": sid,
                                         "requestId": req_id, **fields})
            elif cmd == "session.subscribe":
                sid = str(frame.get("sessionId") or "")
                if watch_idle and sid:
                    self._idle_transcripts.setdefault(sid, IdleTranscript())
                key = (provider, sid)
                probed_running = False
                if key not in self._active_runs and sid and isinstance(adapter, HermesWsAdapter):
                    with suppress(Exception):
                        probed_running = await adapter.session_running(session_id=sid) is True
                # A local run can start while the probe is in flight.
                local_active = key in self._active_runs
                is_active = local_active or probed_running
                raw_last_seq = frame.get("afterSequence", frame.get("lastSeq"))
                last_seq = raw_last_seq if type(raw_last_seq) is int and raw_last_seq > 0 else 0
                stream = self._session_streams.get(key)
                run_id = stream.run_id if stream and is_active else None
                if stream is None and probed_running and isinstance(adapter, HermesWsAdapter):
                    turn_started_at = adapter.cached_turn_started_at(sid)
                    run_id = f"external-{int(turn_started_at or 0)}"
                latest = stream.sequence if stream else 0
                stream_id = frame.get("streamId")
                generation_matches = stream_id in (None, stream.stream_id if stream else None)
                has_cursor = bool(last_seq or (stream_id and raw_last_seq == 0))
                incremental = has_cursor and generation_matches
                # An external turn doesn't start a new turn in the local stream.
                cursor = last_seq if incremental else stream.turn_start if stream and local_active else latest
                oldest = stream.events[0][1]["sequence"] if stream and stream.events else latest + 1
                snapshot_required = bool((has_cursor and not generation_matches) or cursor > latest or cursor < oldest - 1)
                buffered = [event for _, event in stream.events if event["sequence"] > cursor] if stream and not snapshot_required else []
                await send_back(
                    {
                        "type": "SessionStreamReplay",
                        "provider": provider,
                        "sessionId": sid,
                        "active": is_active,
                        "runId": run_id,
                        "incremental": incremental,
                        "lastSeq": latest,
                        "streamId": stream.stream_id if stream else None,
                        "snapshotRequired": snapshot_required,
                        "pendingApprovals": [event for event in self._pending_approval_events.values()
                                             if (event["provider"], event["sessionId"]) == key],
                        "events": buffered,
                        **(adapter.session_effort_fields(sid) if isinstance(adapter, HermesAdapter) else {}),
                        **(adapter.session_model_fields(sid) if isinstance(adapter, HermesAdapter) else {}),
                    }
                )
            elif cmd == "form.reply":
                sid = str(frame.get("sessionId") or "")
                form_id = str(frame.get("formId") or "")
                if not sid or not form_id:
                    raise ValueError("缺少表单 ID 或会话 ID")
                cancelled = bool(frame.get("cancelled", False))
                reply_res = await adapter.reply_form(
                    session_id=sid,
                    form_id=form_id,
                    answer=frame.get("answer") if isinstance(frame.get("answer"), dict) else None,
                    cancel=cancelled,
                )
                await self._send_ws(
                    ws,
                    {
                        "type": "FormResolved",
                        "provider": provider,
                        "sessionId": sid,
                        "formId": form_id,
                        "cancelled": cancelled,
                        **(reply_res or {}),
                    },
                )
            elif cmd == "sessions.list":
                items = await adapter.list_sessions(page=int(frame.get("page") or 1), limit=int(frame.get("limit") or 30))
                projects: dict[Path, dict[str, str]] = {}
                items = await asyncio.to_thread(lambda: [self._remember_session_checkout(provider, row, projects=projects) for row in items])
                await send_back({"type": "SessionsSnapshot", "provider": provider, "sessions": items})
            elif cmd == "session.open":
                cwd = str(frame.get("cwd") or self.config.allowed_roots[0])
                meta = await adapter.open_session(
                    cwd=cwd,
                    session_id=frame.get("sessionId"),
                    use_worktree=bool(frame.get("useWorktree", False)),
                )
                meta = await asyncio.to_thread(self._remember_session_checkout, provider, meta, new=True)
                if watch_idle:
                    self._idle_transcripts.setdefault(meta["sessionId"], IdleTranscript())
                await send_back({"type": "SessionOpened", **meta})
            elif cmd == "session.history":
                sid = str(frame.get("sessionId") or "")
                limit = min(500, max(1, int(frame.get("limit") or 50)))
                before = frame.get("beforeCursor")
                if not frame.get("pagination"):
                    msgs = await adapter.get_history(session_id=sid, limit=limit)
                else:
                    source = await adapter.get_history(session_id=sid, limit=500 if before else min(500, limit + 1))
                    model_fields = adapter.session_model_fields(sid) if isinstance(adapter, HermesAdapter) else {}
                    effort = adapter.session_effort_fields(sid) if isinstance(adapter, HermesAdapter) else {}
                    end = len(source)
                    if before:
                        end = next((i for i in range(len(source) - 1, 0, -1)
                                    if _history_cursor(source[i], source[i - 1]) == before), -1)
                        if end < 0:
                            await send_back({"type": "SessionHistory", "provider": provider, "sessionId": sid,
                                             "messages": [], "cursorExpired": True, **model_fields})
                            return
                    start = max(0, end - limit)
                    msgs = source[start:end]
                    cursor = _history_cursor(source[start], source[start - 1]) if start > 0 and msgs else None
                    await send_back({"type": "SessionHistory", "provider": provider, "sessionId": sid,
                                     "messages": msgs, "historyCursor": cursor, "beforeCursor": before, **effort, **model_fields})
                    return
                await send_back({"type": "SessionHistory", "provider": provider, "sessionId": sid, "messages": msgs,
                                 **(adapter.session_effort_fields(sid) if isinstance(adapter, HermesAdapter) else {}),
                                 **(adapter.session_model_fields(sid) if isinstance(adapter, HermesAdapter) else {})})
            elif cmd == "session.context.read":
                sid = str(frame.get("sessionId") or "")
                try:
                    usage = await asyncio.wait_for(adapter.get_context_usage(session_id=sid), timeout=8)
                except Exception:
                    _LOG.debug("Context usage unavailable for provider=%s", provider, exc_info=False)
                    usage = None
                await send_back({"type": "ContextSnapshot", "provider": provider, "sessionId": sid, "contextUsage": usage})
            elif cmd == "files.list":
                sid = str(frame.get("sessionId") or "")
                target_dir = self._resolve_session_dir(provider, sid or None, frame.get("cwd"))
                query = str(frame.get("query") or "")
                limit = min(200, max(1, int(frame.get("limit") or 60)))
                files = await asyncio.to_thread(
                    list_workspace_files, target_dir, self.config.allowed_roots, query=query, limit=limit
                )
                await send_back(
                    {
                        "type": "FilesSnapshot",
                        "provider": provider,
                        **({"sessionId": sid} if sid else {}),
                        "cwd": str(target_dir),
                        "files": files,
                    }
                )
            elif cmd == "files.tree":
                sid = str(frame.get("sessionId") or "")
                target_dir = self._resolve_session_dir(provider, sid or None, frame.get("cwd"))
                rel_dir = str(frame.get("relDir") or "")
                tree_data = await asyncio.to_thread(
                    list_workspace_tree, target_dir, self.config.allowed_roots, rel_dir=rel_dir
                )
                await send_back(
                    {
                        "type": "FilesTreeSnapshot",
                        "provider": provider,
                        **({"sessionId": sid} if sid else {}),
                        "cwd": str(target_dir),
                        **tree_data,
                    }
                )
            elif cmd == "session.diff":
                sid = str(frame.get("sessionId") or "")
                target_dir = self._resolve_session_dir(provider, sid or None, frame.get("cwd"))
                cp_id = str(frame.get("checkpointId") or "")
                cp = self._checkpoints.get((provider, sid, cp_id)) if cp_id else None
                base_tree = cp["beforeTree"] if cp else None
                target_tree = cp["afterTree"] if cp else None
                if cp:
                    target_dir = ensure_allowed_path(cp["cwd"], self.config.allowed_roots)
                diff_data = await asyncio.to_thread(
                    get_workspace_diff,
                    target_dir,
                    self.config.allowed_roots,
                    base_tree=base_tree,
                    target_tree=target_tree,
                )
                await send_back(
                    {
                        "type": "DiffSnapshot",
                        "provider": provider,
                        **({"sessionId": sid} if sid else {}),
                        "cwd": str(target_dir),
                        "perTurn": bool(cp_id),
                        **diff_data,
                    }
                )
            elif cmd == "checkpoint.revert":
                sid = str(frame.get("sessionId") or "")
                cp_id = str(frame.get("checkpointId") or "")
                if not cp_id:
                    order = self._checkpoint_order.get((provider, sid), [])
                    cp_id = order[-1] if order else ""
                cp = self._checkpoints.get((provider, sid, cp_id)) if cp_id else None
                if cp is None:
                    raise ValueError("未找到可回滚的检查点（可能为非 Git 目录或本轮未产生文件修改）")
                cp_dir = ensure_allowed_path(cp["cwd"], self.config.allowed_roots)
                restored_files = await asyncio.to_thread(
                    restore_git_checkpoint, cp_dir, self.config.allowed_roots, str(cp["beforeTree"])
                )
                await send_back(
                    {
                        "type": "CheckpointReverted",
                        "provider": provider,
                        "sessionId": sid,
                        "checkpointId": cp["checkpointId"],
                        "restoredFiles": restored_files,
                    }
                )
                diff_after = await asyncio.to_thread(get_workspace_diff, cp_dir, self.config.allowed_roots)
                await self._send_ws(
                    ws,
                    {
                        "type": "DiffSnapshot",
                        "provider": provider,
                        "sessionId": sid,
                        "cwd": str(cp_dir),
                        "perTurn": False,
                        **diff_after,
                    },
                )
            elif cmd == "files.revert":
                sid = str(frame.get("sessionId") or "")
                raw_paths = frame.get("paths")
                if not isinstance(raw_paths, list) or not raw_paths:
                    raise ValueError("请指定要撤销的文件路径")
                paths = [str(p) for p in raw_paths if isinstance(p, str) and p.strip()]
                cp_id = str(frame.get("checkpointId") or "")
                cp = self._checkpoints.get((provider, sid, cp_id)) if cp_id else None
                target_dir = (
                    ensure_allowed_path(cp["cwd"], self.config.allowed_roots)
                    if cp
                    else self._resolve_session_dir(provider, sid or None, frame.get("cwd"))
                )
                restored_files = await asyncio.to_thread(
                    revert_workspace_files,
                    target_dir,
                    self.config.allowed_roots,
                    paths,
                    checkpoint_tree=str(cp["beforeTree"]) if cp else None,
                )
                await send_back(
                    {
                        "type": "CheckpointReverted",
                        "provider": provider,
                        "sessionId": sid,
                        "checkpointId": cp["checkpointId"] if cp else "head",
                        "restoredFiles": restored_files,
                    }
                )
                diff_after = await asyncio.to_thread(get_workspace_diff, target_dir, self.config.allowed_roots)
                await self._send_ws(
                    ws,
                    {
                        "type": "DiffSnapshot",
                        "provider": provider,
                        "sessionId": sid,
                        "cwd": str(target_dir),
                        "perTurn": False,
                        **diff_after,
                    },
                )
            elif cmd == "diff.revert_hunk":
                sid = str(frame.get("sessionId") or "")
                rel_path = str(frame.get("path") or "")
                hunk_patch = str(frame.get("patch") or "")
                target_dir = self._resolve_session_dir(provider, sid or None, frame.get("cwd"))
                restored_files = await asyncio.to_thread(
                    revert_diff_hunk, target_dir, self.config.allowed_roots, rel_path, hunk_patch
                )
                await send_back(
                    {
                        "type": "CheckpointReverted",
                        "provider": provider,
                        "sessionId": sid,
                        "checkpointId": "hunk",
                        "restoredFiles": restored_files,
                    }
                )
                diff_after = await asyncio.to_thread(get_workspace_diff, target_dir, self.config.allowed_roots)
                await self._send_ws(
                    ws,
                    {
                        "type": "DiffSnapshot",
                        "provider": provider,
                        "sessionId": sid,
                        "cwd": str(target_dir),
                        "perTurn": False,
                        **diff_after,
                    },
                )
            elif cmd == "git.commit":
                sid = str(frame.get("sessionId") or "")
                commit_msg = str(frame.get("message") or "").strip()
                raw_paths = frame.get("paths") if isinstance(frame.get("paths"), list) else None
                target_dir = self._resolve_session_dir(provider, sid or None, frame.get("cwd"))
                commit_res = await asyncio.to_thread(
                    git_commit_changes,
                    target_dir,
                    self.config.allowed_roots,
                    commit_msg,
                    paths=[str(p) for p in raw_paths] if raw_paths else None,
                )
                await send_back(
                    {
                        "type": "GitCommitted",
                        "provider": provider,
                        "sessionId": sid,
                        **commit_res,
                    }
                )
                diff_after = await asyncio.to_thread(get_workspace_diff, target_dir, self.config.allowed_roots)
                await self._send_ws(
                    ws,
                    {
                        "type": "DiffSnapshot",
                        "provider": provider,
                        "sessionId": sid,
                        "cwd": str(target_dir),
                        "perTurn": False,
                        **diff_after,
                    },
                )
            elif cmd == "terminal.preview":
                sid = str(frame.get("sessionId") or "")
                port = frame.get("port")
                result = {"type": "TerminalPreview", "provider": provider, "sessionId": sid, "port": port}
                try:
                    if not sid or type(port) is not int or not 1024 <= port <= 65535:
                        raise ValueError("请选择有效的工作区预览端口（1024–65535）")
                    if not self.config.direct.enabled:
                        raise ValueError("节点未启用局域网直连")
                    if not self.terminal_manager.is_open_for(str(frame.get("terminalId") or ""), sid):
                        raise ValueError("请先打开当前会话的节点终端")
                    self._resolve_session_dir(provider, sid)
                    urls = detect_lan_urls(1)
                    host = urlsplit(urls[0]).hostname if urls else None
                    if not host:
                        raise ValueError("节点没有可用于直连的局域网地址")
                    url = await self.port_previews.open(provider, sid, host, port, frame.get("tls") is True)
                    await send_back({**result, "previewUrl": url})
                except (ValueError, OSError, TimeoutError) as err:
                    await send_back({**result, "error": str(err) if isinstance(err, ValueError) else "节点端口不可访问"})
            elif cmd == "terminal.open":
                sid = str(frame.get("sessionId") or "")
                target_dir = self._resolve_session_dir(provider, sid or None, frame.get("cwd"))

                async def _term_emit(evt: dict[str, Any]) -> None:
                    await self._send_ws(ws, {"provider": provider, **evt})

                opened = await self.terminal_manager.open_terminal(
                    cwd=target_dir,
                    session_id=sid,
                    emit=_term_emit,
                    cols=int(frame.get("cols") or 100),
                    rows=int(frame.get("rows") or 28),
                )
                await send_back({"type": "TerminalOpened", "provider": provider, **opened})
            elif cmd == "terminal.input":
                tid = str(frame.get("terminalId") or "")
                data = str(frame.get("data") or "")
                await self.terminal_manager.send_input(tid, data)
            elif cmd == "terminal.signal":
                tid = str(frame.get("terminalId") or "")
                sig_name = str(frame.get("signal") or "SIGINT")
                await self.terminal_manager.send_signal(tid, sig_name)
            elif cmd == "terminal.resize":
                tid = str(frame.get("terminalId") or "")
                self.terminal_manager.resize_terminal(
                    tid, int(frame.get("cols") or 100), int(frame.get("rows") or 28)
                )
            elif cmd == "terminal.close":
                tid = str(frame.get("terminalId") or "")
                sid = str(frame.get("sessionId") or "")
                if await self.terminal_manager.close_terminal(tid):
                    await self._send_ws(
                        ws, {"type": "TerminalClosed", "provider": provider, "sessionId": sid, "terminalId": tid}
                    )
            elif cmd == "worktree.merge":
                sid = str(frame.get("sessionId") or "")
                pair = self._session_worktrees.get((provider, sid))
                if pair is None:
                    raise ValueError("当前会话未使用独立 Git Worktree 沙箱")
                base_dir, wt_dir = pair
                merge_res = await asyncio.to_thread(
                    merge_worktree_to_base, base_dir, wt_dir, self.config.allowed_roots
                )
                await send_back(
                    {
                        "type": "WorktreeMerged",
                        "provider": provider,
                        "sessionId": sid,
                        **merge_res,
                    },
                )
                diff_after = await asyncio.to_thread(get_workspace_diff, base_dir, self.config.allowed_roots)
                await self._send_ws(
                    ws,
                    {
                        "type": "DiffSnapshot",
                        "provider": provider,
                        "sessionId": sid,
                        "cwd": str(base_dir),
                        "perTurn": False,
                        **diff_after,
                    },
                )
            elif cmd == "session.rename":
                sid = str(frame.get("sessionId") or "")
                title = str(frame.get("title") or "").strip()
                if not sid or not title:
                    raise ValueError("会话 ID 与标题不能为空")
                renamed = await adapter.rename_session(session_id=sid, title=title)
                await send_back(
                    {
                        "type": "SessionRenamed",
                        "provider": provider,
                        "sessionId": sid,
                        "title": str((renamed or {}).get("title") or title),
                    }
                )
            elif cmd == "session.delete":
                sid = str(frame.get("sessionId") or "")
                if not sid:
                    raise ValueError("缺少会话 ID")
                await adapter.delete_session(session_id=sid)
                if watch_idle:
                    self._idle_transcripts.pop(sid, None)
                wt_pair = self._session_worktrees.pop((provider, sid), None)
                if wt_pair is not None:
                    try:
                        await asyncio.to_thread(
                            remove_session_worktree, wt_pair[0], wt_pair[1], self.config.allowed_roots
                        )
                    except Exception:
                        pass
                self._session_cwds.pop((provider, sid), None)
                self._session_streams.pop((provider, sid), None)
                self._session_allowed_commands.pop((provider, sid), None)
                await self.port_previews.close((provider, sid))
                await send_back({"type": "SessionDeleted", "provider": provider, "sessionId": sid})
            elif cmd == "session.compact":
                sid = str(frame.get("sessionId") or "")
                if not sid:
                    raise ValueError("缺少会话 ID")
                key = (provider, sid)
                if key in self._active_runs or key in self._compacting_sessions:
                    raise ValueError("请等待当前会话任务结束后再压缩")
                self._compacting_sessions.add(key)
                try:
                    res = await adapter.compact_session(session_id=sid)
                finally:
                    self._compacting_sessions.discard(key)
                await send_back(
                    {
                        "type": "SessionCompacted",
                        "provider": provider,
                        "sessionId": sid,
                        **(res or {"supported": False}),
                    }
                )
            elif cmd in ("prompt.send", "handoff.send"):
                sid = str(frame.get("sessionId") or "")
                command_id = str(frame.get("commandId") or req_id or "")
                if len(command_id) > 128:
                    raise ValueError("命令 ID 过长")
                options = await self._resolve_run_permissions(provider, sid, adapter, frame.get("options") or {})
                if options.get("readOnly") and provider not in ("codex", "mock"):
                    raise ValueError("当前适配器不支持只读沙箱")
                runtime = {k: options[k] for k in ("model", "effort", "readOnly", "agent") if options.get(k)}

                if cmd == "prompt.send":
                    text = str(frame.get("text") or "")
                    raw_atts = frame.get("attachments") if isinstance(frame.get("attachments"), list) else None
                    atts = await self._materialize_attachments(provider, sid, raw_atts)
                else:
                    # 将上一节点/Agent 生成的摘要及 ArtifactRef 票据转交给当前节点执行，有密钥时同步解密落盘
                    text = str(frame.get("summary") or frame.get("text") or "")
                    raw_art = frame.get("artifact") if isinstance(frame.get("artifact"), dict) else None
                    atts = await self._materialize_attachments(provider, sid, [raw_art] if raw_art else None)
                    if raw_art and not (atts and atts[0].get("localPath")):
                        text += f"\n\n[Handoff Artifact: {raw_art.get('fileName')} id={raw_art.get('artifactId')}]"

                eff_req_id = str(req_id or uuid4().hex)
                session_dir = self._resolve_session_dir(provider, sid or None, frame.get("cwd"))
                before_tree = await asyncio.to_thread(
                    create_git_checkpoint, session_dir, self.config.allowed_roots
                )
                prompt = PromptEvents(eff_req_id, text, atts) if self._session_event_log is not None else None
                base_emit, on_approval = self._build_run_callbacks(ws, provider=provider, options=options)
                turn_state: dict[str, Any] = {"runId": None, "checkpointed": False}
                run_key = (provider, sid)
                if run_key in self._compacting_sessions:
                    raise ValueError("请等待会话上下文压缩结束")
                if command_id and not await asyncio.to_thread(self._claim_prompt_command, command_id):
                    await send_back({"type": "DuplicateIgnored", "commandId": command_id})
                    return
                if run_key in self._active_runs or run_key in self._compacting_sessions:
                    raise ValueError("当前会话已有任务运行中")
                self._active_runs.add(run_key)
                stream = self._session_streams.setdefault(run_key, SessionStream())
                stream.turn_start = stream.sequence
                stream.run_id = eff_req_id
                self._session_streams.move_to_end(run_key)
                while len(self._session_streams) > 16:
                    oldest = next((key for key in self._session_streams if key not in self._active_runs), None)
                    if oldest is None:
                        break
                    del self._session_streams[oldest]

                async def wrapped_emit(evt: dict[str, Any]) -> None:
                    if cmd == "handoff.send" and evt.get("type") == "Accepted":
                        evt = {**evt, "handoffSummary": str(frame.get("summary") or frame.get("text") or ""),
                               "handoffSource": str(frame.get("sourceSessionKey") or "")[:512]}
                    if evt.get("runId"):
                        turn_state["runId"] = str(evt["runId"])
                        stream.run_id = turn_state["runId"]
                        if prompt is not None:
                            prompt.turn_id = stream.run_id
                    if evt.get("type") == "Completed" and not turn_state["checkpointed"]:
                        turn_state["checkpointed"] = True
                        if before_tree and not options.get("readOnly"):
                            after_tree = await asyncio.to_thread(
                                create_git_checkpoint, session_dir, self.config.allowed_roots
                            )
                            if after_tree and after_tree != before_tree:
                                cp_id = f"cp-{uuid4().hex[:8]}"
                                diff_data = await asyncio.to_thread(
                                    get_workspace_diff,
                                    session_dir,
                                    self.config.allowed_roots,
                                    base_tree=before_tree,
                                    target_tree=after_tree,
                                )
                                run_id_eff = turn_state["runId"] or str(evt.get("runId") or "")
                                self._checkpoints[(provider, sid, cp_id)] = {
                                    "checkpointId": cp_id,
                                    "provider": provider,
                                    "sessionId": sid,
                                    "cwd": str(session_dir),
                                    "beforeTree": before_tree,
                                    "afterTree": after_tree,
                                    "runId": run_id_eff,
                                    "requestId": eff_req_id,
                                    "summary": diff_data.get("summary") or {},
                                }
                                self._checkpoint_order.setdefault((provider, sid), []).append(cp_id)
                                await base_emit(
                                    {
                                        "type": "CheckpointCreated",
                                        "sessionId": sid,
                                        "checkpointId": cp_id,
                                        **({"runId": run_id_eff} if run_id_eff else {}),
                                        "requestId": eff_req_id,
                                        "summary": diff_data.get("summary") or {},
                                    }
                                )
                                await base_emit(
                                    {
                                        "type": "DiffSnapshot",
                                        "sessionId": sid,
                                        **({"runId": run_id_eff} if run_id_eff else {}),
                                        "cwd": str(session_dir),
                                        "perTurn": True,
                                        **diff_data,
                                    }
                                )
                    if prompt is None:
                        await base_emit(stream.append(evt))
                    else:
                        await self._send_ws(ws, evt, provider=provider, stream=stream, prompt=prompt)
                    if watch_idle:
                        if evt.get("type") == "Accepted":
                            self._idle_transcripts.setdefault(sid, IdleTranscript())
                        if idle := self._idle_transcripts.get(sid):
                            idle.last_event_at = time.monotonic()

                extra_kwargs = {"options": runtime} if runtime else {}
                try:
                    await adapter.send_prompt(
                        session_id=sid,
                        text=text,
                        request_id=eff_req_id,
                        emit=wrapped_emit,
                        request_approval=on_approval,
                        attachments=atts,
                        **extra_kwargs,
                    )
                except Exception as err:
                    _LOG.exception("prompt failed (provider=%s)", provider)
                    await wrapped_emit({
                        "type": "Failed", "sessionId": sid, "requestId": eff_req_id,
                        "runId": turn_state["runId"] or eff_req_id,
                        "code": "path_forbidden" if isinstance(err, PathOutsideAllowedRootsError) else "node_execution_error",
                        "message": str(err) or type(err).__name__,
                    })
                finally:
                    self._active_runs.discard(run_key)
            elif cmd == "prompt.steer":
                sid = str(frame.get("sessionId") or "")
                text = str(frame.get("text") or "").strip()
                steer_fn = getattr(adapter, "steer", None)
                if provider != "hermes" or not text or steer_fn is None:
                    await send_back({"type": "SteerRejected", "sessionId": sid,
                                     "code": "unsupported", "message": "当前 Agent 不支持插话"})
                    return
                key = (provider, sid)
                external_steer = None
                if key not in self._active_runs and sid and isinstance(adapter, HermesWsAdapter):
                    with suppress(Exception):
                        if await adapter.session_running(session_id=sid) is True:
                            external_steer = adapter.steer_external
                local_active = key in self._active_runs
                if not local_active:
                    if external_steer is None:
                        await send_back({"type": "SteerRejected", "sessionId": sid,
                                         "code": "idle", "message": "当前没有运行中的回合"})
                        return
                    steer_fn = external_steer
                try:
                    ok = await steer_fn(session_id=sid, text=text)
                except Exception as exc:  # noqa: BLE001
                    if local_active:
                        await send_back({"type": "SteerRejected", "sessionId": sid,
                                         "code": "failed", "message": str(exc)[:200]})
                        return
                    _LOG.debug("Hermes external steer failed: %s", type(exc).__name__)
                    ok = False
                await send_back({"type": "SteerAccepted" if ok else "SteerRejected",
                                 "sessionId": sid, "code": "" if ok else "not_redirected",
                                 "message": "" if ok else "上游未接受插话（可能已排队）"})
                return
            elif cmd == "prompt.cancel":
                sid = str(frame.get("sessionId") or "")
                key = (provider, sid)
                reply = {"type": "RunStopStatus", "provider": provider, "sessionId": sid, "runId": frame.get("runId")}
                if key not in self._active_runs:
                    await send_back({**reply, "status": "error", "message": "当前会话已无运行中的任务"})
                    return
                try:
                    await adapter.cancel(session_id=sid, run_id=frame.get("runId"))
                except Exception:
                    _LOG.exception("cancel failed (provider=%s)", provider)
                    await send_back({**reply, "status": "error", "message": "代理未接受停止请求"})
                    return
                for call_id, event in list(self._pending_approval_events.items()):
                    if (event["provider"], event["sessionId"]) == key:
                        pending = self._pending_approvals.get(call_id)
                        if pending and not pending.done():
                            pending.set_result("deny")
                await send_back({**reply, "status": "accepted"})
        except PathOutsideAllowedRootsError as err:
            await send_back(
                {
                    "type": "Failed",
                    "code": "path_forbidden",
                    "provider": provider,
                    **({"sessionId": frame.get("sessionId")} if frame.get("sessionId") else {}),
                    **({"requestId": frame.get("requestId")} if frame.get("requestId") else {}),
                    "message": str(err),
                }
            )
        except Exception as err:
            # 空的 str(err) 会让 app 只显示一个没有原因的 node_execution_error，
            # 所以把完整堆栈写进节点日志，排查时不用再猜。
            _LOG.exception("command %s failed (provider=%s)", frame.get("type"), provider)
            detail = str(err) or type(err).__name__
            await send_back(
                {
                    "type": "Failed",
                    "code": "node_execution_error",
                    "provider": provider,
                    "sessionId": frame.get("sessionId"),
                    **({"requestId": frame.get("requestId")} if frame.get("requestId") else {}),
                    "message": detail,
                }
            )

    async def _poll_idle_transcripts(self, ws: Any, node_id: str | None) -> None:
        adapter = self.adapters.get("hermes")
        if not hasattr(adapter, "fetch_transcript"):
            return

        def busy(sid: str, state: IdleTranscript) -> bool:
            key = ("hermes", sid)
            return (key in self._active_runs or key in self._compacting_sessions
                    or time.monotonic() - state.last_event_at < 5)

        for sid, state in list(self._idle_transcripts.items()):
            if self._idle_transcripts.get(sid) is not state or busy(sid, state):
                continue
            rows = await adapter.fetch_transcript(session_id=sid)
            if self._idle_transcripts.get(sid) is not state or busy(sid, state):
                continue
            unseen = [row for row in rows if row["id"] and row["id"] not in state.seen]
            latest = next((row for row in reversed(unseen) if row["role"] == "assistant" and row["text"]
                           and (state.seen or row["created_at"] is None or row["created_at"] >= state.opened_at)), None)
            if latest is not None:
                msg_id = latest["id"]
                await self._send_ws(ws, {"type": "TextDelta", "nodeId": node_id, "provider": "hermes", "sessionId": sid,
                                         "text": latest["text"], "messageId": msg_id, "idle": True,
                                         "requestId": f"idle-{msg_id}"})
            state.seen.extend(row["id"] for row in unseen)

    async def _idle_transcript_watcher(self, ws: Any, node_id: str | None) -> None:
        try:
            while True:
                await asyncio.sleep(IDLE_TRANSCRIPT_INTERVAL_SECONDS)
                await self._poll_idle_transcripts(ws, node_id)
        except websockets.ConnectionClosed:
            return

    async def run_once(self) -> None:
        hello = await self.build_hello()
        async with websockets.connect(self.config.ws_url, open_timeout=10.0) as ws:
            await self._send_ws(ws, {"type": "auth", "token": self.config.node_token, "hello": hello})
            ready = json.loads(await ws.recv())
            if ready.get("type") != "NodeReady":
                raise RuntimeError(f"Unexpected handshake frame: {ready}")
            if ready.get("nodeId"):
                self._command_scope = sha256(f"{self.config.core_url}\n{ready['nodeId']}".encode()).hexdigest()

            async def send_effort_update(event: dict[str, Any]) -> None:
                try:
                    await self._send_ws(ws, event)
                except websockets.ConnectionClosed:
                    pass

            hermes = self.adapters.get("hermes")
            if isinstance(hermes, HermesAdapter):
                hermes.on_effort_update = send_effort_update

            async def heartbeat_loop() -> None:
                while True:
                    await asyncio.sleep(30.0)
                    await self._send_ws(ws, {"type": "NodeHeartbeat", "adapters": await self.probe_adapters()})

            hb_task = asyncio.create_task(heartbeat_loop())
            idle_task = asyncio.create_task(self._idle_transcript_watcher(ws, ready.get("nodeId")))
            bg_tasks: set[asyncio.Task[None]] = set()
            try:
                async for raw in ws:
                    frame = json.loads(raw)
                    if not isinstance(frame, dict):
                        continue
                    task = asyncio.create_task(self.handle_command(ws, frame, node_id=ready.get("nodeId")))
                    bg_tasks.add(task)
                    task.add_done_callback(bg_tasks.discard)
            finally:
                if isinstance(hermes, HermesAdapter):
                    hermes.on_effort_update = None
                hb_task.cancel()
                idle_task.cancel()
                for t in list(bg_tasks):
                    t.cancel()
                await asyncio.gather(hb_task, idle_task, *bg_tasks, return_exceptions=True)
                await self.port_previews.close()

    async def run_forever(self) -> None:
        direct_server: uvicorn.Server | None = None
        direct_task: asyncio.Task[None] | None = None
        if self.direct_store is not None:
            app = create_direct_transfer_app(self.direct_store)
            uv_cfg = uvicorn.Config(
                app,
                host=self.config.direct.bind_host,
                port=self.config.direct.port,
                log_level="warning",
            )
            direct_server = uvicorn.Server(uv_cfg)
            direct_task = asyncio.create_task(direct_server.serve())

        backoff = 1.0
        try:
            while True:
                try:
                    await self.run_once()
                    backoff = 1.0
                except Exception:
                    await asyncio.sleep(backoff)
                    backoff = min(30.0, backoff * 2.0)
        finally:
            await self.terminal_manager.close_all()
            await asyncio.gather(*(a.close() for a in self.adapters.values()), return_exceptions=True)
            if self._session_event_log is not None:
                await asyncio.to_thread(self._session_event_log.store.close)
            if direct_server is not None:
                direct_server.should_exit = True
            if direct_task is not None:
                await direct_task
