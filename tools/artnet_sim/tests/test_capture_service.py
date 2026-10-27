import socket
import threading
import time

import pytest

from artnet_sim.capture.hub import Hub
from artnet_sim.capture.service import CaptureService
from artnet_sim.cli import main
from artnet_sim.net.interfaces import default_interface
from artnet_sim.net.scheduler import Scheduler
from artnet_sim.sender.engine import SendEngine
from artnet_sim.sender.impairments import Impairments
from artnet_sim.sender.source import SourceConfig


def free_udp_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def wait_for(predicate, timeout=4.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return False


@pytest.fixture
def engine():
    e = SendEngine(Scheduler(boost_priority=False), resolver=lambda spec: None)
    e.start()
    yield e
    e.stop()


@pytest.fixture
def capture():
    hub = Hub()
    artnet_port, sacn_port = free_udp_port(), free_udp_port()
    service = CaptureService(hub, artnet_port=artnet_port, sacn_port=sacn_port)
    report = service.start()
    assert not report.artnet_port_shared and not report.sacn_port_shared
    yield hub, service, artnet_port, sacn_port
    service.stop()


def test_loss_injected_by_sender_is_measured_by_receiver(engine, capture):
    hub, _service, artnet_port, _ = capture
    source = engine.add_source(
        SourceConfig(
            id="a",
            universes=[1],
            rate=100,
            target="127.0.0.1",
            port=artnet_port,
            impairments=Impairments(drop_every=5, seed=1),
        )
    )
    assert wait_for(lambda: source.stats.frames >= 52)
    engine.remove_source("a")
    time.sleep(0.2)
    (stream,) = hub.snapshot()["streams"]
    assert stream["protocol"] == "artnet" and stream["universe"] == 1
    assert stream["packets"] == source.stats.packets
    # 最后一帧如果恰好被丢弃则无法被检测,所以允许差 1。
    assert source.stats.dropped - 1 <= stream["lost"] <= source.stats.dropped
    assert stream["lost"] >= 9
    assert stream["out_of_order"] == 0 and stream["duplicates"] == 0
    assert 8 < stream["pps"] < 110


def test_reorder_and_duplicate_are_measured(engine, capture):
    hub, _service, artnet_port, _ = capture
    source = engine.add_source(
        SourceConfig(
            id="a",
            universes=[1],
            rate=100,
            target="127.0.0.1",
            port=artnet_port,
            impairments=Impairments(reorder=0.3, duplicate=0.3, seed=2),
        )
    )
    assert wait_for(lambda: source.stats.frames >= 100)
    engine.remove_source("a")
    time.sleep(0.2)
    (stream,) = hub.snapshot()["streams"]
    assert stream["out_of_order"] > 5
    assert stream["duplicates"] > 5
    assert stream["lost"] <= 2  # 乱序的包最终都到了


def test_jitter_widens_interval_stddev(engine, capture):
    hub, _service, artnet_port, _ = capture
    for source_id, jitter in (("calm", 0.0), ("shaky", 20.0)):
        universe = 1 if source_id == "calm" else 2
        engine.add_source(
            SourceConfig(
                id=source_id,
                universes=[universe],
                rate=50,
                target="127.0.0.1",
                port=artnet_port,
                impairments=Impairments(jitter_ms=jitter, seed=3),
            )
        )
    assert wait_for(lambda: engine.get("shaky").stats.frames >= 60, timeout=6)
    calm = next(s for s in hub.snapshot()["streams"] if s["universe"] == 1)
    shaky = next(s for s in hub.snapshot()["streams"] if s["universe"] == 2)
    assert shaky["interval_stddev_ms"] > 2.0
    assert shaky["interval_stddev_ms"] > calm["interval_stddev_ms"] * 1.5


def test_sacn_source_identity_priority_and_termination(engine, capture):
    hub, _service, _, sacn_port = capture
    engine.add_source(
        SourceConfig(
            id="s",
            protocol="sacn",
            universes=[4],
            rate=50,
            priority=130,
            source_name="模拟台",
            target="127.0.0.1",
            port=sacn_port,
            channels=32,
        )
    )
    assert wait_for(lambda: any(s["packets"] >= 5 for s in hub.snapshot()["streams"]))
    (stream,) = hub.snapshot()["streams"]
    assert (stream["source_name"], stream["priority"], stream["channels"]) == ("模拟台", 130, 32)
    assert stream["active"] and not stream["terminated"]
    engine.remove_source("s")
    assert wait_for(lambda: hub.snapshot()["streams"][0]["terminated"])
    assert not hub.snapshot()["streams"][0]["active"]
    assert stream["lost"] == 0


def test_sacn_universe_subscription_can_be_changed():
    iface = default_interface()
    if iface is None or iface.is_loopback:
        pytest.skip("没有可用于组播的真实网卡")
    hub = Hub()
    service = CaptureService(
        hub, artnet=False, sacn_port=free_udp_port(), interface_ips=[iface.ip], universes=[1, 2]
    )
    report = service.start()
    try:
        if report.sacn_join.joined == 0:
            pytest.skip(f"当前环境无法加入组播: {report.sacn_join.failed}")
        assert service.sacn_universes == [1, 2]
        added = service.set_sacn_universes([2, 3])
        assert added.joined == 1 and added.failed == []
        assert service.sacn_universes == [2, 3]
        assert service.set_sacn_universes([2, 3]).attempted == 0  # 没有变化
    finally:
        service.stop()
    assert not service.running and service.sacn_universes == []


def test_set_universes_before_start_is_a_noop():
    service = CaptureService(Hub(), sacn=False, artnet=False)
    assert service.set_sacn_universes([1]).attempted == 0


def test_start_failure_cleans_up():
    holder = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    holder.bind(("127.0.0.1", 0))
    port = holder.getsockname()[1]
    try:
        # 以独占方式占住的端口:没有 SO_REUSEADDR 的一方无法共绑;这里只验证服务不会泄漏线程。
        service = CaptureService(Hub(), artnet_port=port, sacn_port=free_udp_port())
        try:
            service.start()
        except OSError:
            assert not service.running
        else:
            service.stop()
    finally:
        holder.close()


def test_cli_listen_stats_prints_table(capsys):
    artnet_port = free_udp_port()
    thread = threading.Thread(
        target=main,
        args=(
            [
                "listen",
                "--protocol",
                "artnet",
                "--artnet-port",
                str(artnet_port),
                "--stats",
                "--interval",
                "0.4",
                "--timeout",
                "1.6",
            ],
        ),
        daemon=True,
    )
    thread.start()
    time.sleep(0.4)
    code = main(
        [
            "send",
            "--universe",
            "1-2",
            "--target",
            "127.0.0.1",
            "--port",
            str(artnet_port),
            "--duration",
            "0.8",
            "--rate",
            "50",
            "--drop-every",
            "4",
        ]
    )
    thread.join(5)
    out = capsys.readouterr().out
    assert code == 0 and not thread.is_alive()
    assert "PROTO" in out and "LOST" in out
    rows = [line for line in out.splitlines() if line.startswith("artnet")]
    assert any("127.0.0.1" in r for r in rows)
    assert "PPS 包/秒" in out  # 末尾图例
