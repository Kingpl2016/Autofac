"""``listen`` 子命令:监听 Art-Net / sACN,逐包打印或定期输出统计表。"""

from __future__ import annotations

import argparse
import sys
import threading
import time

from artnet_sim.capture.hub import Hub, IngestEvent
from artnet_sim.capture.report import LEGEND, format_stream_table
from artnet_sim.capture.service import CaptureService
from artnet_sim.net.interfaces import NetInterface, default_interface, find_interface
from artnet_sim.protocol.common import (
    ARTNET_PORT,
    SACN_MAX_UNIVERSE,
    SACN_MIN_UNIVERSE,
    SACN_PORT,
)
from artnet_sim.protocol.decode import summarize
from artnet_sim.util import parse_ranges


def add_arguments(parser: argparse.ArgumentParser) -> None:
    """给 ``listen`` 子命令添加参数。

    Args:
        parser: 子命令的解析器。
    """
    parser.add_argument("--protocol", choices=("artnet", "sacn", "both"), default="both")
    parser.add_argument("--interface", help="加入 sACN 组播所用的网卡(默认自动选择)")
    parser.add_argument("--universe", default="1", help="要加入组播的 sACN Universe 范围")
    parser.add_argument("--artnet-port", type=int, default=ARTNET_PORT)
    parser.add_argument("--sacn-port", type=int, default=SACN_PORT)
    parser.add_argument("--count", type=int, default=0, help="收到 N 个包后退出,0 为不限")
    parser.add_argument("--timeout", type=float, default=0.0, help="运行 N 秒后退出,0 为不限")
    parser.add_argument("--raw", action="store_true", help="逐包模式下同时打印十六进制原文")
    parser.add_argument("--stats", action="store_true", help="定期输出统计表,而不是逐包打印")
    parser.add_argument("--interval", type=float, default=1.0, help="--stats 的刷新间隔(秒)")


def _pick_interface(spec: str | None) -> NetInterface | None:
    """按参数选择网卡,未指定时自动选择。"""
    return find_interface(spec) if spec else default_interface()


def run(args: argparse.Namespace) -> int:
    """执行 ``listen``。

    Args:
        args: 解析后的命令行参数。

    Returns:
        进程退出码:0 成功,2 参数错误,1 绑定失败。
    """
    try:
        iface = _pick_interface(args.interface)
        universes = parse_ranges(
            args.universe, minimum=SACN_MIN_UNIVERSE, maximum=SACN_MAX_UNIVERSE
        )
        if args.interval <= 0:
            raise ValueError("--interval 必须大于 0")
    except (ValueError, LookupError) as exc:
        print(f"参数错误: {exc}", file=sys.stderr)
        return 2

    hub = Hub()
    done = threading.Event()
    print_lock = threading.Lock()
    shown = 0
    start = time.perf_counter()

    def on_event(event: IngestEvent) -> None:
        nonlocal shown
        with print_lock:
            if done.is_set():
                return
            line = summarize(event.raw)
            if args.raw:
                line += f"  {event.raw.hex(' ')}"
            elapsed = time.perf_counter() - start
            print(f"{elapsed:9.3f}s  {event.addr[0]}:{event.addr[1]:<5}  {line}", flush=True)
            shown += 1
            if args.count and shown >= args.count:
                done.set()

    if not args.stats:
        hub.add_listener(on_event)

    service = CaptureService(
        hub,
        artnet=args.protocol in ("artnet", "both"),
        sacn=args.protocol in ("sacn", "both"),
        artnet_port=args.artnet_port,
        sacn_port=args.sacn_port,
        interface_ips=[iface.ip] if iface is not None else [],
        universes=universes,
    )
    try:
        report = service.start()
    except OSError as exc:
        print(f"绑定失败: {exc}", file=sys.stderr)
        return 1

    for name, shared, port in (
        ("Art-Net", report.artnet_port_shared, args.artnet_port),
        ("sACN", report.sacn_port_shared, args.sacn_port),
    ):
        if shared:
            print(
                f"提示: UDP {port} 已被其他进程占用,{name} 将以地址复用方式共同绑定;"
                "单播只会送给先绑定的一方,广播与组播不受影响。",
                file=sys.stderr,
            )
    if args.protocol in ("sacn", "both"):
        join = report.sacn_join
        print(f"sACN 组播: 已加入 {join.joined} 组,失败 {len(join.failed)} 组", file=sys.stderr)
        for item in join.failed:
            print(f"  失败: {item}", file=sys.stderr)
    where = f"经 {iface.name}({iface.ip})" if iface else "所有网卡"
    print(f"监听中({args.protocol}),{where};Ctrl+C 退出", file=sys.stderr)

    deadline = time.perf_counter() + args.timeout if args.timeout > 0 else None
    try:
        while not done.is_set():
            remaining = None if deadline is None else deadline - time.perf_counter()
            if remaining is not None and remaining <= 0:
                break
            wait = args.interval if args.stats else 0.1
            done.wait(wait if remaining is None else min(wait, remaining))
            if args.stats and not done.is_set():
                print(format_stream_table(hub.snapshot()))
                print()
    except KeyboardInterrupt:
        pass
    finally:
        service.stop()

    if args.stats:
        print(format_stream_table(hub.snapshot()))
        print(LEGEND)
    else:
        print(f"共显示 {shown} 个包", file=sys.stderr)
    return 0
