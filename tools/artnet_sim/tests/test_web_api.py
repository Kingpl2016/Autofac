import io
import socket
import time

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from artnet_sim.protocol import artnet
from artnet_sim.protocol.artrec import ArtRecReader, ArtRecWriter, UniDesc
from artnet_sim.web import ws as wsmod
from artnet_sim.web.app import create_app
from artnet_sim.web.settings import WebSettings


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def wait_for(predicate, timeout=4.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.02)
    return None


def make_program_bytes(universes=(1, 2)) -> bytes:
    fp = io.BytesIO()
    w = ArtRecWriter(fp, [UniDesc.from_universe(u, 16) for u in universes])
    w.add_full_frame(0, [bytes([10]) * 16 for _ in universes])
    w.add_full_frame(500_000, [bytes([20]) * 16 for _ in universes])
    w.finish(1_000_000)
    return fp.getvalue()


@pytest.fixture
def env(tmp_path):
    settings = WebSettings(
        data_dir=tmp_path,
        auto_capture=False,
        artnet_port=free_port(),
        sacn_port=free_port(),
        max_pps=5000,
    )
    app = create_app(settings)
    with TestClient(app, base_url="http://localhost") as client:
        yield client, settings, app.state.core


@pytest.fixture
def client(env):
    return env[0]


def ws_url(client):
    return str(client.base_url).replace("http://", "ws://").rstrip("/") + "/ws/live"


def src(**kw):
    base = {"target": "127.0.0.1", "port": free_port(), "rate": 20}
    return base | kw


# ---------------------------------------------------------------------- 基本信息
def test_state_and_meta(client):
    state = client.get("/api/state").json()
    assert state["version"] and state["settings"]["max_pps"] == 5000
    assert state["capture"]["running"] is False and state["sources"] == []
    assert state["scheduler"]["fired"] >= 0
    meta = client.get("/api/meta").json()
    assert any(i["loopback"] for i in meta["interfaces"])
    assert {g["name"] for g in meta["generators"]} >= {"fixed", "rainbow", "artrec"}


def test_validation_errors_are_chinese_json(client):
    r = client.post("/api/sources", json={"bogus": 1})
    assert r.status_code == 422 and "bogus" in r.json()["detail"]
    r = client.post("/api/sources", json={"universes": "x"})
    assert r.status_code == 422


# ---------------------------------------------------------------------- 信号源
def test_source_lifecycle(client):
    r = client.post("/api/sources", json=src(universes="1-3", generator="rainbow"))
    assert r.status_code == 201, r.text
    body = r.json()
    sid = body["id"]
    assert sid.startswith("src-") and body["config"]["universes"] == [1, 2, 3]
    assert wait_for(lambda: client.get(f"/api/sources/{sid}").json()["frames"] >= 3)

    patched = client.patch(
        f"/api/sources/{sid}", json={"rate": 10, "impairments": {"loss": 0.5, "seed": 1}}
    )
    assert patched.status_code == 200
    assert patched.json()["config"]["rate"] == 10
    assert patched.json()["config"]["impairments"]["loss"] == 0.5

    for action, key, value in (
        ("pause", "state", "paused"),
        ("resume", "state", "running"),
        ("freeze", "frozen", True),
        ("unfreeze", "frozen", False),
    ):
        r = client.post(f"/api/sources/{sid}/action", json={"action": action})
        assert r.status_code == 200 and r.json()[key] == value
    assert [s["id"] for s in client.get("/api/sources").json()] == [sid]
    assert client.delete(f"/api/sources/{sid}").status_code == 204
    assert client.get(f"/api/sources/{sid}").status_code == 404


def test_source_errors(client):
    assert client.patch("/api/sources/none", json={"rate": 5}).status_code == 404
    assert client.post("/api/sources/none/action", json={"action": "pause"}).status_code == 404
    assert client.delete("/api/sources/none").status_code == 404
    assert client.post("/api/sources", json=src(rate=0)).status_code == 400
    assert client.post("/api/sources", json=src(generator="nope")).status_code == 400
    assert client.post("/api/sources", json=src(params={"bogus": 1})).status_code == 400
    assert client.post("/api/sources", json=src(id="a")).status_code == 201
    assert client.post("/api/sources", json=src(id="a")).status_code == 409
    assert client.patch("/api/sources/a", json={}).status_code == 400
    assert client.patch("/api/sources/a", json={"rate": 0}).status_code == 400
    assert client.post("/api/sources/a/action", json={"action": "explode"}).status_code == 422


