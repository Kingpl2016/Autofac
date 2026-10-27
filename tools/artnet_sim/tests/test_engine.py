import socket
import threading
import time

import pytest

from artnet_sim.net.scheduler import Scheduler
from artnet_sim.net.sockets import create_recv_socket
from artnet_sim.protocol import artnet, sacn
from artnet_sim.sender.engine import SendEngine
from artnet_sim.sender.impairments import Impairments
from artnet_sim.sender.source import SourceConfig


class Collector:
    """在回环地址上收包并保留顺序。"""

    def __init__(self):
        self.sock = create_recv_socket(0, "127.0.0.1", timeout=0.1)
        self.port = self.sock.getsockname()[1]
        self.packets: list[tuple[bytes, float]] = []
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self):
        while not self._stop.is_set():
            try:
                data, _ = self.sock.recvfrom(2048)
            except (TimeoutError, ConnectionResetError):
                continue
            except OSError:
                return
            self.packets.append((data, time.perf_counter()))

    def close(self):
        self._stop.set()
        self._thread.join(1)
        self.sock.close()


@pytest.fixture
def collector():
    c = Collector()
    yield c
    c.close()


@pytest.fixture
def engine():
    e = SendEngine(Scheduler(boost_priority=False), resolver=lambda spec: None)
    e.start()
    yield e
    e.stop()


def wait_for(predicate, timeout=3.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return False


def test_end_to_end_artnet_over_loopback(engine, collector):
    config = SourceConfig(
        id="a",
        universes=[1, 2],
        generator="fixed",
        generator_params={"value": 42},
        rate=100,
        target="127.0.0.1",
        port=collector.port,
    )
    source = engine.add_source(config)
    assert wait_for(lambda: source.stats.frames >= 20)
    engine.remove_source("a")
    time.sleep(0.15)
    parsed = [artnet.parse_dmx(p) for p, _ in collector.packets]
    assert len(parsed) >= 40
    u1 = [p for p in parsed if p.port_address == 1]
    assert u1[0].data == bytes([42]) * 512
    seqs = [p.sequence for p in u1]
    assert seqs[:5] == [1, 2, 3, 4, 5]
    # 回环上不应有乱序或丢包:序号逐个递增(含回绕)
    for a, b in zip(seqs, seqs[1:], strict=False):
        assert b == (a % 255) + 1


def test_end_to_end_sacn_unicast_with_terminate_on_remove(engine, collector):
    config = SourceConfig(
        id="s",
        protocol="sacn",
        universes=[3],
        generator="ramp",
        rate=50,
        priority=111,
        target="127.0.0.1",
        port=collector.port,
        channels=64,
    )
    source = engine.add_source(config)
    assert wait_for(lambda: source.stats.frames >= 5)
    engine.remove_source("s")
    assert wait_for(
        lambda: any(
            sacn.parse_data(p) and sacn.parse_data(p).terminated for p, _ in collector.packets
        )
    )
    time.sleep(0.1)
    parsed = [sacn.parse_data(p) for p, _ in collector.packets]
    assert all(p.universe == 3 and p.priority == 111 and len(p.data) == 64 for p in parsed)
    assert sum(p.terminated for p in parsed) == 3
    assert parsed[-1].terminated  # 终止包在最后


def test_loss_is_visible_as_sequence_gaps(engine, collector):
    config = SourceConfig(
        id="gap",
        universes=[1],
        rate=100,
        target="127.0.0.1",
        port=collector.port,
        impairments=Impairments(drop_every=4, seed=1),
    )
    source = engine.add_source(config)
    assert wait_for(lambda: source.stats.frames >= 24)
    engine.remove_source("gap")
    time.sleep(0.15)
    seqs = [artnet.parse_dmx(p).sequence for p, _ in collector.packets]
    gaps = sum(1 for a, b in zip(seqs, seqs[1:], strict=False) if b != (a % 255) + 1)
    assert gaps >= 5
    assert source.stats.dropped >= 5


def test_duplicate_id_unknown_and_policy_errors(engine):
    cfg = SourceConfig(id="x", target="127.0.0.1", rate=10)
    engine.add_source(cfg)
    with pytest.raises(ValueError, match="已存在"):
        engine.add_source(SourceConfig(id="x", target="127.0.0.1"))
    assert engine.remove_source("nope") is False
    assert engine.get("x") is not None and engine.get("nope") is None
    assert [s.config.id for s in engine.sources()] == ["x"]
    with pytest.raises(ValueError, match="公网"):
        engine.add_source(SourceConfig(id="pub", target="8.8.8.8"))
    with pytest.raises(ValueError, match="broadcast"):
        engine.add_source(SourceConfig(id="nobc", target="broadcast"))


def test_public_target_requires_explicit_allow(engine):
    source = engine.add_source(
        SourceConfig(id="pub", target="8.8.8.8", allow_public=True, rate=1.0)
    )
    source.pause()  # 不真的往公网发


def test_stop_terminates_running_sacn_sources():
    collector = Collector()
    try:
        engine = SendEngine(Scheduler(boost_priority=False), resolver=lambda spec: None)
        engine.start()
        engine.add_source(
            SourceConfig(
                id="s",
                protocol="sacn",
                universes=[1],
                rate=50,
                target="127.0.0.1",
                port=collector.port,
                channels=8,
            )
        )
        time.sleep(0.2)
        engine.stop()
        time.sleep(0.15)
        parsed = [sacn.parse_data(p) for p, _ in collector.packets]
        assert sum(p.terminated for p in parsed) == 3
    finally:
        collector.close()


@pytest.mark.slow
def test_timing_64_universes_at_44hz(engine, collector, capsys):
    """64 个 Universe × 44 Hz 打到回环,统计调度迟到与实际送达间隔。"""
    config = SourceConfig(
        id="load",
        universes=list(range(1, 65)),
        generator="rainbow",
        rate=44,
        target="127.0.0.1",
        port=collector.port,
    )
    source = engine.add_source(config)
    time.sleep(3.0)
    engine.remove_source("load")
    stats = engine.scheduler.stats()
    frames = source.stats.frames
    with capsys.disabled():
        print(
            f"\n[64U×44Hz] 帧 {frames}, 迟到 p50 {stats.late_p50 * 1e3:.3f}ms "
            f"p99 {stats.late_p99 * 1e3:.3f}ms max {stats.late_max * 1e3:.3f}ms, "
            f"丢帧 {stats.skipped}, 发送失败 {source.stats.send_errors}"
        )
    assert 120 <= frames <= 140  # 3 秒 × 44 Hz ≈ 132
    assert source.stats.send_errors == 0
    assert stats.late_p99 < 0.010  # 宽松上限:p99 迟到小于 10ms


def test_socket_factory_is_used_once_per_bind_ip():
    created = []

    def factory(bind_ip):
        created.append(bind_ip)
        return socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    engine = SendEngine(
        Scheduler(boost_priority=False), resolver=lambda spec: None, socket_factory=factory
    )
    try:
        for i in range(3):
            engine.add_source(SourceConfig(id=f"s{i}", target="127.0.0.1", rate=1.0))
        assert created == [None]
    finally:
        engine.stop()
