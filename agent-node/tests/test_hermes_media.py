import asyncio
from hashlib import sha256
from os.path import relpath
from pathlib import Path

import httpx
import pytest

from agent_node.config import HermesMediaConfig, NodeConfig
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
