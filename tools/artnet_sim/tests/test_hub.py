import pytest

from artnet_sim.capture.hub import Hub
from artnet_sim.capture.packet_log import PacketFilter, PacketLog
from artnet_sim.capture.report import format_stream_table
from artnet_sim.protocol import artnet, artnet_ext, sacn

CID_A = bytes([0xA] * 16)
CID_B = bytes([0xB] * 16)
STEP = 22_727_272  # 44 Hz


def art(universe, seq, fill=1, n=4):
    return artnet.build_dmx(universe, seq, bytes([fill]) * n)


def sac(universe, seq, cid=CID_A, name="台A", prio=100, fill=1, options=0):
    return sacn.build_data(
        universe, bytes([fill]) * 4, cid, name, priority=prio, sequence=seq, options=options
    )


def feed(hub, packets, ip="10.0.0.1", port=5000, start=0, step=STEP):
    for i, p in enumerate(packets):
        hub.ingest(p, (ip, port), start + i * step)


def stream_of(hub, **match):
    (item,) = [
        s for s in hub.snapshot(10**12)["streams"] if all(s[k] == v for k, v in match.items())
    ]
    return item


def test_artnet_stream_stats():
    hub = Hub()
    feed(hub, [art(1, s) for s in range(1, 11)])
    now = 9 * STEP
    snap = hub.snapshot(now)
    (s,) = snap["streams"]
    assert (s["protocol"], s["universe"], s["src_ip"], s["src_port"]) == (
        "artnet",
        1,
        "10.0.0.1",
        5000,
    )
    assert s["packets"] == 10 and s["lost"] == 0 and s["out_of_order"] == 0
    assert s["bytes"] == 10 * len(art(1, 1))
    assert s["interval_mean_ms"] == pytest.approx(22.727, abs=0.01)
    assert s["interval_stddev_ms"] == pytest.approx(0.0, abs=0.01)
    assert s["active"] and s["channels"] == 4


def test_gap_ooo_duplicate_detected_through_hub():
    hub = Hub()
    feed(hub, [art(1, s) for s in (1, 2, 5, 4, 6, 6, 7)])
    s = hub.snapshot(10**9)["streams"][0]
    assert s["lost"] == 1  # 5 到达时判定丢了 3、4;4 迟到后扣回 1 个,最终只有 3 丢失
    assert s["out_of_order"] == 1
    assert s["duplicates"] == 1


def test_separate_streams_per_source_ip_and_universe():
    hub = Hub()
    feed(hub, [art(1, 1), art(1, 2)], ip="10.0.0.1")
    feed(hub, [art(1, 1)], ip="10.0.0.2")
    feed(hub, [art(2, 1)], ip="10.0.0.1")
    snap = hub.snapshot(10**9)
    assert len(snap["streams"]) == 3
    assert stream_of(hub, src_ip="10.0.0.1", universe=1)["packets"] == 2


def test_sacn_streams_are_keyed_by_cid_not_ip():
    hub = Hub()
    feed(hub, [sac(1, 0, CID_A, "台A", 100), sac(1, 1, CID_A, "台A", 100)])
    feed(hub, [sac(1, 0, CID_B, "台B", 150)])  # 同 IP、同 Universe,不同 CID
    snap = hub.snapshot(10**9)
    assert len(snap["streams"]) == 2
    b = stream_of(hub, source_name="台B")
    assert b["priority"] == 150 and b["cid"] == CID_B.hex()
    assert stream_of(hub, source_name="台A")["packets"] == 2


def test_sacn_terminated_marks_stream_and_recovers():
    hub = Hub()
    feed(hub, [sac(1, 0), sac(1, 1)])
    feed(hub, [sac(1, 2, options=sacn.OPT_STREAM_TERMINATED)], start=3 * STEP)
    s = stream_of(hub, universe=1)
    assert s["terminated"] and not s["active"]
    feed(hub, [sac(1, 3)], start=4 * STEP)
    s = stream_of(hub, universe=1)
    assert not s["terminated"]


def test_inactive_after_timeout():
    hub = Hub()
    feed(hub, [art(1, 1)])
    assert hub.snapshot(2_000_000_000)["streams"][0]["active"]
    assert not hub.snapshot(3_000_000_000)["streams"][0]["active"]


def test_latest_returns_most_recent_stream():
    hub = Hub()
    feed(hub, [art(1, 1, fill=10)], ip="10.0.0.1", start=0)
    feed(hub, [art(1, 1, fill=20)], ip="10.0.0.2", start=STEP)
    data, t_ns, source = hub.latest("artnet", 1)
    assert data == bytes([20]) * 4 and source == "10.0.0.2" and t_ns == STEP
    assert hub.latest("artnet", 99) is None
    assert hub.latest("sacn", 1) is None