def test_public_targets_are_blocked_by_policy(client):
    r = client.post("/api/sources", json=src(target="8.8.8.8", port=0))
    assert r.status_code == 400 and "公网" in r.json()["detail"]
    # 请求里没有 allow_public 字段可用,策略只能由服务端设置决定
    r = client.post("/api/sources", json={"target": "8.8.8.8", "allow_public": True})
    assert r.status_code == 422


def test_global_pps_cap(client):
    assert (
        client.post("/api/sources", json=src(id="big", universes="1-200", rate=20)).status_code
        == 201
    )  # 4000
    r = client.post("/api/sources", json=src(id="over", universes="1-60", rate=20))  # +1200 > 5000
    assert r.status_code == 429 and "上限" in r.json()["detail"]
    r = client.patch("/api/sources/big", json={"rate": 40})  # 8000
    assert r.status_code == 429
    assert client.patch("/api/sources/big", json={"rate": 25}).status_code == 200  # 5000 刚好
    state = client.get("/api/state").json()
    assert state["settings"]["current_pps"] == pytest.approx(5000)


def test_stop_action_removes_source_and_terminates_sacn(env):
    client, _, core = env
    sid = client.post(
        "/api/sources", json=src(protocol="sacn", universes="1", id="s", channels=8)
    ).json()["id"]
    source = core.get_source(sid)
    assert wait_for(lambda: source.stats.frames >= 2)
    assert (
        client.post(f"/api/sources/{sid}/action", json={"action": "stop"}).json()["state"]
        == "stopped"
    )
    assert client.get(f"/api/sources/{sid}").status_code == 404


# ---------------------------------------------------------------------- 抓包
def test_capture_flow(env):
    client, settings, _ = env
    assert client.get("/api/capture").json()["status"]["running"] is False
    started = client.post("/api/capture/start", json={"sacn": False})
    assert started.status_code == 200 and started.json()["running"] is True
    assert client.post("/api/capture/sacn-universes", json={"universes": [1]}).status_code == 409

    tx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        for seq in (1, 2, 4):  # 缺 3 → 丢 1 个
            tx.sendto(artnet.build_dmx(7, seq, b"\x01\x02"), ("127.0.0.1", settings.artnet_port))
        tx.sendto(artnet.build_poll(), ("127.0.0.1", settings.artnet_port))
    finally:
        tx.close()
    data = wait_for(lambda: (d := client.get("/api/capture").json()) and d["streams"] and d)
    assert data and data["streams"][0]["universe"] == 7
    assert wait_for(lambda: client.get("/api/capture").json()["streams"][0]["packets"] == 3)
    assert client.get("/api/capture").json()["streams"][0]["lost"] == 1

    log = client.get("/api/capture/log", params={"protocol": "artnet"}).json()
    kinds = [p["summary"] for p in log["packets"]]
    assert any(k.startswith("ArtDmx") for k in kinds) and "ArtPoll" in kinds
    first = log["packets"][0]["number"]
    detail = client.get(f"/api/capture/log/{first}").json()
    assert detail["kind"] == "ArtDmx" and any(f["name"] == "Port-Address" for f in detail["fields"])
    assert client.get("/api/capture/log/99999").status_code == 404
    only7 = client.get("/api/capture/log", params={"universe": 7, "limit": 2}).json()
    assert len(only7["packets"]) == 2 and all(p["universe"] == 7 for p in only7["packets"])
    later = client.get("/api/capture/log", params={"after": log["packets"][-1]["number"]}).json()
    assert later["packets"] == []

    assert client.post("/api/capture/log/pause", json={"paused": True}).json() == {"paused": True}
    assert client.post("/api/capture/clear").json() == {"ok": True}
    assert client.get("/api/capture").json()["streams"] == []
    assert client.post("/api/capture/stop").json()["running"] is False


