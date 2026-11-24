from concurrent.futures import ThreadPoolExecutor
from unittest.mock import AsyncMock

import pytest

from app.fleet.hub import fleet_hub


NODES = "/api/v1/fleet/nodes"
SESSION = "recorded"
EPOCH = "opaque-gateway-epoch"
SEQ = (1 << 60) + 3


@pytest.fixture
def replay_node(client, users):
    owner, _ = users
    created = client.post(NODES, headers=owner, json={"name": "Replay node", "platform": "macos"})
    assert created.status_code == 201
    node = created.json()
    return f"{NODES}/{node['node']['id']}/session", {"Authorization": f"Bearer {node['nodeToken']}"}


@pytest.mark.parametrize(("path", "method", "params", "result"), [
    ("snapshot", "session.snapshot", {"sessionId": SESSION, "provider": "hermes"},
     {"sessionId": SESSION, "source": "gateway", "epoch": EPOCH, "lastSeq": SEQ,
      "snapshot": {"lastSeq": SEQ, "messages": [{"role": "assistant", "text": "终"}], "runId": None},
      "opaque": {"nested": [1, False, None]}}),
    ("events/since", "session.events.since", {"sessionId": SESSION, "epoch": EPOCH, "lastSeq": SEQ - 2, "limit": 8},
     {"sessionId": SESSION, "source": "gateway", "epoch": EPOCH, "hasMore": True,
      "events": [{"session_id": SESSION, "replay_epoch": EPOCH, "seq": SEQ - 1, "type": "message.delta",
                  "payload": {"text": "终", "meta": {"unknown": [7, False, None]}}},
                 {"session_id": SESSION, "replay_epoch": EPOCH, "seq": SEQ, "type": "tool.complete",
                  "payload": {"result": {"ok": True}}}]}),
])
def test_core_passes_through_node_result(client, users, replay_node, path, method, params, result):
    owner, _ = users
    url, node_auth = replay_node
    with client.websocket_connect("/ws/fleet/node", headers=node_auth) as node, ThreadPoolExecutor() as pool:
        assert node.receive_json()["type"] == "NodeReady"
        for reply in (result, {"code": "unsupported", "source": "node"}):
            pending = pool.submit(client.post, f"{url}/{path}", headers=owner, json=params)
            request = node.receive_json()
            rpc_id = request.pop("_rpcId")
            assert request == {"type": method, **params}
            node.send_json({"type": "SessionReplayResult", "_rpcId": rpc_id, "result": reply})
            response = pending.result(timeout=5)
            assert response.status_code == 200
            assert response.headers["Cache-Control"] == "no-store"
            assert response.json() == reply


@pytest.mark.parametrize(("path", "params"), [
    ("snapshot", {"sessionId": SESSION}),
    ("events/since", {"sessionId": SESSION, "epoch": EPOCH, "lastSeq": 0}),
])
def test_core_denies_replay_outside_node_workspace(client, users, replay_node, monkeypatch, path, params):
    _, stranger = users
    url, node_auth = replay_node
    call = AsyncMock()
    monkeypatch.setattr(fleet_hub, "call_node_rpc", call)
    with client.websocket_connect("/ws/fleet/node", headers=node_auth) as node:
        assert node.receive_json()["type"] == "NodeReady"
        assert client.post(f"{url}/{path}", headers=stranger, json=params).status_code == 404
        assert client.post(f"{url}/{path}", json=params).status_code == 401
        call.assert_not_awaited()


@pytest.mark.parametrize("declaration", ["auth", "hello", "node.ping"])
def test_core_negotiates_and_suppresses_legacy_replay_per_connection(client, users, replay_node, declaration):
    owner, _ = users
    _, node_auth = replay_node
    capabilities = ["session.events.v1"]
    ready = {"type": "Ready", "serverCapabilities": capabilities}

    with (
        client.websocket_connect("/ws/fleet/node", headers=node_auth) as node,
        client.websocket_connect("/ws/fleet/client", headers=owner) as legacy,
        client.websocket_connect("/ws/fleet/client") as epoch,
    ):
        node_ready = node.receive_json()
        assert node_ready["type"] == "NodeReady"
        assert node_ready["serverCapabilities"] == capabilities
        node_id = node_ready["nodeId"]
        auth = {"type": "auth", "token": owner["Authorization"].split()[1]}
        if declaration == "auth":
            auth["capabilities"] = capabilities
        epoch.send_json(auth)
        assert legacy.receive_json() == epoch.receive_json()
        if declaration != "auth":
            epoch.send_json({"type": declaration, "capabilities": capabilities})
        assert epoch.receive_json() == ready
        if declaration == "node.ping":
            assert epoch.receive_json() == {"type": "Pong", "requestId": None}

        command = {"type": "session.subscribe", "nodeId": node_id, "sessionId": SESSION, "provider": "hermes"}
        legacy.send_json({**command, "requestId": "old"})
        legacy_target = node.receive_json()["_clientConnId"]
        epoch.send_json({**command, "requestId": "new"})
        epoch_target = node.receive_json()["_clientConnId"]
        replay = {
            "type": "SessionStreamReplay", "nodeId": node_id, "provider": "hermes", "sessionId": SESSION,
            "streamId": "live", "lastSeq": 2, "requestId": "old", "incremental": True, "snapshotRequired": False,
            "active": True, "runId": "run", "pendingApprovals": [],
            "events": [{"type": "TextDelta", "text": "终", "sequence": 2, "streamId": "live"}],
        }
        node.send_json({**replay, "_clientConnId": legacy_target})
        node.send_json({**replay, "requestId": "new", "_clientConnId": epoch_target})
        node.send_json({**replay, "requestId": "broadcast"})
        history = {
            "type": "SessionHistory", "sessionId": SESSION, "nodeId": node_id,
            "requestId": "fallback", "messages": [{"role": "assistant", "text": "旧历史"}],
        }
        node.send_json({**history, "_clientConnId": epoch_target})
        marker = {"type": "TextDelta", "sessionId": SESSION, "nodeId": node_id, "sequence": 3, "text": "live"}
        node.send_json(marker)

        assert legacy.receive_json() == replay
        assert legacy.receive_json() == {**replay, "requestId": "broadcast"}
        assert legacy.receive_json() == marker
        assert epoch.receive_json() == history
        assert epoch.receive_json() == marker
