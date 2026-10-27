import pytest

from artnet_sim.protocol import artnet, sacn
from artnet_sim.sender.impairments import Impairments
from artnet_sim.sender.source import (
    STATE_PAUSED,
    STATE_RUNNING,
    STATE_STOPPED,
    Source,
    SourceConfig,
)


class FakeTransport:
    def __init__(self):
        self.sent: list[tuple[bytes, tuple[str, int]]] = []
        self.fail = False

    def send(self, packet, dest):
        if self.fail:
            return False
        self.sent.append((packet, dest))
        return True


def make(protocol="artnet", universes=(1, 2), **kwargs):
    imp = kwargs.pop("impairments", Impairments(seed=1))
    config = SourceConfig(
        id="s1",
        protocol=protocol,
        universes=list(universes),
        impairments=imp,
        cid="00112233445566778899aabbccddeeff",
        **kwargs,
    )
    transport = FakeTransport()
    port = 6454 if protocol == "artnet" else 5568
    dests = {u: ("10.0.0.9", port) for u in config.universes}
    return Source(config, transport, dests), transport


def fire_frames(source, n, start=0.0, step=0.1):
    for i in range(n):
        source.fire(start + i * step)


def artnet_seqs(transport, universe):
    out = []
    for packet, _ in transport.sent:
        parsed = artnet.parse_dmx(packet)
        if parsed and parsed.port_address == universe:
            out.append(parsed.sequence)
    return out


def sacn_seqs(transport, universe):
    out = []
    for packet, _ in transport.sent:
        parsed = sacn.parse_data(packet)
        if parsed and parsed.universe == universe:
            out.append(parsed.sequence)
    return out


def test_artnet_packets_are_valid_and_addressed():
    source, transport = make(generator="fixed", generator_params={"value": 9}, channels=100)
    fire_frames(source, 1)
    assert len(transport.sent) == 2
    for (packet, dest), universe in zip(transport.sent, (1, 2), strict=True):
        parsed = artnet.parse_dmx(packet)
        assert parsed.port_address == universe
        assert parsed.data == bytes([9]) * 100
        assert dest == ("10.0.0.9", 6454)
    assert source.stats.frames == 1 and source.stats.packets == 2


def test_artnet_sequence_runs_1_to_255_then_wraps_to_1():
    source, transport = make(universes=(1,))
    fire_frames(source, 300)
    seqs = artnet_seqs(transport, 1)
    assert seqs[:3] == [1, 2, 3]
    assert seqs[254] == 255
    assert seqs[255] == 1  # 回绕时跳过 0
    assert 0 not in seqs


def test_artnet_odd_channel_count_is_padded():
    source, transport = make(universes=(1,), channels=3)
    fire_frames(source, 1)
    parsed = artnet.parse_dmx(transport.sent[0][0])
    assert parsed.data == b"\xff\xff\xff\x00"


def test_sacn_packets_and_sequence_wrap():
    source, transport = make(
        protocol="sacn", universes=(5,), priority=150, source_name="源", channels=16
    )
    fire_frames(source, 260)
    first = sacn.parse_data(transport.sent[0][0])
    assert first.universe == 5
    assert first.priority == 150
    assert first.source_name == "源"
    assert first.cid.hex() == "00112233445566778899aabbccddeeff"
    assert len(first.data) == 16
    seqs = sacn_seqs(transport, 5)
    assert seqs[0] == 0 and seqs[255] == 255 and seqs[256] == 0  # sACN 序号 0~255 循环


def test_sacn_stop_sends_three_terminated_packets_per_universe():
    source, transport = make(protocol="sacn", universes=(1, 2), channels=8)
    fire_frames(source, 2)
    before = len(transport.sent)
    source.stop()
    assert source.state == STATE_STOPPED
    tail = [sacn.parse_data(p) for p, _ in transport.sent[before:]]
    assert len(tail) == 6
    assert all(t.terminated for t in tail)
    assert sorted({t.universe for t in tail}) == [1, 2]
    source.stop()  # 再次停止不会重复发送
    assert len(transport.sent) == before + 6
    source.fire(10.0)
    assert len(transport.sent) == before + 6  # 停止后不再发包


