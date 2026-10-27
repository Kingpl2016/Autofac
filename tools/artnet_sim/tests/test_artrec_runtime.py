import pathlib
import socket
import threading
import time

import pytest

from artnet_sim.capture.hub import Hub
from artnet_sim.capture.recorder import ArtRecRecorder, RecorderOptions
from artnet_sim.cli import main
from artnet_sim.generators import make_generator
from artnet_sim.generators.artrec_player import source_config_from_artrec
from artnet_sim.net.scheduler import Scheduler
from artnet_sim.net.sockets import create_recv_socket
from artnet_sim.protocol import artnet, sacn
from artnet_sim.protocol.artrec import (
    FLAG_DIFF_FRAME,
    ArtRecError,
    ArtRecReader,
    ArtRecWriter,
    DiffChange,
    UniDesc,
)
from artnet_sim.sender.engine import SendEngine

CID = bytes([0x22] * 16)


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def make_program(tmp_path, universes=(0, 1), diff=False, name="p.artrec"):
    """3 帧节目:0s 全为 10,1s 全为 20,2s 全为 30(差分模式下第 2 帧是差分帧)。"""
    path = tmp_path / name
    flags = FLAG_DIFF_FRAME if diff else 0
    with open(path, "w+b") as fp:
        w = ArtRecWriter(fp, [UniDesc.from_universe(u, 8) for u in universes], flags=flags)
        w.add_full_frame(0, [bytes([10]) * 8 for _ in universes])
        w.add_full_frame(1_000_000, [bytes([20]) * 8 for _ in universes])
        if diff:
            w.add_diff_frame(2_000_000, [DiffChange(0, c, 30) for c in range(8)])
        else:
            w.add_full_frame(2_000_000, [bytes([30]) * 8 for _ in universes])
        w.finish(2_000_000)
    return str(path)


# ---------------------------------------------------------------------------
# 回放生成器
# ---------------------------------------------------------------------------


def test_player_follows_the_timeline(tmp_path):
    gen = make_generator("artrec", {"path": make_program(tmp_path), "loop": False})
    assert gen.render(0.0, 0, 8) == bytes([10]) * 8
    assert gen.render(0.99, 0, 8) == bytes([10]) * 8
    assert gen.render(1.0, 0, 8) == bytes([20]) * 8
    assert gen.render(1.5, 1, 8) == bytes([20]) * 8
    assert gen.render(2.0, 0, 8) == bytes([30]) * 8
    assert gen.render(99.0, 0, 8) == bytes([30]) * 8  # 不循环:停在最后一帧


def test_player_loop_start_and_speed(tmp_path):
    path = make_program(tmp_path)
    looping = make_generator("artrec", {"path": path, "loop": True})
    assert looping.render(2.5, 0, 8) == bytes([10]) * 8  # 取模回到 0.5 秒处
    assert looping.render(3.2, 0, 8) == bytes([20]) * 8
    fast = make_generator("artrec", {"path": path, "loop": False, "speed": 2.0})
    assert fast.render(0.5, 0, 8) == bytes([20]) * 8  # 倍速 2 → 1 秒处
    offset = make_generator("artrec", {"path": path, "loop": False, "start": 1.5})
    assert offset.render(0.0, 0, 8) == bytes([20]) * 8
    assert offset.render(0.6, 0, 8) == bytes([30]) * 8


def test_player_backward_jump_and_diff_reconstruction(tmp_path):
    gen = make_generator("artrec", {"path": make_program(tmp_path, diff=True), "loop": False})
    assert gen.render(2.5, 0, 8) == bytes([30]) * 8  # 直接跳到差分帧,从全量帧重建
    assert gen.render(2.5, 1, 8) == bytes([20]) * 8  # 差分只改了第 0 路
    assert gen.render(0.1, 0, 8) == bytes([10]) * 8  # 往回跳
    assert gen.render(1.1, 1, 8) == bytes([20]) * 8


def test_player_pads_truncates_and_handles_extra_indexes(tmp_path):
    gen = make_generator("artrec", {"path": make_program(tmp_path), "loop": False})
    assert gen.render(0.0, 0, 12) == bytes([10]) * 8 + bytes(4)
    assert gen.render(0.0, 0, 3) == bytes([10]) * 3
    assert gen.render(0.0, 5, 4) == bytes(4)  # 文件里没有这一路


def test_player_before_first_frame_is_dark(tmp_path):
    path = tmp_path / "late.artrec"
    with open(path, "w+b") as fp:
        w = ArtRecWriter(fp, [UniDesc.from_universe(0, 4)])
        w.add_full_frame(500_000, [bytes([9]) * 4])
        w.finish(1_000_000)
    gen = make_generator("artrec", {"path": str(path), "loop": False})
    assert gen.render(0.1, 0, 4) == bytes(4)
    assert gen.render(0.6, 0, 4) == bytes([9]) * 4


