"""``artrec`` 子命令:查看、回放、录制 ``.artrec`` 节目文件。"""

from __future__ import annotations

import argparse
import sys
import threading
import time
from datetime import UTC, datetime
from pathlib import Path

from artnet_sim.capture.hub import Hub
from artnet_sim.capture.recorder import ArtRecRecorder, RecorderOptions
from artnet_sim.capture.service import CaptureService
from artnet_sim.generators.artrec_player import source_config_from_artrec
from artnet_sim.net.interfaces import default_interface, find_interface
from artnet_sim.protocol.artrec import (
    CHUNK_DIFF,
    FLAG_LOOP,
    ArtRecError,
    ArtRecReader,
    Compress,
)
from artnet_sim.protocol.common import ARTNET_PORT, SACN_MAX_UNIVERSE, SACN_MIN_UNIVERSE, SACN_PORT
from artnet_sim.sender.engine import SendEngine
from artnet_sim.util import parse_ranges


def add_arguments(parser: argparse.ArgumentParser) -> None:
    """给 ``artrec`` 子命令添加参数。

    Args:
        parser: 子命令的解析器。
    """
    sub = parser.add_subparsers(dest="artrec_command", metavar="<动作>", required=True)

    p_info = sub.add_parser("info", help="查看 .artrec 文件信息")
    p_info.add_argument("file")
    p_info.add_argument("--verify", action="store_true", help="解压并校验全部 Chunk 的 CRC16")
    p_info.add_argument("--frames", type=int, default=0, help="列出前 N 帧的概况")

    p_play = sub.add_parser("play", help="把 .artrec 作为信号源回放")
    p_play.add_argument("file")
    p_play.add_argument("--protocol", choices=("artnet", "sacn"), default="artnet")
    p_play.add_argument("--target", default="broadcast", help="broadcast | multicast | 目标 IP")
    p_play.add_argument("--interface", help="出口网卡名称或 IP")
    p_play.add_argument("--port", type=int, default=0)
    p_play.add_argument("--rate", type=float, default=44.0, help="输出帧率(默认 44)")
    p_play.add_argument("--speed", type=float, default=1.0, help="倍速")
    p_play.add_argument("--start", type=float, default=0.0, help="起始位置(秒)")
    p_play.add_argument("--loop", action="store_true", help="循环播放")
    p_play.add_argument("--universe-offset", type=int, default=0, help="给文件里的 Universe 加偏移")
    p_play.add_argument("--priority", type=int, default=100, help="sACN 优先级")
    p_play.add_argument("--duration", type=float, default=0.0, help="最多播放 N 秒,0 为播完为止")
    p_play.add_argument("--allow-public", action="store_true")

    p_rec = sub.add_parser("record", help="把收到的信号录制成 .artrec")
    p_rec.add_argument("file", help="输出文件路径")
    p_rec.add_argument("--protocol", choices=("artnet", "sacn", "both"), default="both")
    p_rec.add_argument("--universe", help="要录制的 Universe 范围;不填则先检测")
    p_rec.add_argument(
        "--detect", type=float, default=2.0, help="检测信号的秒数(未指定 --universe)"
    )
    p_rec.add_argument("--join", default="1-32", help="检测模式下加入组播的 sACN Universe 范围")
    p_rec.add_argument("--src-ip", action="append", default=[], help="只录制这个来源 IP,可重复")
    p_rec.add_argument("--interface", help="加入 sACN 组播所用的网卡")
    p_rec.add_argument("--duration", type=float, default=0.0, help="录制 N 秒,0 为直到 Ctrl+C")
    p_rec.add_argument("--diff", action="store_true", help="变化很少时写差分帧")
    p_rec.add_argument("--level", type=int, default=3, help="Zstd 等级")
    p_rec.add_argument("--no-compress", action="store_true", help="不压缩")
    p_rec.add_argument("--coalesce-ms", type=float, default=5.0, help="变化合并窗口(毫秒)")
    p_rec.add_argument("--artnet-port", type=int, default=ARTNET_PORT)
    p_rec.add_argument("--sacn-port", type=int, default=SACN_PORT)