def test_capture_start_validation(client):
    assert (
        client.post("/api/capture/start", json={"artnet": False, "sacn": False}).status_code == 400
    )
    assert client.post("/api/capture/start", json={"universes": [0]}).status_code == 400
    assert client.post("/api/capture/start", json={"interface": "no-such-nic"}).status_code == 400


# ---------------------------------------------------------------------- 虚拟节点
def test_node_lifecycle_and_data_path(env):
    client, settings, _ = env
    r = client.post(
        "/api/nodes",
        json={"id": "n1", "ip": "127.0.0.2", "ports": [{"direction": "output", "address": 3}]},
    )
    assert r.status_code == 201, r.text
    assert r.json()["ports"][0]["out_address"] == 3
    tx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        tx.sendto(artnet.build_dmx(3, 1, b"\x09\x08"), ("127.0.0.2", settings.artnet_port))
    finally:
        tx.close()
    data = wait_for(lambda: (d := client.get("/api/nodes/n1/ports/0/data").json())["data"] and d)
    assert data["data"] == [9, 8]
    nodes = client.get("/api/nodes").json()["nodes"]
    assert nodes[0]["ports"][0]["active"] and nodes[0]["counters"]["dmx"] == 1
    assert client.post("/api/nodes/n1/online", json={"online": False}).json() == {
        "id": "n1",
        "online": False,
    }
    assert client.get("/api/nodes/n1/ports/9/data").status_code == 404
    assert client.delete("/api/nodes/n1").status_code == 204
    assert client.delete("/api/nodes/n1").status_code == 404


def test_node_errors(client):
    assert client.get("/api/nodes").json()["nodes"] == []
    assert client.post("/api/nodes/ghost/online", json={"online": True}).status_code == 404
    bad = client.post("/api/nodes", json={"id": "x", "ip": "300.1.1.1"})
    assert bad.status_code == 400
    assert client.post("/api/nodes", json={"id": "x", "ip": "203.0.113.9"}).status_code == 400
    ok = {"id": "dup", "ip": "127.0.0.3"}
    assert client.post("/api/nodes", json=ok).status_code == 201
    assert client.post("/api/nodes", json=ok).status_code == 409
    assert client.post("/api/nodes", json={"id": "y", "bogus": 1}).status_code == 400


# ---------------------------------------------------------------------- 录制
def test_recording_flow_and_file_management(env):
    client, settings, _ = env
    assert (
        client.post("/api/recordings/start", json={"universes": [1]}).status_code == 409
    )  # 没抓包
    client.post("/api/capture/start", json={"sacn": False})
    assert client.post("/api/recordings/start", json={}).status_code == 400  # 没有活跃信号
    started = client.post(
        "/api/recordings/start", json={"name": "web-test", "universes": [1, 3000]}
    )
    assert started.status_code == 200, started.text
    body = started.json()
    assert body["recording"] and body["file"] == "web-test.artrec" and body["over_limit"] == [3000]
    assert client.post("/api/recordings/start", json={"universes": [1]}).status_code == 409

    tx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        for fill in (5, 6):
            tx.sendto(
                artnet.build_dmx(1, fill, bytes([fill]) * 8), ("127.0.0.1", settings.artnet_port)
            )
            time.sleep(0.05)
    finally:
        tx.close()
    assert wait_for(lambda: client.get("/api/recordings/status").json()["frames"] >= 2)
    stopped = client.post("/api/recordings/stop").json()
    assert stopped["recording"] is False and stopped["last"]["frames"] >= 2
    assert client.post("/api/recordings/stop").status_code == 409

    files = client.get("/api/recordings").json()
    assert [f["name"] for f in files] == ["web-test.artrec"] and files[0]["universes"] == [1]
    info = client.get("/api/recordings/web-test.artrec").json()
    assert info["frames"] >= 2 and info["compress"] == "ZSTD"
    download = client.get("/api/recordings/web-test.artrec/download")
    assert download.status_code == 200
    assert ArtRecReader(download.content).universes == [1]
    assert client.delete("/api/recordings/web-test.artrec").status_code == 204
    assert client.get("/api/recordings/web-test.artrec").status_code == 404