def test_player_parameter_errors(tmp_path):
    with pytest.raises(ValueError, match="path"):
        make_generator("artrec", {})
    with pytest.raises(OSError):
        make_generator("artrec", {"path": str(tmp_path / "missing.artrec")})
    with pytest.raises(ValueError, match="true/false"):
        make_generator("artrec", {"path": "x", "loop": "yes"})
    with pytest.raises(ValueError, match="字符串"):
        make_generator("artrec", {"path": 5})


def test_source_config_from_artrec(tmp_path):
    path = make_program(tmp_path, universes=(0, 7))
    config = source_config_from_artrec(
        path, protocol="artnet", target="127.0.0.1", generator_params={"loop": False}
    )
    assert config.universes == [0, 7] and config.generator == "artrec"
    assert config.generator_params == {"path": path, "loop": False}
    shifted = source_config_from_artrec(
        path, protocol="sacn", universe_offset=1, target="127.0.0.1"
    )
    assert shifted.universes == [1, 8]
    with pytest.raises(ValueError, match="universe_offset"):
        source_config_from_artrec(path, protocol="sacn")


def test_engine_plays_an_artrec_file_over_loopback(tmp_path):
    path = make_program(tmp_path, universes=(0, 3))
    rx = create_recv_socket(0, "127.0.0.1", timeout=0.1)
    port = rx.getsockname()[1]
    received: list[bytes] = []
    done = threading.Event()

    def pump():
        while not done.is_set():
            try:
                received.append(rx.recvfrom(2048)[0])
            except (TimeoutError, ConnectionResetError, OSError):
                continue

    thread = threading.Thread(target=pump, daemon=True)
    thread.start()
    engine = SendEngine(Scheduler(boost_priority=False), resolver=lambda spec: None)
    engine.start()
    try:
        config = source_config_from_artrec(
            path,
            target="127.0.0.1",
            port=port,
            rate=50,
            channels=8,
            generator_params={"speed": 4.0, "loop": False},
        )
        source = engine.add_source(config)
        deadline = time.monotonic() + 3
        while source.stats.frames < 30 and time.monotonic() < deadline:
            time.sleep(0.01)
    finally:
        engine.stop()
        time.sleep(0.15)
        done.set()
        thread.join(1)
        rx.close()
    parsed = [artnet.parse_dmx(p) for p in received]
    by_universe = {0: [], 3: []}
    for p in parsed:
        by_universe[p.port_address].append(p.data[0])
    for values in by_universe.values():
        assert values[0] == 10 and 20 in values and values[-1] == 30  # 节目被依次播出
        assert values == sorted(values)


# ---------------------------------------------------------------------------
# 录制器
# ---------------------------------------------------------------------------


def art(universe, fill, seq=1, n=8):
    return artnet.build_dmx(universe, seq, bytes([fill]) * n)


def feed(hub, packet, ip="10.0.0.1"):
    hub.ingest(packet, (ip, 1234), time.perf_counter_ns())


def read_back(path):
    reader = ArtRecReader.open(str(path))
    return reader, [(t, [bytes(b) for b in bufs]) for t, bufs in reader.iter_frames()]


def test_recorder_coalesces_changes_and_keeps_tail_duration(tmp_path):
    hub = Hub()
    path = tmp_path / "rec.artrec"
    recorder = ArtRecRecorder(hub, path, RecorderOptions([1, 2, 3], coalesce_ms=30))
    recorder.start()
    for universe, fill in ((1, 5), (2, 6), (3, 7)):  # 几乎同时到达 → 合并成一帧
        feed(hub, art(universe, fill))
    time.sleep(0.15)
    feed(hub, art(2, 60, seq=2))  # 只有 U2 变化
    time.sleep(0.15)
    feed(hub, art(2, 60, seq=3))  # 数据没变 → 不产生新帧
    time.sleep(0.2)
    report = recorder.stop()
    assert report.error is None and report.path == str(path)
    assert not (tmp_path / "rec.artrec.part").exists()
    reader, frames = read_back(path)
    assert report.recorded_universes == [1, 2, 3]
    assert reader.universes == [1, 2, 3]
    # 帧 0:三路一起;帧 1:U2 变化;最后一帧:补在结束时刻的相同画面
    assert len(frames) == 3 == report.frames
    assert [bytes(b[:1]) for b in frames[0][1]] == [b"\x05", b"\x06", b"\x07"]
    assert frames[1][1][1][:1] == b"\x3c" and frames[1][1][0][:1] == b"\x05"
    assert frames[2][1] == frames[1][1]
    times = [t for t, _ in frames]
    assert times == sorted(times) and times[0] == 0
    assert reader.duration_us == times[-1] >= 300_000
    assert report.bytes_written == path.stat().st_size