def run(args: argparse.Namespace) -> int:
    """执行 ``artrec`` 子命令。

    Args:
        args: 解析后的命令行参数。

    Returns:
        进程退出码:0 成功,2 参数或文件错误,1 运行时错误。
    """
    try:
        if args.artrec_command == "info":
            return _info(args)
        if args.artrec_command == "play":
            return _play(args)
        return _record(args)
    except (ArtRecError, ValueError, LookupError) as exc:
        print(f"✗ {exc}", file=sys.stderr)
        return 2
    except OSError as exc:
        print(f"✗ {exc}", file=sys.stderr)
        return 1


# ---------------------------------------------------------------------- info
def _info(args: argparse.Namespace) -> int:
    """``artrec info``。"""
    path = Path(args.file)
    reader = ArtRecReader.open(str(path))
    h = reader.header
    types = [reader.chunk_type(i) for i in range(len(reader.index))]
    diff_count = sum(1 for t in types if t == CHUNK_DIFF)
    flags = [
        name
        for bit, name in ((FLAG_LOOP, "LOOP"), (4, "ALLOW_DIFF_FRAME"), (2, "SMPTE"))
        if h.flags & bit
    ]
    seconds = h.total_duration_us / 1e6
    print(f"文件: {path}  ({path.stat().st_size} 字节)")
    print(f"版本 {h.ver_major}.{h.ver_minor}  字节序 {'大端' if reader._order == '>' else '小端'}")
    algo = f"{h.compress_algo.name} 等级 {h.compress_level}" if h.compress_algo else "NONE"
    print(f"压缩: {algo}    标志: {', '.join(flags) or '无'}")
    if h.rec_start_us:
        started = datetime.fromtimestamp(h.rec_start_us / 1e6, tz=UTC)
        print(f"录制开始: {started:%Y-%m-%d %H:%M:%S} UTC")
    fps = f",平均 {len(reader.index) / seconds:.1f} 帧/秒" if seconds > 0 else ""
    print(
        f"时长: {seconds:.3f} 秒    帧数: {len(reader.index)}"
        f"(全量 {len(types) - diff_count}、差分 {diff_count}){fps}"
    )
    shown = ", ".join(
        f"{u.universe}" + ("" if u.dmx_len == 512 else f"/{u.dmx_len}") for u in reader.unis[:24]
    )
    more = " ..." if len(reader.unis) > 24 else ""
    print(f"Universe ({len(reader.unis)} 路): {shown}{more}")

    if args.frames > 0:
        for i, entry in enumerate(reader.index[: args.frames]):
            buffers = reader.buffers_at(i)
            active = [
                f"U{u.universe}:{sum(1 for b in buf if b)}"
                for u, buf in zip(reader.unis, buffers, strict=True)
                if any(buf)
            ]
            kind = "差分" if types[i] == CHUNK_DIFF else "全量"
            print(
                f"  #{i:<5} {entry.time_us / 1e6:9.4f}s  {kind}  "
                f"非零通道 {', '.join(active[:8]) or '(全 0)'}"
            )
    if args.verify:
        bad = 0
        for i in range(len(reader.index)):
            try:
                reader.read_chunk(i)
            except ArtRecError as exc:
                bad += 1
                print(f"  ✗ 第 {i} 帧: {exc}", file=sys.stderr)
        if bad:
            print(f"校验失败: {bad}/{len(reader.index)} 帧有问题", file=sys.stderr)
            return 1
        print(f"校验通过: {len(reader.index)} 帧的 CRC16 与解压均正常")
    return 0


# ---------------------------------------------------------------------- play
def _play(args: argparse.Namespace) -> int:
    """``artrec play``。"""
    reader = ArtRecReader.open(args.file)
    duration_s = reader.duration_us / 1e6
    iface = find_interface(args.interface) if args.interface else default_interface()
    config = source_config_from_artrec(
        args.file,
        source_id="artrec-play",
        protocol=args.protocol,
        universe_offset=args.universe_offset,
        generator_params={"loop": args.loop, "speed": args.speed, "start": args.start},
        rate=args.rate,
        priority=args.priority,
        target=args.target,
        port=args.port,
        interface=iface.ip if iface and args.interface else args.interface,
        allow_public=args.allow_public,
    )
    engine = SendEngine()
    engine.start()
    try:
        source = engine.add_source(config)
        remaining = max(0.0, duration_s - args.start) / args.speed
        limit = args.duration or (0.0 if args.loop else remaining)
        print(
            f"回放 {args.file}: {len(config.universes)} 个 Universe, 节目 {duration_s:.2f} 秒"
            f"{', 循环' if args.loop else ''};Ctrl+C 结束",
            file=sys.stderr,
        )
        started = time.perf_counter()
        try:
            while not limit or time.perf_counter() - started < limit:
                time.sleep(0.05)
        except KeyboardInterrupt:
            pass
        status = source.status()
    finally:
        engine.stop()
    print(f"已发送 {status['packets']} 个包({status['frames']} 帧)")
    return 0


