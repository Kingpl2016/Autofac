"""Web 服务的安全中间件。

这个服务能让本机向局域网持续发 UDP,所以访问控制不能马虎。它是一个纯 ASGI 中间件,
HTTP 与 WebSocket 走同一套检查:

1. **Host 校验**(防 DNS rebinding):仅本机模式只接受 ``localhost`` / ``127.0.0.1`` / ``[::1]``;
   局域网模式额外接受 IP 字面量和 ``allowed_hosts`` 里的名称。
2. **Origin 校验**(防跨站请求与 WebSocket 劫持):修改类请求(POST/PUT/PATCH/DELETE)和
   WebSocket 握手如果带了 ``Origin`` 头,它必须与 ``Host`` 同源。
3. **只收 JSON**:修改类请求带正文时,``Content-Type`` 必须是 ``application/json``
   (文件上传接口例外,走 multipart,但仍受 Origin 校验)。
4. **令牌认证**:局域网模式(或显式设置了令牌)时,除 ``/login`` 与 ``/api/health`` 外都要求
   ``Authorization: Bearer <令牌>`` 或登录后设置的 Cookie;WebSocket 还接受 ``?token=``。
   令牌比较用常量时间算法,并对同一客户端的连续失败限速。
"""

from __future__ import annotations

import ipaddress
import json
import secrets
import time
from collections import defaultdict, deque
from collections.abc import Awaitable, Callable, MutableMapping
from typing import Any
from urllib.parse import parse_qs, urlsplit

from artnet_sim.web.settings import LOOPBACK_HOSTS, WebSettings

Scope = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[MutableMapping[str, Any]]]
Send = Callable[[MutableMapping[str, Any]], Awaitable[None]]

#: 登录后设置的 Cookie 名。
COOKIE_NAME = "artnet_sim_token"

#: 不需要认证的路径。
OPEN_PATHS = frozenset({"/login", "/api/health"})

#: 会修改状态的 HTTP 方法。
UNSAFE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})

#: 失败限速:窗口内允许的失败次数与窗口长度(秒)。
MAX_FAILURES = 20
FAILURE_WINDOW_S = 60.0

_LOGIN_HTML = (
    "<!doctype html><meta charset=utf-8><title>需要访问令牌</title>"
    "<body style='font-family:sans-serif;max-width:36em;margin:3em auto'>"
    "<h1>需要访问令牌</h1>"
    "<p>请使用启动 <code>artnet-sim serve</code> 时终端里打印的带令牌链接打开本页面。</p>"
    "</body>"
)


def split_host(header: str) -> str:
    """从 ``Host`` 头里取出主机名(去掉端口,保留 IPv6 的方括号)。

    Args:
        header: ``Host`` 头的值,如 ``localhost:8765`` 或 ``[::1]:8765``。

    Returns:
        小写的主机名。
    """
    value = header.strip().lower()
    if value.startswith("["):
        end = value.find("]")
        return value[: end + 1] if end != -1 else value
    return value.rsplit(":", 1)[0] if ":" in value else value


def is_ip_literal(host: str) -> bool:
    """判断主机名是不是 IP 字面量。"""
    try:
        ipaddress.ip_address(host.strip("[]"))
    except ValueError:
        return False
    return True


class FailureLimiter:
    """按客户端地址限制认证失败次数。"""

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._failures: dict[str, deque[float]] = defaultdict(deque)

    def blocked(self, client: str) -> bool:
        """该客户端当前是否因失败过多被限速。"""
        window = self._failures[client]
        limit = self._clock() - FAILURE_WINDOW_S
        while window and window[0] < limit:
            window.popleft()
        return len(window) >= MAX_FAILURES

    def record(self, client: str) -> None:
        """记录一次失败。"""
        self._failures[client].append(self._clock())


def token_matches(supplied: str | None, expected: str | None) -> bool:
    """常量时间比较令牌。

    Args:
        supplied: 客户端提供的令牌。
        expected: 服务端的令牌。

    Returns:
        两者都非空且相同返回 ``True``。
    """
    if not supplied or not expected:
        return False
    return secrets.compare_digest(supplied.encode("utf-8"), expected.encode("utf-8"))