def test_recorder_filters_protocols_and_sources(tmp_path):
    hub = Hub()
    path = tmp_path / "f.artrec"
    options = RecorderOptions(
        [1], protocols=frozenset({"artnet"}), src_ips=frozenset({"10.0.0.1"}), coalesce_ms=5
    )
    recorder = ArtRecRecorder(hub, path, options)
    recorder.start()
    feed(hub, art(1, 9), ip="10.0.0.2")  # 来源不符
    feed(hub, sacn.build_data(1, bytes([8]) * 8, CID, "x"), ip="10.0.0.1")  # 协议不符
    feed(hub, art(9, 7), ip="10.0.0.1")  # Universe 没选
    time.sleep(0.05)
    feed(hub, art(1, 4), ip="10.0.0.1")
    time.sleep(0.1)
    report = recorder.stop()
    _reader, frames = read_back(path)
    assert [f[1][0][0] for f in frames] == [4, 4]  # 一帧数据 + 结尾补的一帧
    assert report.error is None


def test_recorder_skips_universes_beyond_2047_and_reports_them(tmp_path):
    hub = Hub()
    path = tmp_path / "limit.artrec"
    recorder = ArtRecRecorder(hub, path, RecorderOptions([1, 2048, 3000]))
    assert recorder.recordable_universes == [1]
    recorder.start()
    feed(hub, art(1, 3))
    for _ in range(4):
        feed(hub, sacn.build_data(3000, bytes(8), CID, "x"))
    feed(hub, sacn.build_data(2048, bytes(8), CID, "x"))
    time.sleep(0.1)
    report = recorder.stop()
    assert report.skipped_over_limit == {2048: 1, 3000: 4}
    _reader, frames = read_back(path)
    assert frames and frames[0][1][0][0] == 3


def test_recorder_diff_mode_roundtrips(tmp_path):
    hub = Hub()
    path = tmp_path / "diff.artrec"
    recorder = ArtRecRecorder(hub, path, RecorderOptions([1, 2], use_diff=True, coalesce_ms=5))
    recorder.start()
    feed(hub, art(1, 1, n=512))
    feed(hub, art(2, 2, n=512))
    for step in range(3, 6):
        time.sleep(0.05)
        packet = bytearray(art(1, 1, seq=step, n=512))
        packet[18 + step] = 200  # 每次只改一个通道
        feed(hub, bytes(packet))
    time.sleep(0.05)
    report = recorder.stop()
    reader, frames = read_back(path)
    assert reader.header.allows_diff
    types = [reader.chunk_type(i) for i in range(len(frames))]
    assert types[0] == 0 and 1 in types  # 首帧全量,中间有差分帧
    assert report.error is None
    final = frames[-1][1][0]
    # 每一步的包都是新构造的,只有最后一步的通道 5 为 200,其余回到 1
    assert final[5] == 200 and final[3] == final[4] == final[6] == 1
    assert frames[-1][1][1][0] == 2
    assert reader.header.total_duration_us == frames[-1][0]


def test_recorder_pads_short_packets_and_truncates_long(tmp_path):
    hub = Hub()
    path = tmp_path / "pad.artrec"
    recorder = ArtRecRecorder(hub, path, RecorderOptions([1]))
    recorder.start()
    feed(hub, art(1, 7, n=4))
    time.sleep(0.1)
    recorder.stop()
    reader, frames = read_back(path)
    assert reader.unis[0].dmx_len == 512
    assert frames[0][1][0][:6] == bytes([7, 7, 7, 7, 0, 0])


def test_recorder_option_errors(tmp_path):
    with pytest.raises(ArtRecError, match="没有可录制"):
        ArtRecRecorder(Hub(), tmp_path / "a.artrec", RecorderOptions([5000]))
    with pytest.raises(ArtRecError, match="Universe 太多"):
        ArtRecRecorder(Hub(), tmp_path / "a.artrec", RecorderOptions(list(range(200))))
    recorder = ArtRecRecorder(Hub(), tmp_path / "ok.artrec", RecorderOptions([1]))
    recorder.start()
    with pytest.raises(ArtRecError, match="已经启动"):
        recorder.start()
    first = recorder.stop()
    assert recorder.stop() is first  # 重复 stop 返回同一份结果
    assert first.frames == 0
    assert ArtRecReader.open(str(tmp_path / "ok.artrec")).header.frame_count == 0


def test_recorder_write_failure_is_reported(tmp_path):
    blocker = tmp_path / "blocker"
    blocker.write_text("not a directory")
    recorder = ArtRecRecorder(Hub(), blocker / "sub" / "x.artrec", RecorderOptions([1]))
    with pytest.raises(OSError):
        recorder.start()


