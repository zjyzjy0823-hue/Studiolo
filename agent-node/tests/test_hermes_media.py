import asyncio
from hashlib import sha256
import json
import logging
import os
from os.path import relpath
from pathlib import Path
from unittest.mock import AsyncMock

import httpx
import pytest

from agent_node.adapters.hermes import HermesAdapter
from agent_node.alist_publish import PublishConfig, PublishError, PublishResult
from agent_node.config import HermesMediaConfig, NodeConfig, load_node_config
from agent_node.daemon import AgentNodeDaemon
from agent_node.hermes_media import MediaError, open_session_file, relay_hermes_attachment


@pytest.mark.parametrize("use_home", [False, True], ids=["absolute", "home-expanded"])
def test_open_session_file_allows_absolute_reference_outside_cwd(tmp_path, monkeypatch, use_home):
    root = tmp_path.resolve()
    cwd = root / "session"
    cwd.mkdir()
    source = root / "report.html"
    document = b"<p>Report</p>"
    source.write_bytes(document)
    monkeypatch.setenv("HOME", str(root))
    reference = f"~/{source.name}" if use_home else str(source)

    with open_session_file(reference, str(cwd), (root,), 1024) as (path, handle, size):
        assert path == source
        assert size == len(document)
        assert handle.read() == document


def test_open_session_file_rejects_relative_reference_outside_cwd(tmp_path):
    root = tmp_path.resolve()
    cwd = root / "session"
    cwd.mkdir()
    (root / "report.html").write_bytes(b"<p>Report</p>")

    with pytest.raises(MediaError, match="^media_forbidden$"):
        with open_session_file("../report.html", str(cwd), (root,), 1024):
            pytest.fail("Opened a relative reference outside the session cwd")


def test_open_session_file_rejects_absolute_reference_outside_allowed_roots(tmp_path):
    root = tmp_path.resolve() / "allowed"
    root.mkdir()
    source = root.parent / "report.html"
    source.write_bytes(b"<p>Report</p>")

    with pytest.raises(MediaError, match="^media_forbidden$"):
        with open_session_file(str(source), str(root), (root,), 1024):
            pytest.fail("Opened an absolute reference outside allowedRoots")


@pytest.mark.parametrize(("reference", "scenario", "expected"), [
    ("./report.html", "history", None),
    ("absolute", "live", None),
    ("home", "history", None),
    ("./report.html", "other_session", "media_forbidden"),
    ("./report.html", "user_reference", "media_forbidden"),
    ("./report.html", "different_node", "media_forbidden"),
    ("../outside.html", "history", "media_forbidden"),
    ("./link.html", "history", "media_forbidden"),
    ("./missing.html", "history", "media_missing"),
    ("./report.html", "too_large", "media_too_large"),
    ("./report.html", "changed", "media_changed"),
])
def test_hermes_media_uses_only_session_owned_regular_files(tmp_path, reference, scenario, expected):
    root = tmp_path.resolve()
    cwd = root / "session"
    cwd.mkdir()
    token_file = root / "credential"
    token_file.write_text("test-session-token")
    document = b"<section><h1>Report</h1></section>" * 11250
    source = cwd / "report.html"
    source.write_bytes(document)
    outside = root / "outside.html"
    outside.write_bytes(b"<p>Other session</p>")
    (cwd / "link.html").symlink_to(outside)
    reference = {"absolute": str(source), "home": f"~/{relpath(source, Path.home())}"}.get(reference, reference)
    frame = {"nodeId": "owning-node", "provider": "hermes", "sessionId": "chat-1", "reference": reference,
             "transferId": "0" * 32, "maxBytes": 1024 if scenario == "too_large" else 1024 * 1024}
    node = NodeConfig("https://core.example", "sn_live_testing", (root,),
                      hermes_media=HermesMediaConfig("http://127.0.0.1", token_file))
    message = {"role": "user" if scenario == "user_reference" else "assistant", "content": f'MEDIA: "{reference}"',
               "session_id": "chat-2" if scenario == "other_session" else "chat-1"}
    uploaded = []
    upstream_routes = []

    async def hermes(request):
        assert request.headers["X-Hermes-Session-Token"] == "test-session-token"
        assert "token" not in request.url.params
        upstream_routes.append(request.url.path)
        if request.url.path == "/api/sessions/chat-1":
            return httpx.Response(200, json={"id": "chat-1", "cwd": str(cwd)})
        if request.url.path == "/api/sessions/chat-1/messages":
            return httpx.Response(200, json={"session_id": "chat-1", "messages": [message]})
        assert request.url.path == "/api/files/download"
        assert Path(request.url.params["path"]) == source
        return httpx.Response(200, content=(b"x" + document[1:] if scenario == "changed" else document))

    async def core(request):
        assert request.method == "PUT"
        assert request.url.path == "/api/v1/fleet/media/relay/" + frame["transferId"]
        assert "X-Hermes-Session-Token" not in request.headers
        assert request.headers.get("transfer-encoding") is None
        assert request.headers["content-length"] == str(len(document))
        uploaded.append(await request.aread())
        return httpx.Response(204)

    def run():
        return asyncio.run(relay_hermes_attachment(
            node, frame, "different-node" if scenario == "different_node" else "owning-node",
            [message] if scenario == "live" else [],
            transport=httpx.MockTransport(hermes), core_transport=httpx.MockTransport(core),
        ))

    if expected:
        with pytest.raises(MediaError, match=f"^{expected}$"):
            run()
        assert uploaded == []
        if scenario != "changed":
            assert "/api/files/download" not in upstream_routes
    else:
        assert run() == {"fileName": source.name, "sizeBytes": len(document)}
        assert sha256(uploaded[0]).digest() == sha256(source.read_bytes()).digest()
        if scenario == "live":
            assert "/api/sessions/chat-1/messages" not in upstream_routes


