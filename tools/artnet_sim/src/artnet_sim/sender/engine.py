"""发送引擎:管理信号源、发送 socket 与调度线程。"""

from __future__ import annotations

import contextlib
import logging
import socket
import threading
from collections.abc import Callable

from artnet_sim.net.interfaces import NetInterface, default_interface, find_interface
from artnet_sim.net.scheduler import Scheduler
from artnet_sim.net.sockets import create_send_socket
from artnet_sim.net.targets import default_port, resolve_target
from artnet_sim.sender.source import Source, SourceConfig

logger = logging.getLogger(__name__)

#: 网卡解析函数:传入用户指定的名称/IP(或 ``None``),返回网卡或 ``None``。
InterfaceResolver = Callable[[str | None], NetInterface | None]


def resolve_interface(spec: str | None) -> NetInterface | None:
    """默认的网卡解析:指定则查找,否则自动挑选。

    Args:
        spec: 网卡名称或 IP;``None`` 表示自动选择。

    Returns:
        网卡;自动选择找不到时返回 ``None``。

    Raises:
        LookupError: 指定的网卡不存在或名称不唯一。
    """
    return find_interface(spec) if spec else default_interface()


class SocketTransport:
    """把 UDP socket 包装成 :class:`~artnet_sim.sender.source.Transport`。

    发送失败(例如网卡断开)只计数并记录最后一次错误,不抛异常,免得打断调度线程。

    Args:
        sock: 已配置好的发送 socket。
    """

    def __init__(self, sock: socket.socket) -> None:
        self._sock = sock
        self.errors = 0
        self.last_error: str | None = None

    def send(self, packet: bytes, dest: tuple[str, int]) -> bool:
        """发送一个数据报。

        Args:
            packet: 数据报内容。
            dest: 目标 ``(IP, 端口)``。

        Returns:
            发送成功返回 ``True``。
        """
        try:
            self._sock.sendto(packet, dest)
        except OSError as exc:
            self.errors += 1
            self.last_error = str(exc)
            return False
        return True

    def close(self) -> None:
        """关闭 socket。"""
        with contextlib.suppress(OSError):
            self._sock.close()


class SendEngine:
    """发送引擎。

    Args:
        scheduler: 调度器;默认新建一个使用真实时钟的调度器。
        resolver: 网卡解析函数,默认 :func:`resolve_interface`。
        socket_factory: 按绑定 IP 创建发送 socket 的函数,测试可替换。
    """

    def __init__(
        self,
        scheduler: Scheduler | None = None,
        resolver: InterfaceResolver = resolve_interface,
        socket_factory: Callable[[str | None], socket.socket] = create_send_socket,
    ) -> None:
        self.scheduler = scheduler or Scheduler()
        self._resolver = resolver
        self._socket_factory = socket_factory
        self._lock = threading.RLock()
        self._sources: dict[str, Source] = {}
        self._transports: dict[str | None, SocketTransport] = {}

    def start(self) -> None:
        """启动调度线程。"""
        self.scheduler.start()

    def stop(self) -> None:
        """停止所有信号源(sACN 会发送 Stream_Terminated)、调度线程并关闭 socket。"""
        self.scheduler.stop()
        with self._lock:
            for source in self._sources.values():
                source.stop(terminate=True)
            self._sources.clear()
            for transport in self._transports.values():
                transport.close()
            self._transports.clear()

    def _transport_for(self, bind_ip: str | None) -> SocketTransport:
        """取得(必要时创建)绑定到 ``bind_ip`` 的共享发送通道。"""
        transport = self._transports.get(bind_ip)
        if transport is None:
            transport = SocketTransport(self._socket_factory(bind_ip))
            self._transports[bind_ip] = transport
        return transport

    def add_source(self, config: SourceConfig) -> Source:
        """创建信号源并加入调度。

        Args:
            config: 信号源配置。

        Returns:
            已开始调度的信号源。

        Raises:
            ValueError: 配置不合法、id 重复,或目标地址被策略拒绝。
            LookupError: 指定的网卡不存在。
            OSError: 创建发送 socket 失败。
        """
        config.validate()
        with self._lock:
            if config.id in self._sources:
                raise ValueError(f"信号源 id 已存在: {config.id}")
            iface = self._resolver(config.interface)
            port = config.port or default_port(config.protocol)
            destinations = {
                u: (
                    resolve_target(
                        config.protocol,
                        u,
                        config.target,
                        iface,
                        allow_public=config.allow_public,
                    ),
                    port,
                )
                for u in config.universes
            }
            # 发往环回地址时不能绑定到物理网卡 IP,否则 Windows 会报 WSAEADDRNOTAVAIL。
            all_loopback = all(ip.startswith("127.") for ip, _ in destinations.values())
            bind_ip = (
                iface.ip
                if iface is not None and not iface.is_loopback and not all_loopback
                else None
            )
            source = Source(config, self._transport_for(bind_ip), destinations)
            self._sources[config.id] = source
        self.scheduler.add(source)
        return source

    def remove_source(self, source_id: str, terminate: bool = True) -> bool:
        """停止并移除一个信号源。

        Args:
            source_id: 信号源 id。
            terminate: sACN 是否发送 Stream_Terminated。

        Returns:
            信号源存在并已移除返回 ``True``。
        """
        with self._lock:
            source = self._sources.pop(source_id, None)
        if source is None:
            return False
        self.scheduler.remove(source)
        source.stop(terminate=terminate)
        return True

    def get(self, source_id: str) -> Source | None:
        """按 id 取信号源。

        Args:
            source_id: 信号源 id。

        Returns:
            信号源;不存在返回 ``None``。
        """
        with self._lock:
            return self._sources.get(source_id)

    def sources(self) -> list[Source]:
        """返回全部信号源的快照列表。"""
        with self._lock:
            return list(self._sources.values())