def test_late_and_duplicate_packets_do_not_overwrite_data():
    hub = Hub()
    feed(hub, [art(1, 1, fill=1), art(1, 2, fill=2), art(1, 3, fill=3)])
    feed(hub, [art(1, 2, fill=99)], start=5 * STEP)  # 迟到的旧包
    feed(hub, [art(1, 3, fill=88)], start=6 * STEP)  # 重复包
    assert hub.latest("artnet", 1)[0] == bytes([3]) * 4


def test_non_data_packets_are_counted_not_streamed():
    hub = Hub()
    feed(hub, [artnet.build_poll(), artnet_ext.build_sync(), b"garbage", sacn.build_sync(5, CID_A)])
    (disc,) = sacn.build_discovery(CID_A, [1, 2])
    feed(hub, [disc])
    snap = hub.snapshot(10**9)
    assert snap["streams"] == []
    kinds = snap["totals"]["kinds"]
    assert kinds["artnet.poll"] == 1 and kinds["artnet.sync"] == 1
    assert kinds["sacn.sync"] == 1 and kinds["sacn.discovery"] == 1
    assert snap["totals"]["unknown"] == 1
    assert snap["totals"]["logged"] == 5


def test_invalid_dmx_does_not_create_stream():
    hub = Hub()
    bad = bytearray(art(1, 1))
    bad[14:16] = (0x8000).to_bytes(2, "little")  # Port-Address 越界
    feed(hub, [bytes(bad)])
    assert hub.snapshot(10**9)["streams"] == []


def test_listeners_receive_events_and_exceptions_are_swallowed():
    hub = Hub()
    events = []

    def boom(_event):
        raise RuntimeError("boom")

    hub.add_listener(boom)
    hub.add_listener(events.append)
    feed(hub, [art(7, 1), artnet.build_poll()])
    assert len(events) == 2
    first, second = events
    assert (first.protocol, first.kind, first.universe, first.sequence) == ("artnet", "data", 7, 1)
    assert first.stream is not None and first.seq_event.kind == "first"
    assert second.kind == "poll" and second.stream is None
    hub.remove_listener(events.append)
    feed(hub, [art(7, 2)])
    assert len(events) == 2


def test_stream_cap_protects_memory():
    hub = Hub(max_streams=3)
    feed(hub, [art(u, 1) for u in range(1, 6)])
    snap = hub.snapshot(10**9)
    assert len(snap["streams"]) == 3
    assert snap["totals"]["dropped_streams"] == 2


def test_packet_log_integration_and_filters():
    hub = Hub(log_capacity=100)
    feed(hub, [art(1, 1), art(2, 1)], ip="10.0.0.1")
    feed(hub, [sac(5, 0)], ip="10.0.0.2")
    everything = hub.log.query()
    assert [p.number for p in everything] == [1, 2, 3]
    assert [p.universe for p in hub.log.query(PacketFilter(protocol="artnet"))] == [1, 2]
    assert [p.universe for p in hub.log.query(PacketFilter(src_ip="10.0.0.2"))] == [5]
    assert [p.number for p in hub.log.query(PacketFilter(universe=2))] == [2]
    assert [p.number for p in hub.log.query(after=2)] == [3]


def test_clear_resets_everything():
    hub = Hub()
    feed(hub, [art(1, 1)])
    hub.clear()
    snap = hub.snapshot(10**9)
    assert snap["streams"] == [] and snap["totals"]["kinds"] == {}
    assert hub.log.query() == []


def test_packet_log_ring_pause_and_incremental_pull():
    log = PacketLog(capacity=3)
    for i in range(5):
        log.add(i, ("10.0.0.1", 1), "artnet", 1, b"x")
    assert [p.number for p in log.query()] == [3, 4, 5]  # 只保留最新 3 条
    assert log.total == 5
    assert [p.number for p in log.query(limit=2)] == [4, 5]
    log.paused = True
    assert log.add(9, ("10.0.0.1", 1), "artnet", 1, b"x") == 0
    assert log.total == 5
    log.paused = False
    log.clear()
    assert log.query() == [] and log.add(1, ("a", 1), "artnet", 1, b"") == 6
    with pytest.raises(ValueError):
        PacketLog(0)


def test_format_stream_table():
    hub = Hub()
    assert "还没有" in format_stream_table(hub.snapshot(0))
    feed(hub, [art(1, s) for s in (1, 2, 4)])
    feed(hub, [sac(3, 0, name="控制台")], ip="10.0.0.9")
    lines = format_stream_table(hub.snapshot(3 * STEP)).splitlines()
    assert lines[0].startswith("PROTO")
    assert len(lines) == 3
    assert lines[1].startswith("artnet")
    assert "控制台" in lines[2]