def _make_alist_env(tmp_path, content: bytes, *, alist: PublishConfig | None, max_bytes: int = 1024 * 1024):
    root = tmp_path.resolve()
    cwd = root / "session"
    cwd.mkdir(parents=True, exist_ok=True)
    token_file = root / "credential"
    token_file.write_text("test-session-token")
    source = cwd / "big.bin"
    source.write_bytes(content)
    frame = {
        "nodeId": "owning-node",
        "provider": "hermes",
        "sessionId": "chat-1",
        "reference": "./big.bin",
        "transferId": "a" * 32,
        "maxBytes": max_bytes,
    }
    node = NodeConfig(
        "https://core.example",
        "sn_live_testing",
        (root,),
        hermes_media=HermesMediaConfig("http://127.0.0.1", token_file, max_bytes=max_bytes),
        alist=alist,
    )
    message = {"role": "assistant", "content": 'MEDIA: "./big.bin"', "session_id": "chat-1"}
    upstream_routes: list[str] = []
    core_uploads: list[bytes] = []

    async def hermes(request):
        upstream_routes.append(request.url.path)
        if request.url.path == "/api/sessions/chat-1":
            return httpx.Response(200, json={"id": "chat-1", "cwd": str(cwd)})
        if request.url.path == "/api/files/download":
            return httpx.Response(200, content=source.read_bytes())
        raise AssertionError(f"Unexpected upstream path: {request.url.path}")

    async def core(request):
        core_uploads.append(await request.aread())
        return httpx.Response(204)

    return root, cwd, source, frame, node, [message], upstream_routes, core_uploads, hermes, core