def test_recording_names_cannot_escape_the_folder(client):
    for bad in ("..%2Fsecret.artrec", "a%2Fb.artrec", "..artrec", "x.txt", ".hidden.artrec"):
        assert client.get(f"/api/recordings/{bad}").status_code in (400, 404), bad
        assert client.get(f"/api/recordings/{bad}/download").status_code in (400, 404), bad
        assert client.delete(f"/api/recordings/{bad}").status_code in (400, 404), bad


def test_upload_validates_content_name_and_size(env):
    client, settings, _ = env
    good = make_program_bytes()
    r = client.post("/api/recordings/upload", files={"file": ("up.artrec", good)})
    assert r.status_code == 201 and r.json()["universes"] == [1, 2]
    assert (
        client.post("/api/recordings/upload", files={"file": ("up.artrec", good)}).status_code
        == 409
    )
    bad = client.post("/api/recordings/upload", files={"file": ("junk.artrec", b"x" * 100)})
    assert bad.status_code == 422 and "合法" in bad.json()["detail"]
    assert not (settings.recordings_dir / "junk.artrec").exists()
    assert not list(settings.recordings_dir.glob("*.upload"))
    traversal = client.post("/api/recordings/upload", files={"file": ("../evil.artrec", good)})
    assert (
        traversal.status_code == 201 and traversal.json()["name"] == "evil.artrec"
    )  # 只取文件名部分
    assert (settings.recordings_dir / "evil.artrec").exists()
    assert client.post("/api/recordings/upload", files={"file": ("x.txt", good)}).status_code == 400
    settings.max_upload_mb = 1
    big = client.post(
        "/api/recordings/upload", files={"file": ("big.artrec", b"\x00" * (2 * 1024 * 1024))}
    )
    assert big.status_code == 413
    assert not list(settings.recordings_dir.glob("big*"))


def test_artrec_source_must_use_recording_name(env):
    client, settings, _ = env
    client.post("/api/recordings/upload", files={"file": ("prog.artrec", make_program_bytes())})
    ok = client.post(
        "/api/sources",
        json=src(
            generator="artrec", params={"recording": "prog.artrec", "loop": False}, channels=16
        ),
    )
    assert ok.status_code == 201, ok.text
    assert ok.json()["config"]["universes"] == [1, 2]
    for params in ({"path": "C:/Windows/win.ini"}, {"recording": "../x.artrec"}, {}):
        r = client.post("/api/sources", json=src(generator="artrec", params=params))
        assert r.status_code == 400, params
    assert (
        client.post(
            "/api/sources", json=src(generator="artrec", params={"recording": "none.artrec"})
        ).status_code
        == 404
    )
    sid = ok.json()["id"]
    swap = client.patch(
        f"/api/sources/{sid}", json={"generator": "artrec", "generator_params": {"path": "x"}}
    )
    assert swap.status_code == 400
    # 正在使用?没有绑定关系,可以删除文件;这里只验证已加载的节目不受影响
    assert client.delete("/api/recordings/prog.artrec").status_code == 204


# ---------------------------------------------------------------------- 场景
SCENARIO = """
name: web 场景
duration: 1.5
sources:
  - {{id: ws-a, universes: 1, rate: 20, target: 127.0.0.1, port: {port}}}
timeline:
  - {{at: 0.3, action: set, target: ws-a, values: {{priority: 90}}}}
  - {{at: 0.6, action: log, message: 到点}}
"""


def test_scenario_list_validate_run_stop(env):
    client, _, core = env
    listing = client.get("/api/scenarios").json()
    assert len(listing) >= 8 and all("error" not in item for item in listing)
    assert listing[0]["timeline"] and "yaml" in listing[0]

    text = SCENARIO.format(port=free_port())
    ok = client.post("/api/scenarios/validate", json={"yaml": text}).json()
    assert ok["ok"] and ok["title"] == "web 场景" and len(ok["timeline"]) == 2
    bad = client.post("/api/scenarios/validate", json={"yaml": "name: x"}).json()
    assert bad["ok"] is False and "至少要有" in bad["error"]

    started = client.post("/api/scenarios/run", json={"yaml": text})
    assert started.status_code == 200, started.text
    assert started.json()["running"]
    assert client.post("/api/scenarios/run", json={"yaml": text}).status_code == 409
    assert wait_for(lambda: core.engine.get("ws-a") is not None)
    done = wait_for(
        lambda: (s := client.get("/api/scenarios/status").json())["finished"] and s, timeout=6
    )
    assert done and done["events_applied"] == 2 and not done["errors"]
    assert any("到点" in line for line in done["log"])
    assert core.engine.get("ws-a") is None  # 结束后自动清理

    again = client.post("/api/scenarios/run", json={"yaml": text})
    assert again.status_code == 200
    stopped = client.post("/api/scenarios/stop").json()
    assert not stopped["running"]