# -------------------------------------------------------------------- record
def _record(args: argparse.Namespace) -> int:
    """``artrec record``。"""
    iface = find_interface(args.interface) if args.interface else default_interface()
    protocols = {"artnet", "sacn"} if args.protocol == "both" else {args.protocol}
    if args.universe:
        universes = parse_ranges(args.universe, minimum=0, maximum=SACN_MAX_UNIVERSE)
        join = [u for u in universes if SACN_MIN_UNIVERSE <= u <= SACN_MAX_UNIVERSE]
    else:
        universes = []
        join = parse_ranges(args.join, minimum=SACN_MIN_UNIVERSE, maximum=SACN_MAX_UNIVERSE)
    if args.level < 1 or args.level > 22:
        raise ValueError("--level 必须在 1~22")

    hub = Hub()
    service = CaptureService(
        hub,
        artnet="artnet" in protocols,
        sacn="sacn" in protocols,
        artnet_port=args.artnet_port,
        sacn_port=args.sacn_port,
        interface_ips=[iface.ip] if iface else [],
        universes=join,
    )
    report = service.start()
    stop = threading.Event()
    recorder: ArtRecRecorder | None = None
    try:
        if report.artnet_port_shared or report.sacn_port_shared:
            print(
                "提示: 监听端口已被其他进程占用,单播只会送给先绑定的一方,广播与组播不受影响。",
                file=sys.stderr,
            )
        if not universes:
            print(f"检测信号 {args.detect:g} 秒...", file=sys.stderr)
            try:
                stop.wait(args.detect)
            except KeyboardInterrupt:
                return 0
            seen = {s["universe"] for s in hub.snapshot()["streams"] if s["protocol"] in protocols}
            if not seen:
                print(
                    "✗ 没有检测到任何信号;请确认发送端在运行,或用 --universe 指定", file=sys.stderr
                )
                return 1
            universes = sorted(seen)
            if "sacn" in protocols:
                service.set_sacn_universes(u for u in universes if u >= SACN_MIN_UNIVERSE)
        options = RecorderOptions(
            universes=universes,
            protocols=frozenset(protocols),
            src_ips=frozenset(args.src_ip) if args.src_ip else None,
            compress=Compress.NONE if args.no_compress else Compress.ZSTD,
            level=args.level,
            use_diff=args.diff,
            coalesce_ms=args.coalesce_ms,
        )
        recorder = ArtRecRecorder(hub, args.file, options)
        over = [u for u in universes if u not in recorder.recordable_universes]
        if over:
            print(
                f"提示: Universe {over} 超出 .artrec 可表示的范围(0~2047),将被跳过", file=sys.stderr
            )
        recorder.start()
        print(
            f"录制中: {len(recorder.recordable_universes)} 个 Universe → {args.file};Ctrl+C 结束",
            file=sys.stderr,
        )
        started = time.perf_counter()
        try:
            while not args.duration or time.perf_counter() - started < args.duration:
                time.sleep(0.1)
                if recorder.error:
                    break
        except KeyboardInterrupt:
            pass
        result = recorder.stop()
    finally:
        service.stop()

    if result.error:
        print(f"✗ 录制失败: {result.error}", file=sys.stderr)
        return 1
    print(
        f"已保存 {result.path}: {result.frames} 帧, "
        f"{result.duration_us / 1e6:.3f} 秒, {result.bytes_written} 字节"
    )
    if result.queue_drops:
        print(f"警告: 队列过载,丢弃了 {result.queue_drops} 个包", file=sys.stderr)
    skipped = {u: n for u, n in result.skipped_over_limit.items() if n > 0}
    if skipped:
        total = sum(skipped.values())
        print(
            f"警告: 跳过了 {len(skipped)} 个超出范围(>2047)的 Universe,"
            f"共 {total} 个包: {sorted(skipped)}",
            file=sys.stderr,
        )
    return 0