class SecurityMiddleware:
    """见模块文档。

    Args:
        app: 下一层 ASGI 应用。
        settings: Web 设置。
        limiter: 失败限速器,测试可注入。
    """

    def __init__(self, app: Any, settings: WebSettings, limiter: FailureLimiter | None = None):
        self.app = app
        self.settings = settings
        self.limiter = limiter or FailureLimiter()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        headers = {k.decode("latin-1"): v.decode("latin-1") for k, v in scope["headers"]}
        problem = self._check(scope, headers)
        if problem is None:
            await self.app(scope, receive, send)
            return
        status, message = problem
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008})
            return
        await self._respond(scope, headers, send, status, message)

    # ------------------------------------------------------------------ 检查
    def _check(self, scope: Scope, headers: dict[str, str]) -> tuple[int, str] | None:
        """依次执行各项检查;全部通过返回 ``None``,否则返回(状态码, 说明)。"""
        host_header = headers.get("host", "")
        if not self._host_allowed(split_host(host_header)):
            return 403, f"不允许的 Host: {host_header or '(空)'}"
        method = scope.get("method", "GET")
        if scope["type"] == "websocket" or method in UNSAFE_METHODS:
            origin = headers.get("origin")
            if origin is not None and not self._same_origin(origin, host_header):
                return 403, "跨站请求被拒绝(Origin 与 Host 不一致)"
        if method in UNSAFE_METHODS and not scope["path"].endswith("/upload"):
            has_body = headers.get("content-length", "0") not in ("0", "") or (
                "transfer-encoding" in headers
            )
            content_type = headers.get("content-type", "").split(";")[0].strip().lower()
            if has_body and content_type != "application/json":
                return 415, "只接受 Content-Type: application/json"
        if self.settings.auth_required and scope["path"] not in OPEN_PATHS:
            client = (scope.get("client") or ("?", 0))[0]
            if self.limiter.blocked(client):
                return 429, "认证失败次数过多,请稍后再试"
            if not token_matches(self._extract_token(scope, headers), self.settings.token):
                self.limiter.record(client)
                return 401, "需要访问令牌"
        return None

    def _host_allowed(self, host: str) -> bool:
        """Host 是否在允许范围内。"""
        if host in LOOPBACK_HOSTS:
            return True
        if not self.settings.lan:
            return False
        return is_ip_literal(host) or host in {h.lower() for h in self.settings.allowed_hosts}

    @staticmethod
    def _same_origin(origin: str, host_header: str) -> bool:
        """``Origin`` 的主机和端口是否与 ``Host`` 头一致。"""
        if origin == "null":
            return False
        parts = urlsplit(origin)
        if not parts.netloc:
            return False
        return parts.netloc.lower() == host_header.strip().lower()

    @staticmethod
    def _extract_token(scope: Scope, headers: dict[str, str]) -> str | None:
        """从请求里取出令牌:Authorization、Cookie,WebSocket 另可用查询参数。"""
        auth = headers.get("authorization", "")
        if auth.lower().startswith("bearer "):
            return auth[7:].strip()
        for chunk in headers.get("cookie", "").split(";"):
            name, _, value = chunk.strip().partition("=")
            if name == COOKIE_NAME and value:
                return value
        if scope["type"] == "websocket":
            query = parse_qs(scope.get("query_string", b"").decode("latin-1"))
            values = query.get("token")
            if values:
                return values[0]
        return None

    # ------------------------------------------------------------------ 响应
    @staticmethod
    async def _respond(
        scope: Scope, headers: dict[str, str], send: Send, status: int, message: str
    ) -> None:
        """发送拒绝响应:浏览器直接打开页面时给 HTML,其他情况给 JSON。"""
        wants_html = (
            status == 401
            and scope.get("method") == "GET"
            and "text/html" in headers.get("accept", "")
        )
        if wants_html:
            body = _LOGIN_HTML.encode("utf-8")
            content_type = b"text/html; charset=utf-8"
        else:
            body = json.dumps({"detail": message}, ensure_ascii=False).encode("utf-8")
            content_type = b"application/json; charset=utf-8"
        response_headers = [
            (b"content-type", content_type),
            (b"content-length", str(len(body)).encode()),
            (b"cache-control", b"no-store"),
        ]
        if status == 401:
            response_headers.append((b"www-authenticate", b"Bearer"))
        await send({"type": "http.response.start", "status": status, "headers": response_headers})
        await send({"type": "http.response.body", "body": body})