def test_scenario_run_argument_errors(client):
    assert client.post("/api/scenarios/run", json={}).status_code == 400
    assert client.post("/api/scenarios/run", json={"name": "a", "yaml": "b"}).status_code == 400
    assert client.post("/api/scenarios/run", json={"name": "nope"}).status_code == 404
    assert client.post("/api/scenarios/run", json={"yaml": "name: x"}).status_code == 400
    assert client.post("/api/scenarios/stop").status_code == 409


def test_scenario_cannot_reference_arbitrary_files_or_clash_with_sources(env):
    client, _, _ = env
    evil = """
name: evil
duration: 1
sources:
  - id: e
    universes: 1
    generator: artrec
    params: {path: 'C:/Windows/win.ini'}
    target: 127.0.0.1
"""
    r = client.post("/api/scenarios/run", json={"yaml": evil})
    assert r.status_code == 400 and "录制文件" in r.json()["detail"]
    v = client.post("/api/scenarios/validate", json={"yaml": evil}).json()
    assert v["ok"] is False
    client.post("/api/sources", json=src(id="ws-a"))
    clash = client.post("/api/scenarios/run", json={"yaml": SCENARIO.format(port=free_port())})
    assert clash.status_code == 409 and "ws-a" in clash.json()["detail"]


def test_scenario_public_target_flag_is_forced_off(env):
    client, _, core = env
    text = """
name: pub
duration: 1
sources:
  - {id: p, universes: 1, target: 8.8.8.8, allow_public: true}
"""
    client.post("/api/scenarios/run", json={"yaml": text})
    status = wait_for(lambda: (s := client.get("/api/scenarios/status").json())["finished"] and s)
    assert status and status["errors"] == [] and status["error"]  # 引擎拒绝了公网目标
    assert core.engine.get("p") is None


# ---------------------------------------------------------------------- WebSocket
def read_until(sock, predicate, limit=60):
    for _ in range(limit):
        message = sock.receive()
        if "text" in message and message["text"]:
            import json

            payload = json.loads(message["text"])
            if predicate(payload):
                return payload
        elif "bytes" in message and message["bytes"] and predicate(message["bytes"]):
            return message["bytes"]
    raise AssertionError("没有等到期望的消息")


def test_websocket_commands_and_stats(env):
    client, _, _ = env
    with client.websocket_connect(ws_url(client)) as sock:
        assert sock.receive_json()["type"] == "hello"
        sock.send_json({"type": "ping"})
        read_until(sock, lambda m: isinstance(m, dict) and m["type"] == "pong")
        sock.send_json({"type": "watch", "items": "nope"})
        err = read_until(sock, lambda m: isinstance(m, dict) and m["type"] == "error")
        assert "列表" in err["message"]
        sock.send_json({"type": "dance"})
        assert (
            "未知消息类型"
            in read_until(sock, lambda m: isinstance(m, dict) and m["type"] == "error")["message"]
        )
        sock.send_text("not json")
        read_until(sock, lambda m: isinstance(m, dict) and m["type"] == "error")
        sock.send_json(
            {"type": "watch", "items": [{"kind": "universe", "protocol": "artnet", "universe": 1}]}
        )
        assert (
            read_until(sock, lambda m: isinstance(m, dict) and m["type"] == "watching")["count"]
            == 1
        )
        stats = read_until(sock, lambda m: isinstance(m, dict) and m["type"] == "stats")
        assert "state" in stats and "streams" in stats["capture"]


