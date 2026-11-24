from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
import logging
from time import sleep, time

MEDIA = "/api/v1/fleet/media"
NODES = "/api/v1/fleet/nodes"


def create_node(client, owner, name):
    response = client.post(NODES, headers=owner, json={"name": name, "platform": "macos"})
    assert response.status_code == 201
    result = response.json()
    return result["node"]["id"], {"Authorization": f"Bearer {result['nodeToken']}"}


def test_hermes_media_resolves_through_node_and_redeems_once(client, users, monkeypatch):
    owner, stranger = users
    node, node_auth = create_node(client, owner, "Hermes")
    _, other_node_auth = create_node(client, owner, "Different node")
    hello = {"adapters": [{"provider": "hermes", "status": "ready", "capabilities": ["hermes-media-v1"]}]}
    payload = {"nodeId": node, "provider": "hermes", "sessionId": "native-chat", "reference": "./sample.html",
               "purpose": "download"}
    response = client.post(f"{MEDIA}/resolve", headers=stranger, json=payload)
    assert response.status_code == 404

    with client.websocket_connect("/ws/fleet/node", headers=node_auth) as legacy_ws:
        assert legacy_ws.receive_json()["type"] == "NodeReady"
        response = client.post(f"{MEDIA}/resolve", headers=owner, json=payload)
        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "media_unsupported"

    resolve = lambda fields: client.post(f"{MEDIA}/resolve", headers=owner, json=fields)
    def redeem(ticket, headers=owner):
        return client.post(f"{MEDIA}/redeem", headers=headers, json={"ticket": ticket})

    report = b"<p>Full attachment</p>" * 16365
    png = bytes.fromhex(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
        "0000000a49444154789c636000000002000148afa4710000000049454e44ae426082"
    )
    with client.websocket_connect("/ws/fleet/node") as ws, ThreadPoolExecutor() as pool:
        ws.send_json({"type": "auth", "token": node_auth["Authorization"].split()[1], "hello": hello})
        assert ws.receive_json()["type"] == "NodeReady"

        def stage(purpose, name, data, *, assertions=False):
            request = {**payload, "purpose": purpose, "reference": f"./{name}"}
            pending = pool.submit(resolve, request)
            command = ws.receive_json()
            assert all(command[field] == value for field, value in request.items())
            assert command["type"] == "hermes.media.relay"
            assert command["maxBytes"] == 32 * 1024 * 1024
            url = f"{MEDIA}/relay/{command['transferId']}"
            if assertions:
                assert client.put(url, headers=owner, content=data).status_code == 403
                assert client.put(url, headers=other_node_auth, content=data).status_code == 403
            assert client.put(url, headers=node_auth, content=data).status_code == 204
            ws.send_json({"type": "HermesMediaResult", "_rpcId": command["_rpcId"], "ok": True,
                          "sessionId": command["sessionId"], "fileName": name, "sizeBytes": len(data)})
            response = pending.result(timeout=5)
            assert response.status_code == 200
            assert response.headers["Cache-Control"] == "no-store"
            assert set(response.json()) == {"ticket", "expiresIn", "sizeBytes"}
            assert response.json()["sizeBytes"] == len(data)
            return response.json()["ticket"]

        download = stage("download", "sample.html", report, assertions=True)
        assert redeem(download, stranger).status_code == 403
        html_response = redeem(download)
        assert html_response.status_code == 200
        assert html_response.headers["Content-Disposition"].startswith("attachment;")
        assert html_response.headers["X-Content-Type-Options"] == "nosniff"
        assert sha256(html_response.content).digest() == sha256(report).digest()
        assert redeem(download).status_code == 410

        preview = redeem(stage("preview", "sample.png", png))
        assert preview.status_code == 200
        assert preview.headers["Content-Type"] == "image/png"
        assert preview.headers["Content-Disposition"].startswith("inline;")
        assert sha256(preview.content).digest() == sha256(png).digest()

        pending = pool.submit(resolve, payload)
        command = ws.receive_json()
        ws.send_json({"type": "HermesMediaResult", "_rpcId": command["_rpcId"], "ok": False, "code": "media_forbidden"})
        assert pending.result(timeout=5).status_code == 403

        monkeypatch.setattr(client.app.state.hermes_media, "ticket_seconds", 0.01)
        expired = stage("download", "sample.html", report)
        sleep(0.025)
        assert redeem(expired).status_code == 410


