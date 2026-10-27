"""UDP socket 工厂:发送、接收、组播加入。

选项选择与 Art-Net Studio 的 ``artnet-net`` 保持一致,保证同机运行时行为可预期:

- 接收 socket 一律设置 ``SO_REUSEADDR``。在 Windows 上,双方都设置它才能同时绑定
  同一个端口。
- 接收缓冲请求 4 MiB,承受 256 Universe × 44 Hz(约 1.1 万包/秒)的突发。

同机运行的实测结论(Windows 11,``scripts/probe_samehost.py``):

- 两个都绑定 ``0.0.0.0:端口`` 的 socket:广播(定向与受限)与组播**两边都收到**;
  单播**只给先绑定的那个**。
- 一个绑 ``0.0.0.0``、一个绑具体 IP:单播**总是给绑具体 IP 的那个**,与启动顺序无关;
  广播两边都收到。因此绑定网卡 IP 会抢走发往本机的单播,不适合与 Studio 同机共存。
- 绑定 ``127.0.0.2`` 这样的环回别名:只收发往该别名的单播,不抢 Studio 的流量。
- Windows 不允许绑定到定向广播地址(WSAEADDRNOTAVAIL)。

所以同机模式的做法是:虚拟节点用环回别名收单播,另用通配 socket 只负责收广播,
并且只有在 Studio 已先占住端口时才安全(见 :func:`port_in_use`)。
- 接收 socket 在 Windows 上关闭 ``SIO_UDP_CONNRESET``,否则先前发往关闭端口的包
  产生的 ICMP 不可达会让后续 ``recvfrom`` 抛 ``ConnectionResetError``。
"""

from __future__ import annotations

import contextlib
import socket
import struct
import sys
from collections.abc import Iterable
from dataclasses import dataclass, field

from artnet_sim.protocol.common import sacn_multicast_addr

#: 接收缓冲请求值:4 MiB。
RECV_BUFFER_BYTES = 4 * 1024 * 1024

#: sACN 组播 TTL。规范建议不要被路由器转发太远,20 是常见取值。
SACN_MULTICAST_TTL = 20


def create_send_socket(
    interface_ip: str | None = None,
    *,
    multicast_ttl: int = SACN_MULTICAST_TTL,
    multicast_loop: bool = True,
) -> socket.socket:
    """创建发送用 UDP socket。

    绑定到指定网卡 IP 的任意端口,让包从该网卡发出;同时把组播出口网卡设置为同一块,
    避免 sACN 组播走系统默认路由的网卡(在多网卡/虚拟网卡环境下经常选错)。

    Args:
        interface_ip: 出口网卡的 IPv4;为 ``None`` 时不绑定,由系统路由决定。
        multicast_ttl: 组播 TTL。
        multicast_loop: 是否让本机的接收者也收到自己发的组播(同机测试需要开启)。

    Returns:
        已配置好的 UDP socket。

    Raises:
        OSError: socket 创建、绑定或选项设置失败。
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, multicast_ttl)
        sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_LOOP, 1 if multicast_loop else 0)
        if interface_ip:
            sock.bind((interface_ip, 0))
            sock.setsockopt(
                socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton(interface_ip)
            )
    except OSError:
        sock.close()
        raise
    return sock


def _disable_udp_connreset(sock: socket.socket) -> None:
    """在 Windows 上关闭 ``SIO_UDP_CONNRESET``,失败时静默忽略。

    Python 的 ``socket.ioctl`` 只接受少数几个控制码,不含 ``SIO_UDP_CONNRESET``
    (``0x9800000C``),所以直接调用 ``WSAIoctl``。接收线程本身也会忽略
    ``ConnectionResetError``,这里只是尽量从源头避免它。
    """
    try:
        import ctypes
        from ctypes import wintypes

        ws2 = ctypes.WinDLL("ws2_32")  # type: ignore[attr-defined]
        ws2.WSAIoctl.argtypes = [
            ctypes.c_size_t,
            wintypes.DWORD,
            ctypes.c_void_p,
            wintypes.DWORD,
            ctypes.c_void_p,
            wintypes.DWORD,
            ctypes.POINTER(wintypes.DWORD),
            ctypes.c_void_p,
            ctypes.c_void_p,
        ]
        flag = wintypes.DWORD(0)
        returned = wintypes.DWORD(0)
        ws2.WSAIoctl(
            sock.fileno(),
            0x9800000C,
            ctypes.byref(flag),
            ctypes.sizeof(flag),
            None,
            0,
            ctypes.byref(returned),
            None,
            None,
        )
    except (OSError, AttributeError):
        pass


def create_recv_socket(
    port: int,
    bind_ip: str = "0.0.0.0",
    *,
    timeout: float | None = 0.5,
    rcvbuf: int = RECV_BUFFER_BYTES,
    reuse: bool = True,
) -> socket.socket:
    """创建接收用 UDP socket 并绑定。

    Args:
        port: 绑定端口,``0`` 表示由系统分配。
        bind_ip: 绑定地址。sACN 组播接收必须用 ``0.0.0.0``。
        timeout: ``recvfrom`` 超时(秒),用于让接收线程定期检查停止标志;``None`` 为阻塞。
        rcvbuf: 请求的内核接收缓冲字节数,设置失败不致命。
        reuse: 是否设置 ``SO_REUSEADDR``。

    Returns:
        已绑定的 UDP socket。

    Raises:
        OSError: socket 创建或绑定失败(常见原因:端口已被独占占用)。
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    try:
        if reuse:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        with contextlib.suppress(OSError):  # 失败则沿用系统默认值
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, rcvbuf)
        if sys.platform == "win32":
            _disable_udp_connreset(sock)
        sock.settimeout(timeout)
        sock.bind((bind_ip, port))
    except OSError:
        sock.close()
        raise
    return sock


