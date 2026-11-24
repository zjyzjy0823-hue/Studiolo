from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.fleet import routes
from app.models import User
from app.security import current_user
from app.workspaces import ensure_personal_workspace


NODES = "/api/v1/fleet/nodes"


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(routes.router)
    app.include_router(routes.ws_router)
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    with Session(engine, expire_on_commit=False) as db:
        user = User(username="owner", email="owner@example.test", password_hash="unused")
        db.add(user)
        db.flush()
        ensure_personal_workspace(db, user)
        db.commit()

    def test_db():
        with Session(engine, autoflush=False, expire_on_commit=False) as db:
            yield db

    app.dependency_overrides[get_db] = test_db
    app.dependency_overrides[current_user] = lambda: user
    try:
        with TestClient(app) as api:
            yield api
    finally:
        engine.dispose()


@pytest.mark.parametrize(("path", "params", "result"), [
    ("processes", {"session_id": "ui-session"},
     {"provider": "hermes", "processes": [{"session_id": "proc_1", "command": "printf hello", "pid": 42}]}),
    ("subagents", {"sessionId": "ui-session", "provider": "hermes"},
     {"provider": "hermes", "subagents": [], "delegations": [{"status": "done", "details": [None, 1]}]}),
])
def test_core_passes_through_session_lists(client, path, params, result):
    created = client.post(NODES, json={"name": "Hermes node", "platform": "macos"})
    assert created.status_code == 201
    node_url = f"{NODES}/{created.json()['node']['id']}/session/{path}"
    node_auth = {"Authorization": f"Bearer {created.json()['nodeToken']}"}
    request = {"type": f"session.{path}", "session_id": "ui-session"}
    if "provider" in params:
        request["provider"] = params["provider"]
    replies = (result, {"unsupported": True}, {"ok": False, "code": "provider_error", "error": "session not found"})

    with client.websocket_connect("/ws/fleet/node", headers=node_auth) as node, ThreadPoolExecutor() as pool:
        assert node.receive_json()["type"] == "NodeReady"
        for reply in replies:
            pending = pool.submit(client.post, node_url, json=params)
            frame = node.receive_json()
            rpc_id = frame.pop("_rpcId")
            assert frame == request
            node.send_json({"type": "SessionReplayResult", "_rpcId": rpc_id, "result": reply})
            response = pending.result(timeout=5)
            assert response.status_code == 200
            assert response.headers["Cache-Control"] == "no-store"
            assert response.json() == reply