def test_hermes_media_external_transfer_redirects_307_and_audits_without_sign(client, users, monkeypatch, caplog):
    owner, stranger = users
    node, node_auth = create_node(client, owner, "Hermes External")
    hello = {"adapters": [{"provider": "hermes", "status": "ready", "capabilities": ["hermes-media-v1"]}]}
    payload = {
        "nodeId": node,
        "provider": "hermes",
        "sessionId": "native-chat",
        "reference": "./archive.tar.gz",
        "purpose": "download",
    }
    signed_url = "https://dl.isidel.com/p/dl/abcd1234-archive.tar.gz?sign=SECRET_SIG_TOKEN:4102444800"
    expires_at = int(time()) + 3600
    big_size = 64 * 1024 * 1024

    audit_log = logging.getLogger("test.studiolo.audit.core")
    audit_log.setLevel(logging.INFO)
    audit_log.propagate = True
    monkeypatch.setattr("app.fleet.audit.audit_logger", lambda: audit_log)

    with client.websocket_connect("/ws/fleet/node") as ws, ThreadPoolExecutor() as pool:
        ws.send_json({"type": "auth", "token": node_auth["Authorization"].split()[1], "hello": hello})
        assert ws.receive_json()["type"] == "NodeReady"

        pending = pool.submit(client.post, f"{MEDIA}/resolve", headers=owner, json=payload)
        command = ws.receive_json()
        assert command["type"] == "hermes.media.relay"
        # 外链型 transfer 不向 Core PUT 任何字节，直接回传外链元数据
        ws.send_json({
            "type": "HermesMediaResult",
            "_rpcId": command["_rpcId"],
            "ok": True,
            "external": True,
            "sessionId": command["sessionId"],
            "url": signed_url,
            "expiresAt": expires_at,
            "sizeBytes": big_size,
            "fileName": "archive.tar.gz",
        })
        resolved = pending.result(timeout=5)
        assert resolved.status_code == 200
        assert resolved.headers["Cache-Control"] == "no-store"
        body = resolved.json()
        assert set(body) == {"ticket", "expiresIn", "sizeBytes"}
        assert body["sizeBytes"] == big_size
        ticket = body["ticket"]

        # 外链型 transfer 必须拒绝 accept_bytes（禁止混用中继字节流）
        reject_bytes = client.put(
            f"{MEDIA}/relay/{ticket}",
            headers=node_auth,
            content=b"should-not-be-accepted",
        )
        assert reject_bytes.status_code == 409
        assert reject_bytes.json()["detail"]["code"] == "media_external_no_bytes"

        # 他人无法兑换
        assert client.post(
            f"{MEDIA}/redeem", headers=stranger, json={"ticket": ticket}, follow_redirects=False,
        ).status_code == 403

        # 下载端点返回 307 + Location + Cache-Control: no-store，并记录脱敏后的 media_external 审计事件
        with caplog.at_level(logging.INFO, logger="test.studiolo.audit.core"):
            redirected = client.post(
                f"{MEDIA}/redeem", headers=owner, json={"ticket": ticket}, follow_redirects=False,
            )
        assert redirected.status_code == 307
        assert redirected.headers["Location"] == signed_url
        assert redirected.headers["Cache-Control"] == "no-store"

        audit_messages = [rec.getMessage() for rec in caplog.records if "type=media_external" in rec.getMessage()]
        assert len(audit_messages) == 1
        line = audit_messages[0]
        assert "host=dl.isidel.com" in line
        assert "path=/p/dl/abcd1234-archive.tar.gz" in line
        assert f"size={big_size}" in line
        assert f"expiresAt={expires_at}" in line
        assert "SECRET_SIG_TOKEN" not in line
        assert "sign=" not in line

        # 一次性票据：第二次兑换返回 410
        assert client.post(
            f"{MEDIA}/redeem", headers=owner, json={"ticket": ticket}, follow_redirects=False,
        ).status_code == 410


def test_hermes_media_external_transfer_expired_returns_410_not_307(client, users, monkeypatch):
    owner, _ = users
    node, node_auth = create_node(client, owner, "Hermes Expired External")
    hello = {"adapters": [{"provider": "hermes", "status": "ready", "capabilities": ["hermes-media-v1"]}]}
    payload = {
        "nodeId": node,
        "provider": "hermes",
        "sessionId": "native-chat",
        "reference": "./expired.bin",
        "purpose": "download",
    }
    now = [2000000000.0]
    monkeypatch.setattr(client.app.state.hermes_media, "_clock", lambda: now[0])

    with client.websocket_connect("/ws/fleet/node") as ws, ThreadPoolExecutor() as pool:
        ws.send_json({"type": "auth", "token": node_auth["Authorization"].split()[1], "hello": hello})
        assert ws.receive_json()["type"] == "NodeReady"

        pending = pool.submit(client.post, f"{MEDIA}/resolve", headers=owner, json=payload)
        command = ws.receive_json()
        ws.send_json({
            "type": "HermesMediaResult",
            "_rpcId": command["_rpcId"],
            "ok": True,
            "external": True,
            "sessionId": command["sessionId"],
            "url": "https://dl.isidel.com/p/dl/expired.bin?sign=sig:2000000010",
            "expiresAt": 2000000010,
            "sizeBytes": 40 * 1024 * 1024,
            "fileName": "expired.bin",
        })
        resolved = pending.result(timeout=5)
        assert resolved.status_code == 200
        ticket = resolved.json()["ticket"]

        # 票据本身未超 ticket_seconds，但外链 expiresAt 已过 → 必须返回 410 而非 307
        now[0] = 2000000010.0
        resp = client.post(
            f"{MEDIA}/redeem", headers=owner, json={"ticket": ticket}, follow_redirects=False,
        )
        assert resp.status_code == 410
        assert "Location" not in resp.headers
        assert resp.json()["detail"]["code"] == "media_ticket_gone"


