"""alist_publish 的离线用例。

签名算法在 2026-11-24 用真实 AList 服务端返回值校验过：
服务端对 path=/dl/hermes-selftest.txt、expire=0 返回的 sign 与 sign_path() 输出逐字节一致。
需要联网复核时设置 ALIST_URL / ALIST_TOKEN 并跑 test_live_sign_matches_server。
"""

import base64
import hashlib
import hmac
import json
import os
import time

import pytest

from agent_node.alist_publish import (
    LinkPublisher,
    PublishConfig,
    PublishError,
    config_from_env,
    sign_path,
)


class FakeResponse:
    def __init__(self, payload=None, content=b"", status_code=200):
        self._payload = payload or {}
        self.content = content
        self.status_code = status_code

    def json(self):
        return self._payload


class FakeClient:
    """记录调用并按脚本返回，模拟 AList + 下载探测。"""

    def __init__(self, remote: dict[str, int] | None = None, probe: dict[str, tuple[int, int]] | None = None):
        self.remote = dict(remote or {})
        self.probe = dict(probe or {})  # host -> (bytes, 每次耗时秒)
        self.calls: list[tuple[str, str, dict]] = []

    def post(self, url, headers=None, content=None):
        self.calls.append(("POST", url, dict(headers or {})))
        body = json.loads(content.decode()) if isinstance(content, (bytes, bytearray)) else json.loads(content or "{}")
        path = body.get("path")
        if path in self.remote:
            return FakeResponse({"code": 200, "data": {"size": self.remote[path]}})
        return FakeResponse({"code": 500, "message": "object not found"})

    def put(self, url, headers=None, content=None):
        self.calls.append(("PUT", url, dict(headers or {})))
        data = content.read() if hasattr(content, "read") else content or b""
        self.remote[headers["File-Path"]] = len(data)
        return FakeResponse({"code": 200, "message": "success"})

    def get(self, url, headers=None):
        self.calls.append(("GET", url, dict(headers or ())))
        host = "/".join(url.split("/")[:3])
        if host not in self.probe:
            raise RuntimeError("connection refused")
        nbytes, delay = self.probe[host]
        time.sleep(0)  # 假延迟由 clock 控制
        return FakeResponse(content=b"x" * nbytes, status_code=206)


def make_publisher(tmp_path, hosts=("https://fast.example", "https://slow.example"), probe=None, remote=None):
    fake = FakeClient(remote=remote, probe=probe or {})
    cfg = PublishConfig(
        base_url="https://alist.example",
        token="test-token",
        hosts=hosts,
        probe_bytes=1024,
        probe_ttl_seconds=600,
    )
    clock_values = iter([1000.0, 1000.0, 1001.0, 1002.0, 1003.0, 1004.0, 1005.0] * 200)
    return LinkPublisher(cfg, client=fake, clock=lambda: next(clock_values)), fake


def test_sign_is_stable_vector():
    value = sign_path("test-token", "/dl/example.bin", 1800000000)
    expected = base64.urlsafe_b64encode(
        hmac.new(b"test-token", b"/dl/example.bin:1800000000", hashlib.sha256).digest()
    ).decode()
    assert value == expected
    assert sign_path("test-token", "/dl/example.bin", 1800000000) == value


def test_upload_skips_when_remote_size_matches(tmp_path):
    local = tmp_path / "a.bin"
    local.write_bytes(b"hello")
    publisher, fake = make_publisher(tmp_path)
    remote_path = f"/dl/{publisher.remote_name(local)}"
    fake.remote[remote_path] = 5
    path, uploaded = publisher.upload(local)
    assert path == remote_path
    assert uploaded is False
    assert all(method != "PUT" for method, _, _ in fake.calls)


def test_upload_sends_bytes_and_verifies_size(tmp_path):
    local = tmp_path / "b.bin"
    local.write_bytes(b"x" * 32)
    publisher, fake = make_publisher(tmp_path)
    path, uploaded = publisher.upload(local)
    assert uploaded is True
    assert fake.remote[path] == 32
    put_calls = [c for c in fake.calls if c[0] == "PUT"]
    assert len(put_calls) == 1
    assert put_calls[0][1].endswith("/api/fs/put")


def test_probe_picks_fastest_host(tmp_path):
    local = tmp_path / "c.bin"
    local.write_bytes(b"y" * 8)
    publisher, _ = make_publisher(
        tmp_path,
        probe={"https://fast.example": (1024, 0.0), "https://slow.example": (64, 0.0)},
    )
    result = publisher.publish(local)
    assert result.host == "https://fast.example"
    assert result.url.startswith("https://fast.example/p/dl/")
    assert f":{result.expires_at}" in result.url


def test_probe_failure_falls_back_to_reachable_host(tmp_path):
    local = tmp_path / "d.bin"
    local.write_bytes(b"z" * 4)
    publisher, _ = make_publisher(tmp_path, probe={"https://slow.example": (128, 0.0)})
    result = publisher.publish(local)
    assert result.host == "https://slow.example"


def test_all_probes_failing_falls_back_to_base_url(tmp_path):
    local = tmp_path / "e.bin"
    local.write_bytes(b"w")
    publisher, _ = make_publisher(tmp_path, probe={})
    result = publisher.publish(local)
    assert result.host == "https://alist.example"


def test_probe_scores_are_cached(tmp_path):
    local = tmp_path / "f.bin"
    local.write_bytes(b"q" * 16)
    publisher, fake = make_publisher(
        tmp_path, probe={"https://fast.example": (1024, 0.0), "https://slow.example": (512, 0.0)}
    )
    publisher.publish(local)
    after_first = len([c for c in fake.calls if c[0] == "GET"])
    publisher.publish(local)
    after_second = len([c for c in fake.calls if c[0] == "GET"])
    assert after_second == after_first, "第二次发布不该再探测"


def test_publish_rejects_missing_file(tmp_path):
    publisher, _ = make_publisher(tmp_path)
    with pytest.raises(PublishError):
        publisher.publish(tmp_path / "nope.bin")


def test_config_from_env_requires_credentials():
    with pytest.raises(PublishError):
        config_from_env({"ALIST_URL": "https://alist.example"})
    cfg = config_from_env({"ALIST_URL": "https://alist.example", "ALIST_TOKEN": "t"})
    assert cfg.ttl_seconds == 86400
    assert cfg.mount_path == "/dl"
    assert cfg.candidate_hosts() == ("https://alist.example",)


def test_config_hosts_include_base_url_last():
    cfg = PublishConfig(base_url="https://alist.example", token="t", hosts=("https://dl.example",))
    assert cfg.candidate_hosts() == ("https://dl.example", "https://alist.example")