def port_in_use(port: int, bind_ip: str = "0.0.0.0") -> bool:
    """检查 UDP 端口是否已被其他进程占用。

    以**独占**方式尝试绑定:Windows 上设置 ``SO_EXCLUSIVEADDRUSE``,其他平台不设置
    ``SO_REUSEADDR``。只要对方已绑定(无论对方是否设置了地址复用),本次绑定就会失败。
    绑定成功后立即关闭,不会残留占用。

    Args:
        port: 待检查的 UDP 端口。
        bind_ip: 检查所用的绑定地址。

    Returns:
        端口已被占用返回 ``True``,空闲返回 ``False``。
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    try:
        if sys.platform == "win32":
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)  # type: ignore[attr-defined]
        sock.bind((bind_ip, port))
    except OSError:
        return True
    finally:
        sock.close()
    return False


def _membership(group: str, interface_ip: str) -> bytes:
    """构造 ``IP_ADD_MEMBERSHIP`` / ``IP_DROP_MEMBERSHIP`` 的参数。"""
    return struct.pack("=4s4s", socket.inet_aton(group), socket.inet_aton(interface_ip))


def join_multicast(sock: socket.socket, group: str, interface_ip: str) -> None:
    """让 socket 在指定网卡上加入组播组。

    Args:
        sock: 已绑定的接收 socket。
        group: 组播组 IPv4 地址。
        interface_ip: 加入组播所用的本地网卡 IPv4。

    Raises:
        OSError: 加入失败(网卡不存在、成员数超限等)。
    """
    sock.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, _membership(group, interface_ip))


def leave_multicast(sock: socket.socket, group: str, interface_ip: str) -> None:
    """让 socket 在指定网卡上退出组播组。

    Args:
        sock: 已绑定的接收 socket。
        group: 组播组 IPv4 地址。
        interface_ip: 加入时使用的本地网卡 IPv4。

    Raises:
        OSError: 退出失败(例如从未加入)。
    """
    sock.setsockopt(socket.IPPROTO_IP, socket.IP_DROP_MEMBERSHIP, _membership(group, interface_ip))


@dataclass(slots=True)
class JoinReport:
    """一次批量加入组播的结果。

    Attributes:
        joined: 成功加入的(网卡, Universe)组数。
        failed: 失败项及原因,形如 ``"192.168.1.5 / U3: 错误信息"``。
    """

    joined: int = 0
    failed: list[str] = field(default_factory=list)

    @property
    def attempted(self) -> int:
        """尝试加入的总组数。"""
        return self.joined + len(self.failed)


def join_sacn_universes(
    sock: socket.socket,
    interface_ips: Iterable[str],
    universes: Iterable[int],
) -> JoinReport:
    """在若干网卡上逐个加入 sACN Universe 的组播组。

    单项失败不会中断其余项(Linux 默认单 socket 最多 20 个组播成员,个别网卡可能
    没有组播能力)。

    Args:
        sock: 已绑定 sACN 端口的接收 socket。
        interface_ips: 加入组播所用的本地网卡 IPv4 列表。
        universes: 需要接收的 Universe 列表。

    Returns:
        成功与失败的汇总。
    """
    report = JoinReport()
    universe_list = list(universes)
    for iface in interface_ips:
        for universe in universe_list:
            try:
                join_multicast(sock, sacn_multicast_addr(universe), iface)
            except (OSError, ValueError) as exc:
                report.failed.append(f"{iface} / U{universe}: {exc}")
            else:
                report.joined += 1
    return report
