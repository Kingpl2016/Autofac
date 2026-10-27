import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from artnet_sim.web.app import create_app
from artnet_sim.web.security import (
    FailureLimiter,
    is_ip_literal,
    split_host,
    token_matches,
)
from artnet_sim.web.settings import WebSettings

TOKEN = "s3cret-token-for-tests"


def ws_url(client, path):
    """WebSocket 的完整地址:Host 头取自 TestClient 的 base_url。"""
    return str(client.base_url).replace("http://", "ws://").rstrip("/") + path


def make_client(tmp_path, base_url="http://localhost", **overrides):
    settings = WebSettings(
        data_dir=tmp_path,
        auto_capture=False,
        artnet_port=46454,
        sacn_port=45568,
        **overrides,
    )
    app = create_app(settings)
    return TestClient(app, base_url=base_url), settings


@pytest.fixture
def local(tmp_path):
    with make_client(tmp_path)[0] as client:
        yield client


@pytest.fixture
def lan(tmp_path):
    client, settings = make_client(
        tmp_path, "http://192.168.1.50", host="0.0.0.0", lan=True, token=TOKEN
    )
    with client:
        yield client, settings


def test_helpers():
    assert split_host("LocalHost:8765") == "localhost"
    assert split_host("[::1]:8765") == "[::1]"
    assert split_host("example.com") == "example.com"
    assert is_ip_literal("192.168.1.1") and is_ip_literal("[::1]") and not is_ip_literal("a.b")
    assert token_matches("abc", "abc")
    assert (
        not token_matches("abc", "abd")
        and not token_matches("", "x")
        and not token_matches("x", None)
    )


def test_failure_limiter():
    now = [0.0]
    limiter = FailureLimiter(clock=lambda: now[0])
    for _ in range(20):
        assert not limiter.blocked("c")
        limiter.record("c")
    assert limiter.blocked("c") and not limiter.blocked("other")
    now[0] = 61.0
    assert not limiter.blocked("c")


def test_settings_validation(tmp_path):
    with pytest.raises(ValueError, match="令牌"):
        WebSettings(lan=True, host="0.0.0.0").validate()
    with pytest.raises(ValueError, match="--lan"):
        WebSettings(host="0.0.0.0").validate()
    with pytest.raises(ValueError, match="端口"):
        WebSettings(port=0).validate()
    WebSettings(lan=True, host="0.0.0.0", token="t").validate()
    assert not WebSettings().auth_required
    assert WebSettings(token="t").auth_required


def test_loopback_mode_needs_no_token(local):
    assert local.get("/api/state").status_code == 200
    assert local.get("/").status_code == 200
    assert local.get("/api/health").json() == {"ok": True}


def test_host_header_is_validated_against_dns_rebinding(local):
    assert local.get("/api/state", headers={"Host": "evil.example.com"}).status_code == 403
    assert local.get("/api/state", headers={"Host": "127.0.0.1:8765"}).status_code == 200
    assert local.get("/api/state", headers={"Host": "[::1]:8765"}).status_code == 200
    assert local.get("/api/state", headers={"Host": "192.168.1.5"}).status_code == 403  # 仅本机模式


def test_cross_site_requests_are_rejected(local):
    body = {"universes": [1]}
    foreign = {"Origin": "http://evil.example.com"}
    assert local.post("/api/capture/sacn-universes", json=body, headers=foreign).status_code == 403
    assert (
        local.post("/api/capture/sacn-universes", json=body, headers={"Origin": "null"}).status_code
        == 403
    )
    same = {"Origin": "http://localhost"}
    # 同源通过安全检查;业务上抓包没运行 → 409
    assert local.post("/api/capture/sacn-universes", json=body, headers=same).status_code == 409
    # 没有 Origin(非浏览器客户端)也放行
    assert local.post("/api/capture/sacn-universes", json=body).status_code == 409
    # GET 不受 Origin 限制
    assert local.get("/api/state", headers=foreign).status_code == 200