def test_sacn_stop_without_terminate_and_artnet_stop_are_silent():
    s1, t1 = make(protocol="sacn", universes=(1,))
    fire_frames(s1, 1)
    n = len(t1.sent)
    s1.stop(terminate=False)
    assert len(t1.sent) == n
    s2, t2 = make(universes=(1,))
    fire_frames(s2, 1)
    n = len(t2.sent)
    s2.stop()
    assert len(t2.sent) == n


def test_pause_is_silent_and_resume_continues_sequence():
    source, transport = make(protocol="sacn", universes=(1,))
    fire_frames(source, 3)
    source.pause()
    assert source.state == STATE_PAUSED
    fire_frames(source, 5, start=1.0)
    assert len(transport.sent) == 3  # 暂停期间没有包,也没有 Terminated
    source.resume()
    assert source.state == STATE_RUNNING
    fire_frames(source, 1, start=2.0)
    assert sacn_seqs(transport, 1) == [0, 1, 2, 3]


def test_drop_every_drops_whole_frames():
    source, transport = make(impairments=Impairments(drop_every=3, seed=1))
    fire_frames(source, 9)
    seqs = artnet_seqs(transport, 1)
    # 第 3、6、9 帧被丢弃 → 序号缺口
    assert seqs == [1, 2, 4, 5, 7, 8]
    assert source.stats.dropped == 6  # 3 帧 × 2 个 Universe


def test_loss_one_drops_everything_and_zero_drops_nothing():
    source, transport = make(impairments=Impairments(loss=1.0, seed=1))
    fire_frames(source, 5)
    assert transport.sent == [] and source.stats.dropped == 10
    source, transport = make(impairments=Impairments(loss=0.0, seed=1))
    fire_frames(source, 5)
    assert len(transport.sent) == 10


def test_loss_is_reproducible_with_seed_and_roughly_matches_rate():
    def run():
        source, transport = make(
            universes=(1,), impairments=Impairments(loss=0.3, seed=7), generator="fixed"
        )
        fire_frames(source, 1000)
        return artnet_seqs(transport, 1)

    a, b = run(), run()
    assert a == b
    assert 600 <= len(a) <= 800


def test_duplicate_sends_the_same_packet_twice():
    source, transport = make(universes=(1,), impairments=Impairments(duplicate=1.0, seed=1))
    fire_frames(source, 3)
    assert artnet_seqs(transport, 1) == [1, 1, 2, 2, 3, 3]
    assert source.stats.duplicated == 3


def test_reorder_swaps_adjacent_frames():
    source, transport = make(universes=(1,), impairments=Impairments(reorder=1.0, seed=1))
    fire_frames(source, 4)
    assert artnet_seqs(transport, 1) == [2, 1, 4, 3]
    assert source.stats.reordered == 2


def test_seq_modes():
    source, transport = make(universes=(1,), impairments=Impairments(seq_mode="none"))
    fire_frames(source, 3)
    assert artnet_seqs(transport, 1) == [0, 0, 0]
    source, transport = make(universes=(1,), impairments=Impairments(seq_mode="frozen"))
    fire_frames(source, 3)
    assert artnet_seqs(transport, 1) == [1, 1, 1]
    source, transport = make(universes=(1,), impairments=Impairments(seq_reset_every=3))
    fire_frames(source, 7)
    assert artnet_seqs(transport, 1) == [1, 2, 1, 2, 3, 1, 2]


def test_frozen_repeats_last_frame_while_sequence_advances():
    source, transport = make(
        universes=(1,), generator="ramp", generator_params={"mode": "up", "period": 1.0}
    )
    source.fire(0.0)
    source.fire(0.5)
    source.frozen = True
    source.fire(0.9)
    source.fire(0.99)
    packets = [artnet.parse_dmx(p) for p, _ in transport.sent]
    assert packets[0].data != packets[1].data
    assert packets[2].data == packets[1].data == packets[3].data
    assert [p.sequence for p in packets] == [1, 2, 3, 4]