def test_load_node_config_optional_alist_section(tmp_path):
    root = tmp_path / "allowed"
    root.mkdir()
    base_cfg = {
        "coreUrl": "https://core.example",
        "nodeToken": "sn_live_testing_token",
        "allowedRoots": [str(root)],
    }
    no_alist = tmp_path / "no-alist.json"
    no_alist.write_text(json.dumps(base_cfg), encoding="utf-8")
    loaded_none = load_node_config(no_alist, environ={})
    assert loaded_none.alist is None

    with_defaults = tmp_path / "alist-defaults.json"
    with_defaults.write_text(
        json.dumps({**base_cfg, "alist": {"baseUrl": "https://dl.isidel.com/", "token": "secret-tok"}}),
        encoding="utf-8",
    )
    loaded_def = load_node_config(with_defaults, environ={})
    assert loaded_def.alist is not None
    assert loaded_def.alist.base_url == "https://dl.isidel.com"
    assert loaded_def.alist.token == "secret-tok"
    assert loaded_def.alist.mount_path == "/dl"
    assert loaded_def.alist.ttl_seconds == 86400
    assert loaded_def.alist.threshold_bytes == 32 * 1024 * 1024

    with_custom = tmp_path / "alist-custom.json"
    with_custom.write_text(
        json.dumps({
            **base_cfg,
            "alist": {
                "baseUrl": "https://dl.isidel.com",
                "token": "secret-tok",
                "mountPath": "/custom",
                "hosts": ["https://dl.isidel.com", "https://alist.isidel.com"],
                "ttlSeconds": 3600,
                "thresholdBytes": 1024,
            },
        }),
        encoding="utf-8",
    )
    loaded_custom = load_node_config(with_custom, environ={})
    assert loaded_custom.alist is not None
    assert loaded_custom.alist.mount_path == "/custom"
    assert loaded_custom.alist.hosts == ("https://dl.isidel.com", "https://alist.isidel.com")
    assert loaded_custom.alist.ttl_seconds == 3600
    assert loaded_custom.alist.threshold_bytes == 1024


def test_hermes_media_over_threshold_with_alist_uses_external_without_reading_bytes(tmp_path, monkeypatch):
    payload = b"X" * 2048
    alist = PublishConfig(base_url="https://dl.isidel.com", token="tok", threshold_bytes=1024)
    _, _, source, frame, node, history, upstream_routes, core_uploads, hermes, core = _make_alist_env(
        tmp_path, payload, alist=alist, max_bytes=1024,
    )
    published_paths: list[Path] = []

    class FakePublisher:
        def publish(self, path):
            published_paths.append(Path(path))
            return PublishResult(
                url="https://dl.isidel.com/p/dl/deadbeef-big.bin?sign=abc:1800000000",
                host="https://dl.isidel.com",
                remote_path="/dl/deadbeef-big.bin",
                size=len(payload),
                expires_at=1800000000,
                uploaded=True,
            )

    # 确认走外链路径时不会从打开的文件句柄读取任何字节
    orig_fdopen = os.fdopen

    def guarded_fdopen(fd, mode="r", *args, **kwargs):
        handle = orig_fdopen(fd, mode, *args, **kwargs)
        orig_read = handle.read

        def forbid_read(*r_args, **r_kwargs):
            raise AssertionError("External publish path must not read file bytes via relay handle")

        handle.read = forbid_read  # type: ignore[method-assign]
        assert orig_read is not None
        return handle

    monkeypatch.setattr(os, "fdopen", guarded_fdopen)
    cache: dict = {}
    result = asyncio.run(relay_hermes_attachment(
        node, frame, "owning-node", history,
        transport=httpx.MockTransport(hermes),
        core_transport=httpx.MockTransport(core),
        publisher=FakePublisher(),
        publish_cache=cache,
        clock=lambda: 1700000000.0,
    ))
    assert result == {
        "external": True,
        "url": "https://dl.isidel.com/p/dl/deadbeef-big.bin?sign=abc:1800000000",
        "expiresAt": 1800000000,
        "sizeBytes": 2048,
        "fileName": "big.bin",
    }
    assert published_paths == [source]
    assert "/api/files/download" not in upstream_routes
    assert core_uploads == []


def test_hermes_media_without_alist_keeps_original_relay_path(tmp_path):
    payload = b"Y" * 512
    _, _, _, frame, node, history, upstream_routes, core_uploads, hermes, core = _make_alist_env(
        tmp_path, payload, alist=None, max_bytes=1024,
    )
    result = asyncio.run(relay_hermes_attachment(
        node, frame, "owning-node", history,
        transport=httpx.MockTransport(hermes),
        core_transport=httpx.MockTransport(core),
    ))
    assert result == {"fileName": "big.bin", "sizeBytes": 512}
    assert "external" not in result
    assert "/api/files/download" in upstream_routes
    assert core_uploads == [payload]