def test_unsafe_requests_must_be_json(local):
    response = local.post(
        "/api/capture/clear", content="x=1", headers={"Content-Type": "text/plain"}
    )
    assert response.status_code == 415
    response = local.post(
        "/api/capture/clear",
        content="x=1",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    assert response.status_code == 415
    assert local.post("/api/capture/clear").status_code == 200  # 没有正文则放行


def test_websocket_rejects_foreign_origin_and_bad_host(local):
    url = ws_url(local, "/ws/live")
    with (
        pytest.raises(WebSocketDisconnect),
        local.websocket_connect(url, headers={"Origin": "http://evil.example.com"}),
    ):
        pass
    with (
        pytest.raises(WebSocketDisconnect),
        local.websocket_connect(url, headers={"Host": "evil.example.com"}),
    ):
        pass
    with local.websocket_connect(url, headers={"Origin": "http://localhost"}) as sock:
        assert sock.receive_json()["type"] == "hello"


def test_lan_mode_requires_token_everywhere(lan):
    client, _ = lan
    assert client.get("/api/health").status_code == 200  # 公开
    assert client.get("/api/state").status_code == 401
    assert client.get("/api/state").json()["detail"] == "需要访问令牌"
    assert client.get("/docs").status_code == 401
    assert client.get("/static/index.html").status_code == 401
    html = client.get("/", headers={"Accept": "text/html"})
    assert html.status_code == 401 and "text/html" in html.headers["content-type"]
    assert "需要访问令牌" in html.text
    assert client.get("/api/state", headers={"Authorization": "Bearer wrong"}).status_code == 401
    ok = client.get("/api/state", headers={"Authorization": f"Bearer {TOKEN}"})
    assert ok.status_code == 200


def test_lan_login_sets_cookie_and_cookie_authenticates(lan):
    client, _ = lan
    bad = client.get("/login", params={"token": "nope"}, follow_redirects=False)
    assert bad.status_code == 401
    good = client.get("/login", params={"token": TOKEN}, follow_redirects=False)
    assert good.status_code == 303 and good.headers["location"] == "/"
    cookie = good.headers["set-cookie"]
    assert "HttpOnly" in cookie and "SameSite=strict" in cookie
    assert client.get("/api/state").status_code == 200  # TestClient 保存了 Cookie


def test_lan_host_rules(lan):
    client, _ = lan
    auth = {"Authorization": f"Bearer {TOKEN}"}
    assert client.get("/api/state", headers=auth).status_code == 200  # IP 字面量
    assert client.get("/api/state", headers={**auth, "Host": "evil.example.com"}).status_code == 403
    assert client.get("/api/state", headers={**auth, "Host": "localhost:8765"}).status_code == 200


def test_lan_allowed_hosts_names(tmp_path):
    client, _ = make_client(
        tmp_path,
        "http://stage-pc",
        host="0.0.0.0",
        lan=True,
        token=TOKEN,
        allowed_hosts=frozenset({"stage-pc"}),
    )
    with client:
        assert (
            client.get("/api/state", headers={"Authorization": f"Bearer {TOKEN}"}).status_code
            == 200
        )


def test_lan_websocket_needs_token(lan):
    client, _ = lan
    url = ws_url(client, "/ws/live")
    with pytest.raises(WebSocketDisconnect), client.websocket_connect(url):
        pass
    with client.websocket_connect(f"{url}?token={TOKEN}") as sock:
        assert sock.receive_json()["type"] == "hello"
    with client.websocket_connect(url, headers={"Authorization": f"Bearer {TOKEN}"}) as sock:
        assert sock.receive_json()["type"] == "hello"


def test_repeated_failures_are_rate_limited(lan):
    client, _ = lan
    codes = [client.get("/api/state").status_code for _ in range(25)]
    assert codes[:20] == [401] * 20
    assert set(codes[20:]) == {429}
    # 限速期间连正确的令牌也暂时被拒绝,避免被用来探测
    assert client.get("/api/state", headers={"Authorization": f"Bearer {TOKEN}"}).status_code == 429


def test_security_headers(local):
    response = local.get("/")
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["x-frame-options"] == "DENY"
    assert "default-src 'self'" in response.headers["content-security-policy"]
    api = local.get("/api/state")
    assert api.headers["cache-control"] == "no-store"