def test_send_errors_are_counted_not_raised():
    source, transport = make()
    transport.fail = True
    fire_frames(source, 2)
    assert source.stats.send_errors == 4 and source.stats.packets == 0


def test_jitter_range():
    source, _ = make(impairments=Impairments(jitter_ms=20, seed=3))
    values = [source.jitter() for _ in range(200)]
    assert all(0 <= v <= 0.02 for v in values)
    assert max(values) > 0.01
    quiet, _ = make()
    assert quiet.jitter() == 0.0


def test_interval_follows_rate():
    source, _ = make(rate=20.0)
    assert source.interval == pytest.approx(0.05)


def test_update_changes_runtime_parameters():
    source, transport = make(protocol="sacn", universes=(1,), channels=8, priority=100)
    fire_frames(source, 1)
    source.update({"rate": 10.0, "priority": 180, "channels": 32, "source_name": "新名"})
    fire_frames(source, 1, start=1.0)
    first, second = (sacn.parse_data(p) for p, _ in transport.sent)
    assert (first.priority, len(first.data)) == (100, 8)
    assert (second.priority, len(second.data), second.source_name) == (180, 32, "新名")
    assert source.interval == pytest.approx(0.1)


def test_update_generator_and_impairments():
    source, transport = make(universes=(1,))
    source.update(
        {
            "generator": "fixed",
            "generator_params": {"value": 3},
            "impairments": {"loss": 1.0, "seed": 5},
        }
    )
    fire_frames(source, 2)
    assert transport.sent == []
    source.update({"impairments": {}})
    fire_frames(source, 1, start=1.0)
    assert artnet.parse_dmx(transport.sent[0][0]).data == bytes([3]) * 512


def test_update_rejects_bad_changes_and_keeps_old_config():
    source, _ = make()
    for bad in (
        {"rate": 0},
        {"priority": 999},
        {"generator": "nope"},
        {"universes": [9]},
        {"impairments": {"loss": 2}},
        {"impairments": {"bogus": 1}},
    ):
        with pytest.raises(ValueError):
            source.update(bad)
    assert source.config.rate == 44.0
    assert source.config.generator == "fixed"
    assert source.config.impairments.loss == 0.0


@pytest.mark.parametrize(
    "kwargs",
    [
        {"id": ""},
        {"protocol": "dmx"},
        {"universes": []},
        {"universes": [1, 1]},
        {"universes": [40000]},
        {"protocol": "sacn", "universes": [0]},
        {"rate": 0.0},
        {"rate": 5000},
        {"priority": 201},
        {"channels": 0},
        {"channels": 513},
        {"port": 70000},
        {"cid": "xyz"},
        {"cid": "00"},
    ],
)
def test_config_validation(kwargs):
    with pytest.raises(ValueError):
        SourceConfig(**({"id": "x"} | kwargs)).validate()


def test_impairments_validation_and_roundtrip():
    for bad in (
        {"loss": -0.1},
        {"duplicate": 1.1},
        {"reorder": 2},
        {"drop_every": -1},
        {"seq_reset_every": -1},
        {"jitter_ms": 2000},
        {"seq_mode": "weird"},
        {"nope": 1},
    ):
        with pytest.raises(ValueError):
            Impairments.from_dict(bad)
    imp = Impairments.from_dict({"loss": 0.1, "seed": 3})
    assert Impairments.from_dict(imp.to_dict()) == imp
    assert not Impairments().active and imp.active


def test_missing_destination_is_rejected():
    config = SourceConfig(id="x", universes=[1, 2])
    with pytest.raises(ValueError, match="缺少"):
        Source(config, FakeTransport(), {1: ("10.0.0.1", 6454)})


def test_status_snapshot():
    source, _ = make(universes=(1,))
    fire_frames(source, 2)
    status = source.status()
    assert status["state"] == "running"
    assert status["frames"] == 2 and status["packets"] == 2
    assert status["universes"] == [1]