def test_recorder_listener_removed_after_stop(tmp_path):
    hub = Hub()
    recorder = ArtRecRecorder(hub, tmp_path / "l.artrec", RecorderOptions([1]))
    recorder.start()
    recorder.stop()
    feed(hub, art(1, 5))  # 不应该有监听器再处理它
    assert recorder.frames == 0


# ---------------------------------------------------------------------------
# 命令行
# ---------------------------------------------------------------------------


def test_cli_info_on_rust_fixture(capsys):
    fixture = str(pathlib.Path(__file__).parent / "fixtures" / "rust_sample.artrec")
    assert main(["artrec", "info", fixture, "--verify", "--frames", "3"]) == 0
    out = capsys.readouterr().out
    assert "ZSTD 等级 3" in out and "ALLOW_DIFF_FRAME" in out
    assert "全量 2、差分 1" in out and "Universe (3 路): 0, 5, 100" in out
    assert "校验通过" in out and "差分" in out


def test_cli_info_errors(capsys, tmp_path):
    assert main(["artrec", "info", str(tmp_path / "nope.artrec")]) == 1
    bad = tmp_path / "bad.artrec"
    bad.write_bytes(b"not an artrec file at all, definitely longer than 52 bytes of junk......")
    assert main(["artrec", "info", str(bad)]) == 2
    assert "魔数" in capsys.readouterr().err
    program = make_program(tmp_path, name="c.artrec")
    data = bytearray(pathlib.Path(program).read_bytes())
    reader = ArtRecReader(bytes(data))
    data[reader.header.chunk_pool_offset + reader.index[1].chunk_pos + 12] ^= 0xFF
    corrupt = tmp_path / "corrupt.artrec"
    corrupt.write_bytes(bytes(data))
    assert main(["artrec", "info", str(corrupt), "--verify"]) == 1
    assert "校验失败" in capsys.readouterr().err


def test_cli_record_then_play_roundtrip(capsys, tmp_path):
    artnet_port = free_port()
    out_file = tmp_path / "cli.artrec"
    recorder_thread = threading.Thread(
        target=main,
        args=(
            [
                "artrec",
                "record",
                str(out_file),
                "--protocol",
                "artnet",
                "--universe",
                "1-2",
                "--artnet-port",
                str(artnet_port),
                "--sacn-port",
                str(free_port()),
                "--duration",
                "1.6",
            ],
        ),
        daemon=True,
    )
    recorder_thread.start()
    time.sleep(0.5)
    assert (
        main(
            [
                "send",
                "--universe",
                "1-2",
                "--target",
                "127.0.0.1",
                "--port",
                str(artnet_port),
                "--generator",
                "ramp",
                "--param",
                "period=0.5",
                "--rate",
                "40",
                "--duration",
                "0.8",
            ]
        )
        == 0
    )
    recorder_thread.join(8)
    out = capsys.readouterr().out
    assert not recorder_thread.is_alive() and "已保存" in out
    reader, frames = read_back(out_file)
    assert reader.universes == [1, 2]
    assert len(frames) > 5  # 渐变每帧都在变化
    assert reader.duration_us >= 700_000

    play_port = free_port()
    rx = create_recv_socket(play_port, "127.0.0.1", timeout=0.1)
    got: list[bytes] = []
    stop = threading.Event()

    def pump():
        while not stop.is_set():
            try:
                got.append(rx.recvfrom(2048)[0])
            except (TimeoutError, ConnectionResetError, OSError):
                continue

    pump_thread = threading.Thread(target=pump, daemon=True)
    pump_thread.start()
    try:
        code = main(
            [
                "artrec",
                "play",
                str(out_file),
                "--target",
                "127.0.0.1",
                "--port",
                str(play_port),
                "--duration",
                "0.5",
                "--rate",
                "50",
            ]
        )
        time.sleep(0.15)
    finally:
        stop.set()
        pump_thread.join(1)
        rx.close()
    assert code == 0
    universes = {artnet.parse_dmx(p).port_address for p in got}
    assert universes == {1, 2} and len(got) >= 30


def test_cli_record_without_signal_fails_fast(capsys, tmp_path):
    code = main(
        [
            "artrec",
            "record",
            str(tmp_path / "none.artrec"),
            "--protocol",
            "artnet",
            "--artnet-port",
            str(free_port()),
            "--detect",
            "0.3",
        ]
    )
    assert code == 1 and "没有检测到任何信号" in capsys.readouterr().err
    assert (
        main(["artrec", "record", str(tmp_path / "x.artrec"), "--level", "99", "--universe", "1"])
        == 2
    )
