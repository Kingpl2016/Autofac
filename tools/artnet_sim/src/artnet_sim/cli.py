"""命令行入口。"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence

from artnet_sim import __version__
from artnet_sim.commands import artrec as artrec_command
from artnet_sim.commands import listen as listen_command
from artnet_sim.commands import node as node_command
from artnet_sim.commands import scenario as scenario_command
from artnet_sim.commands import send as send_command
from artnet_sim.commands import serve as serve_command
from artnet_sim.net.interfaces import (
    NetInterface,
    default_interface,
    find_interface,
    list_interfaces,
)
from artnet_sim.protocol.decode import decode


def _parse_hex(text: str) -> bytes:
    """把十六进制文本解析为字节,容忍空白、``0x`` 前缀与逗号。

    Args:
        text: 十六进制文本,如 ``"41 72 74"`` 或 ``"0x41,0x72"``。

    Returns:
        解析出的字节。

    Raises:
        ValueError: 文本不是合法的十六进制。
    """
    cleaned = text.replace("0x", "").replace("0X", "")
    for ch in " ,\t\r\n:-":
        cleaned = cleaned.replace(ch, "")
    return bytes.fromhex(cleaned)


def _pick_interface(spec: str | None) -> NetInterface | None:
    """按用户参数选择网卡;未指定时自动挑选默认网卡。"""
    if spec:
        return find_interface(spec)
    return default_interface()


def _cmd_inspect(args: argparse.Namespace) -> int:
    """``inspect`` 子命令:解码十六进制报文并打印字段。"""
    try:
        buf = _parse_hex(args.hex)
    except ValueError as exc:
        print(f"十六进制解析失败: {exc}", file=sys.stderr)
        return 2
    result = decode(buf)
    print(f"协议: {result.protocol}    类型: {result.kind}    长度: {len(buf)} 字节")
    width = max((len(name) for name, _ in result.fields), default=0)
    for name, value in result.fields:
        print(f"  {name.ljust(width)}  {value}")
    return 0


def _cmd_interfaces(_args: argparse.Namespace) -> int:
    """``interfaces`` 子命令:列出本机 IPv4 网卡。"""
    chosen = default_interface()
    for item in list_interfaces():
        mark = "*" if chosen is not None and item.ip == chosen.ip else " "
        print(f"{mark} {item.label()}")
    print("\n* 为默认选择;可用 --interface 指定名称或 IP。")
    return 0


def _cmd_send(args: argparse.Namespace) -> int:
    """``send`` 子命令。"""
    return send_command.run(args)


def _cmd_listen(args: argparse.Namespace) -> int:
    """``listen`` 子命令。"""
    return listen_command.run(args)


def _cmd_node(args: argparse.Namespace) -> int:
    """``node`` 子命令。"""
    return node_command.run(args)


def _cmd_scenario(args: argparse.Namespace) -> int:
    """``scenario`` 子命令。"""
    return scenario_command.run(args)


def _cmd_artrec(args: argparse.Namespace) -> int:
    """``artrec`` 子命令。"""
    return artrec_command.run(args)


def _cmd_serve(args: argparse.Namespace) -> int:
    """``serve`` 子命令。"""
    return serve_command.run(args)


def build_parser() -> argparse.ArgumentParser:
    """构造命令行解析器。

    Returns:
        配置好子命令的 ``ArgumentParser``。
    """
    parser = argparse.ArgumentParser(prog="artnet-sim", description="Art-Net / sACN 模拟工具")
    parser.add_argument("--version", action="version", version=f"artnet-sim {__version__}")
    sub = parser.add_subparsers(dest="command", metavar="<命令>")

    p_inspect = sub.add_parser("inspect", help="解码十六进制报文")
    p_inspect.add_argument("hex", help='十六进制报文,如 "41 72 74 2d 4e 65 74 00 ..."')
    p_inspect.set_defaults(func=_cmd_inspect)

    p_if = sub.add_parser("interfaces", help="列出本机 IPv4 网卡")
    p_if.set_defaults(func=_cmd_interfaces)

    p_send = sub.add_parser("send", help="用生成器发送 Art-Net / sACN")
    send_command.add_arguments(p_send)
    p_send.set_defaults(func=_cmd_send)

    p_listen = sub.add_parser("listen", help="监听并打印收到的 Art-Net / sACN 包")
    listen_command.add_arguments(p_listen)
    p_listen.set_defaults(func=_cmd_listen)

    p_node = sub.add_parser("node", help="运行虚拟 Art-Net 节点(响应 ArtPoll、接收并合并数据)")
    node_command.add_arguments(p_node)
    p_node.set_defaults(func=_cmd_node)

    p_scenario = sub.add_parser("scenario", help="列出、校验、运行 YAML 场景")
    scenario_command.add_arguments(p_scenario)
    p_scenario.set_defaults(func=_cmd_scenario)

    p_artrec = sub.add_parser("artrec", help="查看、回放、录制 .artrec 节目文件")
    artrec_command.add_arguments(p_artrec)
    p_artrec.set_defaults(func=_cmd_artrec)

    p_serve = sub.add_parser("serve", help="启动 Web 界面")
    serve_command.add_arguments(p_serve)
    p_serve.set_defaults(func=_cmd_serve)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """程序入口。

    Args:
        argv: 命令行参数;为 ``None`` 时读取 ``sys.argv``。

    Returns:
        进程退出码。
    """
    parser = build_parser()
    args = parser.parse_args(argv)
    func = getattr(args, "func", None)
    if func is None:
        parser.print_help()
        return 0
    return int(func(args))


if __name__ == "__main__":
    raise SystemExit(main())
