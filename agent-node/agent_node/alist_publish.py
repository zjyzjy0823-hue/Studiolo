"""大文件外链发布：上传到 AList，按实测速度自动选路，产出带有效期的签名链接。

设计要点
--------
* 只负责"把一个本地文件变成公网可下载链接"，不参与会话/协议。
* 链接签名与 AList 服务端一致：base64url(HMAC_SHA256(token, "<path>:<expire>"))+":"+expire
  （该算法已用服务端真实返回值做过黄金向量校验，见 tests）。
* 选路：对每个候选 host 下载一小段字节测速，取最快；结果缓存 probe_ttl 秒，
  避免每次下载都探测。测速失败时回退到上一个可用 host，再回退到 base_url。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_TTL_SECONDS = 24 * 3600
DEFAULT_THRESHOLD_BYTES = 32 * 1024 * 1024
DEFAULT_PROBE_BYTES = 512 * 1024
DEFAULT_PROBE_TTL = 600


def sign_path(token: str, remote_path: str, expire_at: int) -> str:
    """与 AList 服务端相同的签名算法。"""
    message = f"{remote_path}:{expire_at}".encode()
    digest = hmac.new(token.encode(), message, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).decode()


@dataclass
class ProbeScore:
    host: str
    bytes_per_second: float
    measured_at: float


@dataclass
class PublishResult:
    url: str
    host: str
    remote_path: str
    size: int
    expires_at: int
    uploaded: bool
    scores: list[ProbeScore] = field(default_factory=list)


@dataclass
class PublishConfig:
    base_url: str
    token: str
    mount_path: str = "/dl"
    hosts: tuple[str, ...] = ()
    ttl_seconds: int = DEFAULT_TTL_SECONDS
    threshold_bytes: int = DEFAULT_THRESHOLD_BYTES
    probe_bytes: int = DEFAULT_PROBE_BYTES
    probe_ttl_seconds: int = DEFAULT_PROBE_TTL

    def candidate_hosts(self) -> tuple[str, ...]:
        hosts = [h.rstrip("/") for h in self.hosts if h.strip()] if self.hosts else []
        if not hosts:
            hosts = [self.base_url.rstrip("/")]
        elif self.base_url.rstrip("/") not in hosts:
            hosts.append(self.base_url.rstrip("/"))
        return tuple(hosts)


class PublishError(RuntimeError):
    pass


class LinkPublisher:
    """把本地文件发布成公网链接；HTTP 客户端可注入，便于离线测试。"""

    def __init__(self, config: PublishConfig, client=None, clock=time.time):
        self.config = config
        self._client = client
        self._clock = clock
        self._scores: dict[str, ProbeScore] = {}
        self._last_good_host: str | None = None

    # ---- HTTP 抽象：默认用 httpx，测试注入假客户端 ----
    def _http(self):
        if self._client is not None:
            return self._client
        import httpx  # 局部导入，测试环境不必安装

        self._client = httpx.Client(timeout=120, verify=False, trust_env=False)
        return self._client

    def _auth_headers(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        headers = {"Authorization": self.config.token}
        if extra:
            headers.update(extra)
        return headers

    # ---- 上传 ----
    def remote_name(self, path: Path) -> str:
        stat = path.stat()
        digest = hashlib.sha256(f"{path.name}:{stat.st_size}".encode()).hexdigest()[:8]
        # File-Path 走 HTTP 头，必须是 ASCII；中文/emoji 文件名要压成安全字符，
        # 展示名由客户端自己保留，远端用什么名字不影响用户看到的名字。
        safe = re.sub(r"[^A-Za-z0-9._-]+", "_", path.name).strip("_") or "file"
        return f"{digest}-{safe}"

    def _remote_size(self, remote_path: str) -> int | None:
        client = self._http()
        response = client.post(
            f"{self.config.base_url}/api/fs/get",
            headers=self._auth_headers({"Content-Type": "application/json"}),
            content=b'{"path": "' + remote_path.encode() + b'"}',
        )
        payload = response.json()
        if payload.get("code") != 200:
            return None
        data = payload.get("data") or {}
        size = data.get("size")
        return int(size) if isinstance(size, int) else None

    def upload(self, path: Path) -> tuple[str, bool]:
        remote_path = f"{self.config.mount_path.rstrip('/')}/{self.remote_name(path)}"
        size = path.stat().st_size
        if self._remote_size(remote_path) == size:
            return remote_path, False
        client = self._http()
        with path.open("rb") as handle:
            response = client.put(
                f"{self.config.base_url}/api/fs/put",
                headers=self._auth_headers({
                    "File-Path": remote_path,
                    "Content-Type": "application/octet-stream",
                    "As-Task": "false",
                }),
                content=handle,
            )
        if response.status_code >= 400:
            body = response.text[:120].replace("\n", " ") if hasattr(response, "text") else ""
            raise PublishError(f"上传失败: HTTP {response.status_code} {body}".strip())
        try:
            payload = response.json()
        except ValueError:
            body = response.text[:120].replace("\n", " ") if hasattr(response, "text") else ""
            raise PublishError(f"上传响应不是 JSON: {body}") from None
        if payload.get("code") != 200:
            raise PublishError(f"上传失败: {payload.get('message')}")
        if self._remote_size(remote_path) != size:
            raise PublishError("上传后大小不一致")
        return remote_path, True

    # ---- 选路 ----
    def probe(self, hosts: tuple[str, ...], remote_path: str, expire_at: int) -> list[ProbeScore]:
        """对每个 host 拉一小段字节测速；失败的记录 0 分，避免每次发布重复探测。"""
        results: list[ProbeScore] = []
        signature = sign_path(self.config.token, remote_path, expire_at)
        for host in hosts:
            url = f"{host}/p{remote_path}?sign={signature}:{expire_at}"
            started = self._clock()
            try:
                client = self._http()
                response = client.get(
                    url,
                    headers={"Range": f"bytes=0-{self.config.probe_bytes - 1}"},
                )
                body = response.content if hasattr(response, "content") else b""
                elapsed = max(self._clock() - started, 1e-6)
                if getattr(response, "status_code", 200) >= 400 or not body:
                    results.append(ProbeScore(host, 0.0, self._clock()))
                    continue
                results.append(ProbeScore(host, len(body) / elapsed, self._clock()))
            except Exception:  # 单点失败不影响其他候选
                results.append(ProbeScore(host, 0.0, self._clock()))
        results.sort(key=lambda item: item.bytes_per_second, reverse=True)
        return results

    def pick_host(self, remote_path: str, expire_at: int) -> tuple[str, list[ProbeScore]]:
        hosts = self.config.candidate_hosts()
        if len(hosts) == 1:
            return hosts[0], []
        now = self._clock()
        fresh = [
            self._scores[h] for h in hosts
            if h in self._scores and now - self._scores[h].measured_at < self.config.probe_ttl_seconds
        ]
        if len(fresh) == len(hosts):
            ranked = sorted(fresh, key=lambda item: item.bytes_per_second, reverse=True)
            if ranked[0].bytes_per_second > 0:
                return ranked[0].host, ranked
            return self._fallback_host(), ranked
        scores = self.probe(hosts, remote_path, expire_at)
        for score in scores:
            self._scores[score.host] = score
        if scores and scores[0].bytes_per_second > 0:
            self._last_good_host = scores[0].host
            return scores[0].host, scores
        return self._fallback_host(), scores

    def _fallback_host(self) -> str:
        fallback = self._last_good_host or self.config.base_url.rstrip("/")
        return fallback

    # ---- 对外 ----
    def publish(self, path: str | os.PathLike[str], ttl_seconds: int | None = None) -> PublishResult:
        local = Path(path)
        if not local.is_file():
            raise PublishError(f"文件不存在: {local}")
        size = local.stat().st_size
        ttl = self.config.ttl_seconds if ttl_seconds is None else ttl_seconds
        expire_at = int(self._clock()) + ttl
        remote_path, uploaded = self.upload(local)
        host, scores = self.pick_host(remote_path, expire_at)
        signature = sign_path(self.config.token, remote_path, expire_at)
        return PublishResult(
            url=f"{host}/p{remote_path}?sign={signature}:{expire_at}",
            host=host,
            remote_path=remote_path,
            size=size,
            expires_at=expire_at,
            uploaded=uploaded,
            scores=scores,
        )


def config_from_env(env: dict[str, str] | None = None) -> PublishConfig:
    env = env or dict(os.environ)
    base = env.get("ALIST_URL", "").rstrip("/")
    token = env.get("ALIST_TOKEN", "")
    if not base or not token:
        raise PublishError("缺少 ALIST_URL / ALIST_TOKEN")
    hosts = tuple(h.strip() for h in env.get("ALIST_HOSTS", "").split(",") if h.strip())
    return PublishConfig(
        base_url=base,
        token=token,
        mount_path=env.get("ALIST_MOUNT", "/dl"),
        hosts=hosts,
        ttl_seconds=int(env.get("ALIST_TTL", DEFAULT_TTL_SECONDS)),
    )