def test_hermes_media_equal_to_threshold_uses_relay_not_alist(tmp_path):
    payload = b"E" * 1024
    alist = PublishConfig(base_url="https://dl.isidel.com", token="tok", threshold_bytes=1024)
    _, _, _, frame, node, history, upstream_routes, core_uploads, hermes, core = _make_alist_env(
        tmp_path, payload, alist=alist, max_bytes=1024,
    )
    publish_calls = 0

    class FakePublisher:
        def publish(self, path):
            nonlocal publish_calls
            publish_calls += 1
            raise AssertionError("Publisher must not be called when size == thresholdBytes")

    result = asyncio.run(relay_hermes_attachment(
        node, frame, "owning-node", history,
        transport=httpx.MockTransport(hermes),
        core_transport=httpx.MockTransport(core),
        publisher=FakePublisher(),
        publish_cache={},
    ))
    assert result == {"fileName": "big.bin", "sizeBytes": 1024}
    assert publish_calls == 0
    assert "/api/files/download" in upstream_routes
    assert core_uploads == [payload]


def test_hermes_media_alist_publish_error_falls_back_to_relay_and_preserves_too_large(tmp_path, caplog):
    payload = b"F" * 2048
    alist = PublishConfig(base_url="https://dl.isidel.com", token="tok", threshold_bytes=1024)

    class BrokenPublisher:
        def publish(self, path):
            raise PublishError("AList unreachable")

    # 1) 文件在 relay max_bytes 内时：记 warning 并成功回退中继
    _, _, _, frame_ok, node_ok, history_ok, upstream_ok, uploads_ok, hermes_ok, core_ok = _make_alist_env(
        tmp_path / "within", payload, alist=alist, max_bytes=4096,
    )
    with caplog.at_level(logging.WARNING, logger="agent_node.hermes_media"):
        res = asyncio.run(relay_hermes_attachment(
            node_ok, frame_ok, "owning-node", history_ok,
            transport=httpx.MockTransport(hermes_ok),
            core_transport=httpx.MockTransport(core_ok),
            publisher=BrokenPublisher(),
            publish_cache={},
        ))
    assert res == {"fileName": "big.bin", "sizeBytes": 2048}
    assert "/api/files/download" in upstream_ok
    assert uploads_ok == [payload]
    assert any("AList publish failed" in rec.message for rec in caplog.records)

    # 2) 文件超过 relay max_bytes 时：记 warning 并保留原错误码 media_too_large
    _, _, _, frame_big, node_big, history_big, upstream_big, uploads_big, hermes_big, core_big = _make_alist_env(
        tmp_path / "over", payload, alist=alist, max_bytes=1024,
    )
    caplog.clear()
    with caplog.at_level(logging.WARNING, logger="agent_node.hermes_media"):
        with pytest.raises(MediaError, match="^media_too_large$"):
            asyncio.run(relay_hermes_attachment(
                node_big, frame_big, "owning-node", history_big,
                transport=httpx.MockTransport(hermes_big),
                core_transport=httpx.MockTransport(core_big),
                publisher=BrokenPublisher(),
                publish_cache={},
            ))
    assert "/api/files/download" not in upstream_big
    assert uploads_big == []
    assert any("AList publish failed" in rec.message for rec in caplog.records)


def test_hermes_media_external_link_cache_reuses_until_expired_or_modified(tmp_path):
    payload = b"C" * 2048
    alist = PublishConfig(base_url="https://dl.isidel.com", token="tok", threshold_bytes=1024)
    _, _, source, frame, node, history, _, _, hermes, core = _make_alist_env(
        tmp_path, payload, alist=alist, max_bytes=1024,
    )
    now = [1700000000.0]
    calls = 0

    class CountingPublisher:
        def publish(self, path):
            nonlocal calls
            calls += 1
            expire = int(now[0]) + 3600
            return PublishResult(
                url=f"https://dl.isidel.com/p/dl/c{calls}-big.bin?sign=s{calls}:{expire}",
                host="https://dl.isidel.com",
                remote_path=f"/dl/c{calls}-big.bin",
                size=Path(path).stat().st_size,
                expires_at=expire,
                uploaded=True,
            )

    pub = CountingPublisher()
    cache: dict = {}

    def run_once():
        return asyncio.run(relay_hermes_attachment(
            node, frame, "owning-node", history,
            transport=httpx.MockTransport(hermes),
            core_transport=httpx.MockTransport(core),
            publisher=pub,
            publish_cache=cache,
            clock=lambda: now[0],
        ))

    first = run_once()
    second = run_once()
    assert calls == 1
    assert second == first

    # 过期后应重新发布
    now[0] = float(first["expiresAt"]) + 1.0
    third = run_once()
    assert calls == 2
    assert third["url"] != first["url"]

    # 文件内容/mtime 变化后应重新发布
    source.write_bytes(b"D" * 2050)
    fourth = run_once()
    assert calls == 3
    assert fourth["sizeBytes"] == 2050


