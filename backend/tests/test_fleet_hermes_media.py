from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
from time import sleep

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