def test_hermes_media_external_rejects_mixed_relay_bytes(client, users):
    owner, _ = users
    node, node_auth = create_node(client, owner, "Hermes Mixed")
    hello = {"adapters": [{"provider": "hermes", "status": "ready", "capabilities": ["hermes-media-v1"]}]}
    payload = {
        "nodeId": node,
        "provider": "hermes",
        "sessionId": "native-chat",
        "reference": "./mixed.bin",
        "purpose": "download",
    }

    with client.websocket_connect("/ws/fleet/node") as ws, ThreadPoolExecutor() as pool:
        ws.send_json({"type": "auth", "token": node_auth["Authorization"].split()[1], "hello": hello})
        assert ws.receive_json()["type"] == "NodeReady"

        pending = pool.submit(client.post, f"{MEDIA}/resolve", headers=owner, json=payload)
        command = ws.receive_json()
        # 如果节点先上传了字节又声称 external=True，必须被拒绝，防止混用两种语义
        assert client.put(
            f"{MEDIA}/relay/{command['transferId']}", headers=node_auth, content=b"relay-bytes",
        ).status_code == 204
        ws.send_json({
            "type": "HermesMediaResult",
            "_rpcId": command["_rpcId"],
            "ok": True,
            "external": True,
            "sessionId": command["sessionId"],
            "url": "https://dl.isidel.com/p/dl/mixed.bin?sign=sig:4102444800",
            "expiresAt": 4102444800,
            "sizeBytes": 11,
            "fileName": "mixed.bin",
        })
        resolved = pending.result(timeout=5)
        assert resolved.status_code == 502
        assert resolved.json()["detail"]["code"] == "media_relay_failed"


def test_hermes_media_external_json_mode_returns_link_instead_of_redirect(client, users, monkeypatch, caplog):
    owner, _stranger = users
    node, node_auth = create_node(client, owner, "Hermes External JSON")
    hello = {"adapters": [{"provider": "hermes", "status": "ready", "capabilities": ["hermes-media-v1"]}]}
    payload = {
        "nodeId": node,
        "provider": "hermes",
        "sessionId": "native-chat",
        "reference": "./archive.tar.gz",
        "purpose": "download",
    }
    signed_url = "https://dl.isidel.com/p/dl/abcd1234-archive.tar.gz?sign=SECRET_SIG_TOKEN:4102444800"
    expires_at = int(time()) + 3600
    big_size = 64 * 1024 * 1024

    audit_log = logging.getLogger("test.studiolo.audit.core.json")
    audit_log.setLevel(logging.INFO)
    audit_log.propagate = True
    monkeypatch.setattr("app.fleet.audit.audit_logger", lambda: audit_log)

    with client.websocket_connect("/ws/fleet/node") as ws, ThreadPoolExecutor() as pool:
        ws.send_json({"type": "auth", "token": node_auth["Authorization"].split()[1], "hello": hello})
        assert ws.receive_json()["type"] == "NodeReady"

        pending = pool.submit(client.post, f"{MEDIA}/resolve", headers=owner, json=payload)
        command = ws.receive_json()
        assert command["type"] == "hermes.media.relay"
        ws.send_json({
            "type": "HermesMediaResult",
            "_rpcId": command["_rpcId"],
            "ok": True,
            "external": True,
            "sessionId": command["sessionId"],
            "url": signed_url,
            "expiresAt": expires_at,
            "sizeBytes": big_size,
            "fileName": "archive.tar.gz",
        })
        resolved = pending.result(timeout=5)
        assert resolved.status_code == 200
        ticket = resolved.json()["ticket"]

        with caplog.at_level(logging.INFO, logger="test.studiolo.audit.core.json"):
            link = client.post(
                f"{MEDIA}/redeem",
                headers={**owner, "X-Studiolo-Media-Link": "1"},
                json={"ticket": ticket},
                follow_redirects=False,
            )
        assert link.status_code == 200
        assert link.headers["Cache-Control"] == "no-store"
        body = link.json()
        assert body["url"] == signed_url
        assert body["sizeBytes"] == big_size
        assert body["fileName"] == "archive.tar.gz"
        assert body["expiresAt"] == expires_at

        # 票据一次性：JSON 模式也消费掉票据，再次兑换 410
        again = client.post(
            f"{MEDIA}/redeem",
            headers={**owner, "X-Studiolo-Media-Link": "1"},
            json={"ticket": ticket},
            follow_redirects=False,
        )
        assert again.status_code == 410

        # 审计同样只记 host + path，不泄漏签名
        records = [r for r in caplog.records if "media_external" in r.getMessage()]
        assert records, "expected media_external audit record"
        assert "SECRET_SIG_TOKEN" not in records[-1].getMessage()