def test_hermes_media_alist_never_bypasses_open_session_file_symlink_guard(tmp_path):
    payload = b"S" * 2048
    alist = PublishConfig(base_url="https://dl.isidel.com", token="tok", threshold_bytes=1024)
    root, cwd, _, frame, node, _, _, _, hermes, core = _make_alist_env(
        tmp_path, payload, alist=alist, max_bytes=1024,
    )
    outside = root / "outside-big.bin"
    outside.write_bytes(payload)
    (cwd / "symlink-big.bin").symlink_to(outside)
    symlink_frame = {**frame, "reference": "./symlink-big.bin"}
    history = [{"role": "assistant", "content": 'MEDIA: "./symlink-big.bin"', "session_id": "chat-1"}]
    called = False

    class GuardPublisher:
        def publish(self, path):
            nonlocal called
            called = True
            raise AssertionError("Symlink must be blocked before publishing")

    with pytest.raises(MediaError, match="^media_forbidden$"):
        asyncio.run(relay_hermes_attachment(
            node, symlink_frame, "owning-node", history,
            transport=httpx.MockTransport(hermes),
            core_transport=httpx.MockTransport(core),
            publisher=GuardPublisher(),
            publish_cache={},
        ))
    assert called is False


def test_daemon_hermes_media_relay_reuses_alist_cache(tmp_path, monkeypatch):
    payload = b"M" * 2048
    alist = PublishConfig(base_url="https://dl.isidel.com", token="tok", threshold_bytes=1024)
    _, _, _, frame, node, history, _, _, hermes, core = _make_alist_env(
        tmp_path, payload, alist=alist, max_bytes=1024,
    )

    class StubHermesAdapter(HermesAdapter):
        def __init__(self):
            pass

        def live_attachment_history(self, session_id: str):
            return history

        def attachment_writes(self, session_id: str):
            return frozenset()

    calls = 0

    class FakePublisher:
        def publish(self, path):
            nonlocal calls
            calls += 1
            return PublishResult(
                url="https://dl.isidel.com/p/dl/daemon-big.bin?sign=sig:4102444800",
                host="https://dl.isidel.com",
                remote_path="/dl/daemon-big.bin",
                size=len(payload),
                expires_at=4102444800,
                uploaded=True,
            )

    daemon = AgentNodeDaemon(node, adapters={"hermes": StubHermesAdapter()}, staging_dir=tmp_path / "stage")
    daemon._alist_publisher = FakePublisher()  # type: ignore[assignment]

    async def patched_relay(*args, **kwargs):
        return await relay_hermes_attachment(
            *args, **kwargs,
            transport=httpx.MockTransport(hermes),
            core_transport=httpx.MockTransport(core),
        )

    monkeypatch.setattr("agent_node.daemon.relay_hermes_attachment", patched_relay)
    ws = AsyncMock()
    cmd = {"type": "hermes.media.relay", "_rpcId": "rpc-1", **frame}
    asyncio.run(daemon.handle_command(ws, cmd, node_id="owning-node"))
    asyncio.run(daemon.handle_command(ws, {**cmd, "_rpcId": "rpc-2"}, node_id="owning-node"))
    assert calls == 1
    assert ws.send.await_count == 2
    first_out = json.loads(ws.send.await_args_list[0].args[0])
    second_out = json.loads(ws.send.await_args_list[1].args[0])
    assert first_out["ok"] is True and first_out["external"] is True
    assert first_out["url"] == "https://dl.isidel.com/p/dl/daemon-big.bin?sign=sig:4102444800"
    assert first_out["expiresAt"] == 4102444800
    assert first_out["sizeBytes"] == 2048
    assert first_out["fileName"] == "big.bin"
    assert second_out["url"] == first_out["url"]
