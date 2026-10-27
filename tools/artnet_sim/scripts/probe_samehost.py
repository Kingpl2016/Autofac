"""同机共绑端口探测:验证两个设置了 SO_REUSEADDR 的接收者同时绑定同一端口时,
单播、广播、组播分别会送给谁。

用法::

    python scripts/probe_samehost.py [--interface <名称或IP>]

使用非标准端口(默认 46454),不会影响正在运行的 Art-Net Studio。
"""

from __future__ import annotations

import argparse
import socket
import sys
import time

from artnet_sim.net.interfaces import default_interface, find_interface
from artnet_sim.net.sockets import create_recv_socket, create_send_socket, join_multicast


def drain(sock: socket.socket, wait: float = 0.3) -> int:
    """在 ``wait`` 秒内读取并统计 socket 收到的数据报数量。"""
    sock.settimeout(0.05)
    deadline = time.monotonic() + wait
    count = 0
    while time.monotonic() < deadline:
        try:
            sock.recvfrom(2048)
            count += 1
        except (TimeoutError, ConnectionResetError):
            continue
    return count


def probe(
    label: str, dest: tuple[str, int], a: socket.socket, b: socket.socket, iface: str
) -> None:
    """向 ``dest`` 发一个包,打印 A、B 各自收到几个。"""
    # 发往环回地址时不能绑定到物理网卡 IP,否则 Windows 会报 WSAEADDRNOTAVAIL。
    tx = create_send_socket(None if dest[0].startswith("127.") else iface)
    try:
        tx.sendto(b"probe", dest)
    finally:
        tx.close()
    print(f"  {label:<28} -> A 收到 {drain(a)}  B 收到 {drain(b)}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--interface", help="网卡名称或 IP,默认自动选择")
    parser.add_argument("--port", type=int, default=46454)
    args = parser.parse_args()

    iface = find_interface(args.interface) if args.interface else default_interface()
    if iface is None:
        print("找不到可用网卡", file=sys.stderr)
        return 1
    print(f"网卡: {iface.label()}")

    a = create_recv_socket(args.port)
    b = create_recv_socket(args.port)
    group = "239.255.0.1"
    join_multicast(a, group, iface.ip)
    join_multicast(b, group, iface.ip)
    print(f"A、B 均绑定 0.0.0.0:{args.port}(SO_REUSEADDR),均已加入 {group}")
    probe("单播到本机网卡 IP", (iface.ip, args.port), a, b, iface.ip)
    probe("单播到 127.0.0.1", ("127.0.0.1", args.port), a, b, iface.ip)
    probe("定向广播", (iface.broadcast, args.port), a, b, iface.ip)
    probe("受限广播 255.255.255.255", ("255.255.255.255", args.port), a, b, iface.ip)
    probe("组播 239.255.0.1", (group, args.port), a, b, iface.ip)
    a.close()
    b.close()

    # 一个绑定 0.0.0.0,另一个绑定具体回环别名 127.0.0.2。
    wildcard = create_recv_socket(args.port)
    alias = create_recv_socket(args.port, bind_ip="127.0.0.2")
    print(f"\nA 绑定 0.0.0.0:{args.port},B 绑定 127.0.0.2:{args.port}")
    probe("单播到 127.0.0.2", ("127.0.0.2", args.port), wildcard, alias, iface.ip)
    probe("单播到 127.0.0.1", ("127.0.0.1", args.port), wildcard, alias, iface.ip)
    wildcard.close()
    alias.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