def test_websocket_streams_universe_and_node_frames(env):
    client, settings, core = env
    client.post("/api/capture/start", json={"sacn": False})
    client.post(
        "/api/nodes",
        json={"id": "wn", "ip": "127.0.0.2", "ports": [{"direction": "output", "address": 5}]},
    )
    tx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        tx.sendto(artnet.build_dmx(5, 1, b"\x0a\x0b"), ("127.0.0.2", settings.artnet_port))
        tx.sendto(artnet.build_dmx(9, 1, b"\x01\x02\x03\x04"), ("127.0.0.1", settings.artnet_port))
        assert wait_for(lambda: core.hub.latest("artnet", 9) is not None)
        with client.websocket_connect(ws_url(client)) as sock:
            sock.receive_json()
            sock.send_json(
                {
                    "type": "watch",
                    "items": [
                        {"kind": "universe", "protocol": "artnet", "universe": 9},
                        {"kind": "node", "id": "wn", "port": 0},
                    ],
                }
            )
            uni = read_until(sock, lambda m: isinstance(m, bytes) and m[0] == 1)
            assert uni == wsmod.encode_universe_frame("artnet", 9, b"\x01\x02\x03\x04")
            assert uni[:4] == b"\x01\x01\x00\x09"
            node = read_until(sock, lambda m: isinstance(m, bytes) and m[0] == 2)
            assert node == wsmod.encode_node_frame("wn", 0, b"\x0a\x0b")
    finally:
        tx.close()


def test_parse_watch_validation_and_frame_encoding():
    items = [
        {"kind": "universe", "protocol": "sacn", "universe": 3},
        {"kind": "node", "id": "n", "port": 2},
    ]
    watches = wsmod.parse_watch(items)
    assert [w.kind for w in watches] == ["universe", "node"]
    for bad in (
        "x",
        [1],
        [{"kind": "x"}],
        [{"kind": "universe", "protocol": "dmx", "universe": 1}],
        [{"kind": "universe", "protocol": "artnet", "universe": "1"}],
        [{"kind": "universe", "protocol": "artnet", "universe": -1}],
        [{"kind": "node", "id": ""}],
        [{"kind": "node", "id": "n", "port": -1}],
        [{"kind": "universe", "protocol": "artnet", "universe": 1}] * 33,
    ):
        with pytest.raises(ValueError):
            wsmod.parse_watch(bad)
    assert wsmod.encode_universe_frame("sacn", 0x0102, b"\xff") == b"\x01\x02\x01\x02\xff"
    assert wsmod.encode_node_frame("ab", 7, b"\x01") == b"\x02\x02ab\x00\x07\x01"


def test_collect_frames_sends_on_change_and_keepalive(env):
    _, _, core = env
    core.hub.ingest(artnet.build_dmx(4, 1, b"\x01\x02"), ("10.0.0.1", 1), time.perf_counter_ns())
    watch = wsmod.Watch("universe", protocol="artnet", universe=4)
    last: dict = {}
    assert len(wsmod.collect_frames(core, [watch], last, 100.0)) == 1
    assert wsmod.collect_frames(core, [watch], last, 100.5) == []  # 没变化,未到保活
    assert len(wsmod.collect_frames(core, [watch], last, 101.2)) == 1  # 保活补发
    core.hub.ingest(artnet.build_dmx(4, 2, b"\x03\x04"), ("10.0.0.1", 1), time.perf_counter_ns())
    assert len(wsmod.collect_frames(core, [watch], last, 101.3)) == 1  # 数据变了
    missing = wsmod.Watch("universe", protocol="sacn", universe=99)
    assert wsmod.collect_frames(core, [missing], {}, 0.0) == []
    ghost = wsmod.Watch("node", node_id="ghost", port=0)
    assert wsmod.collect_frames(core, [ghost], {}, 0.0) == []


def test_websocket_disconnect_is_clean(env):
    client, _, _ = env
    with client.websocket_connect(ws_url(client)) as sock:
        sock.receive_json()
    with (
        pytest.raises(WebSocketDisconnect),
        client.websocket_connect(ws_url(client), headers={"Origin": "http://elsewhere"}),
    ):
        pass
    assert client.get("/api/health").status_code == 200  # 服务器仍然健康
