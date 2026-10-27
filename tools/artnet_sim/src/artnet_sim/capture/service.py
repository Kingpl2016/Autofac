"""抓包服务:绑定 Art-Net / sACN 接收 socket,把收到的报文交给 :class:`Hub`。"""

from __future__ import annotations

import logging
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field

from artnet_sim.capture.hub import Hub
from artnet_sim.net.multicast import SacnSubscriptions
from artnet_sim.net.receiver import UdpReceiver
from artnet_sim.net.sockets import JoinReport, create_recv_socket, port_in_use
from artnet_sim.protocol.common import ARTNET_PORT, SACN_PORT

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class StartReport:
    """:meth:`CaptureService.start` 的结果。

    Attributes:
        artnet_port_shared: Art-Net 端口在绑定前已被其他进程占用,本服务以地址复用方式
            共同绑定;此时发往本机的单播只会送给先绑定的一方,广播与组播不受影响。
        sacn_port_shared: sACN 端口的同类情况。
        sacn_join: 初始 sACN 组播加入结果。
    """

    artnet_port_shared: bool = False
    sacn_port_shared: bool = False
    sacn_join: JoinReport = field(default_factory=JoinReport)


class CaptureService:
    """抓包服务。

    sACN 的 socket 绑定 ``0.0.0.0``(绑定具体网卡 IP 会收不到组播),组播订阅按
    ``interface_ips`` 逐块网卡加入;因此网卡列表只决定组播订阅,发往本机的单播从任何网卡
    进来都能收到。

    Args:
        hub: 接收到的报文交给它处理。
        artnet: 是否监听 Art-Net。
        sacn: 是否监听 sACN。
        artnet_port: Art-Net 监听端口。
        sacn_port: sACN 监听端口。
        interface_ips: 加入 sACN 组播所用的网卡 IPv4 列表。
        universes: 初始订阅的 sACN Universe。
    """

    def __init__(
        self,
        hub: Hub,
        *,
        artnet: bool = True,
        sacn: bool = True,
        artnet_port: int = ARTNET_PORT,
        sacn_port: int = SACN_PORT,
        interface_ips: Sequence[str] = (),
        universes: Iterable[int] = (),
    ) -> None:
        self._hub = hub
        self._want_artnet = artnet
        self._want_sacn = sacn
        self._artnet_port = artnet_port
        self._sacn_port = sacn_port
        self._interfaces = list(interface_ips)
        self._initial_universes = sorted(set(universes))
        self._receivers: list[UdpReceiver] = []
        self._subscriptions: SacnSubscriptions | None = None
        self.artnet_receiver: UdpReceiver | None = None
        self.sacn_receiver: UdpReceiver | None = None

    @property
    def running(self) -> bool:
        """服务是否已启动。"""
        return bool(self._receivers)

    @property
    def sacn_universes(self) -> list[int]:
        """当前至少在一块网卡上成功加入组播的 sACN Universe(升序)。"""
        return self._subscriptions.universes if self._subscriptions else []

    def start(self) -> StartReport:
        """绑定 socket 并启动接收线程。

        Returns:
            启动结果,含端口是否与其他进程共用、组播加入情况。

        Raises:
            OSError: 绑定失败。已创建的 socket 会被清理。
        """
        report = StartReport()
        try:
            if self._want_artnet:
                report.artnet_port_shared = port_in_use(self._artnet_port)
                sock = create_recv_socket(self._artnet_port, timeout=0.1)
                self.artnet_receiver = UdpReceiver(sock, self._hub.ingest, "rx-artnet")
                self._receivers.append(self.artnet_receiver)
            if self._want_sacn:
                report.sacn_port_shared = port_in_use(self._sacn_port)
                sacn_socket = create_recv_socket(self._sacn_port, timeout=0.1)
                self._subscriptions = SacnSubscriptions(sacn_socket, self._interfaces)
                self.sacn_receiver = UdpReceiver(sacn_socket, self._hub.ingest, "rx-sacn")
                self._receivers.append(self.sacn_receiver)
        except OSError:
            self.stop()
            raise
        for receiver in self._receivers:
            receiver.start()
        if self._want_sacn:
            report.sacn_join = self.set_sacn_universes(self._initial_universes)
        return report

    def stop(self) -> None:
        """停止接收线程并关闭 socket,同时退出所有组播组。"""
        for receiver in self._receivers:
            receiver.request_stop()
        for receiver in self._receivers:
            receiver.stop()
        self._receivers.clear()
        self.artnet_receiver = None
        self.sacn_receiver = None
        if self._subscriptions is not None:
            self._subscriptions.clear()
        self._subscriptions = None

    def set_sacn_universes(self, universes: Iterable[int]) -> JoinReport:
        """把 sACN 组播订阅调整为恰好 ``universes``:加入新增的、退出多余的。

        Args:
            universes: 目标订阅集合。

        Returns:
            本次**新增**加入的结果(退出不计入失败)。
        """
        if self._subscriptions is None:
            return JoinReport()
        return self._subscriptions.set(universes)
