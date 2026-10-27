"""``node`` 子命令:运行一个虚拟 Art-Net 节点。"""

from __future__ import annotations

import argparse
import sys
import threading
import time

from artnet_sim.net.interfaces import NetInterface, default_interface, find_interface
from artnet_sim.node.config import NodeConfig, PortConfig
from artnet_sim.node.manager import REPLY_MODES, SAME_HOST_IP, NodeManager, auto_node_ip
from artnet_sim.protocol.common import ARTNET_PORT, MAX_PORT_ADDRESS, SACN_PORT
from artnet_sim.util import parse_ranges


def add_arguments(parser: argparse.ArgumentParser) -> None:
    """给 ``node`` 子命令添加参数。

    Args:
        parser: 子命令的解析器。
    """
    parser.add_argument(
        "--ip",
        default="auto",
        help=(
            f"节点 IP,必须是本机地址。auto:Art-Net 端口已被占用(同机有 Studio)时用 "
            f"{SAME_HOST_IP},否则用所选网卡的 IP"
        ),
    )
    parser.add_argument("--interface", help="网卡名称或 IP(默认自动选择)")
    parser.add_argument("--name", default="artnet-sim", help="短名(≤17 字节)")
    parser.add_argument("--long-name", default="Art-Net Studio simulated node", help="长名")
    parser.add_argument("--output", default="", help="输出口的 Port-Address 范围,如 0-3,16")
    parser.add_argument("--sacn-output", default="", help="按 sACN 接收的输出口 Port-Address 范围")
    parser.add_argument("--input", default="", help="输入口的 Port-Address 范围")
    parser.add_argument("--merge", choices=("htp", "ltp"), default="htp", help="输出口合并模式")
    parser.add_argument("--reply-mode", choices=REPLY_MODES, default="auto")
    parser.add_argument("--artnet-port", type=int, default=ARTNET_PORT)
    parser.add_argument("--sacn-port", type=int, default=SACN_PORT)
    parser.add_argument("--reply-port", type=int, default=0, help="ArtPollReply 的目标端口")
    parser.add_argument("--duration", type=float, default=0.0, help="运行 N 秒后退出,0 为不限")
    parser.add_argument("--interval", type=float, default=2.0, help="状态输出间隔(秒),0 为不输出")


def _ports(args: argparse.Namespace) -> list[PortConfig]:
    """由命令行范围参数生成端口列表(输出口在前,sACN 输出口随后,输入口最后)。"""
    ports: list[PortConfig] = []
    for spec, direction, protocol in (
        (args.output, "output", "artnet"),
        (args.sacn_output, "output", "sacn"),
        (args.input, "input", "artnet"),
    ):
        if spec:
            for address in parse_ranges(spec, minimum=0, maximum=MAX_PORT_ADDRESS):
                ports.append(
                    PortConfig(
                        direction=direction,
                        address=address,
                        merge_mode=args.merge,
                        protocol=protocol,
                    )
                )
    if not ports:
        raise ValueError("至少需要一个端口:请用 --output / --sacn-output / --input 指定")
    return ports


def _status_table(snapshot: dict) -> str:
    """把管理器快照格式化成文本。"""
    lines = []
    for node in snapshot["nodes"]:
        state = "在线" if node["online"] else "离线"
        lines.append(f"节点 {node['id']}  {node['ip']}  {node['short_name']}  [{state}]")
        lines.append("  PORT  DIR     ADDR   MODE    ACT  MRG   PKTS  SOURCES")
        for p in node["ports"]:
            address = p["in_address"] if p["direction"] == "input" else p["out_address"]
            sources = ", ".join(
                s["ip"] if "cid" not in s else f"{s['name']}(P{s['priority']})"
                for s in p["sources"]
            )
            lines.append(
                f"  {p['index'] + 1:>4}  {p['direction']:<6} {address:>5}   "
                f"{p['protocol']:<6}  {'Y' if p['active'] else '-':<3}  "
                f"{'Y' if p['merging'] else '-':<3}  {p['packets']:>5}  {sources}"
            )
    return "\n".join(lines)


def run(args: argparse.Namespace) -> int:
    """执行 ``node``。

    Args:
        args: 解析后的命令行参数。

    Returns:
        进程退出码:0 成功,2 参数错误,1 运行时错误。
    """
    iface: NetInterface | None
    try:
        iface = find_interface(args.interface) if args.interface else default_interface()
        ports = _ports(args)
        ip = auto_node_ip(args.artnet_port, iface) if args.ip == "auto" else args.ip
        config = NodeConfig(
            id="cli-node",
            ip=ip,
            short_name=args.name,
            long_name=args.long_name,
            ports=ports,
        )
        config.validate()
    except (ValueError, LookupError) as exc:
        print(f"参数错误: {exc}", file=sys.stderr)
        return 2

    manager = NodeManager(
        interface=iface,
        artnet_port=args.artnet_port,
        sacn_port=args.sacn_port,
        reply_port=args.reply_port or None,
        reply_mode=args.reply_mode,
    )
    try:
        started = manager.start()
        node, warnings = manager.add_node(config)
    except ValueError as exc:
        manager.stop()
        print(f"参数错误: {exc}", file=sys.stderr)
        return 2
    except OSError as exc:
        manager.stop()
        print(f"网络错误: {exc}", file=sys.stderr)
        return 1

    for text in [*started.warnings, *warnings]:
        print(f"提示: {text}", file=sys.stderr)
    binds = len(node.binds)
    print(
        f"虚拟节点已启动: {config.ip}:{args.artnet_port}  端口 {len(ports)} 个 / Bind {binds} 个;"
        "Ctrl+C 退出",
        file=sys.stderr,
    )
    deadline = time.perf_counter() + args.duration if args.duration > 0 else None
    done = threading.Event()
    try:
        while not done.is_set():
            wait = args.interval if args.interval > 0 else 0.2
            if deadline is not None:
                remaining = deadline - time.perf_counter()
                if remaining <= 0:
                    break
                wait = min(wait, remaining)
            done.wait(wait)
            if args.interval > 0 and not (deadline is not None and time.perf_counter() >= deadline):
                print(_status_table(manager.snapshot()))
                print()
    except KeyboardInterrupt:
        pass
    finally:
        final = manager.snapshot()
        manager.stop()
    print(_status_table(final))
    return 0
