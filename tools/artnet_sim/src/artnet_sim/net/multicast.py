"""sACN 组播订阅管理:在一个接收 socket 上按需加入/退出各 Universe 的组播组。"""

from __future__ import annotations

import logging
import socket
import threading
from collections.abc import Iterable, Sequence

from artnet_sim.net.sockets import JoinReport, join_multicast, leave_multicast
from artnet_sim.protocol.common import sacn_multicast_addr

logger = logging.getLogger(__name__)


class SacnSubscriptions:
    """在一个 sACN 接收 socket 上维护组播订阅。

    订阅是按(网卡, Universe)成对记录的,所以可以精确退出之前加入过的组。

    Args:
        sock: 已绑定 sACN 端口(``0.0.0.0``)的接收 socket。
        interface_ips: 加入组播所用的本地网卡 IPv4 列表。
    """

    def __init__(self, sock: socket.socket, interface_ips: Sequence[str]) -> None:
        self._sock = sock
        self._interfaces = list(interface_ips)
        self._joined: set[tuple[str, int]] = set()
        self._lock = threading.Lock()
        self.last_failures: list[str] = []

    @property
    def universes(self) -> list[int]:
        """当前至少在一块网卡上成功加入组播的 Universe(升序)。"""
        with self._lock:
            return sorted({u for _ip, u in self._joined})

    def set(self, universes: Iterable[int]) -> JoinReport:
        """把订阅调整为恰好 ``universes``:加入新增的、退出多余的。

        Args:
            universes: 目标订阅集合。

        Returns:
            本次**新增**加入的结果(退出不计入失败)。
        """
        report = JoinReport()
        wanted = set(universes)
        with self._lock:
            current = {u for _ip, u in self._joined}
            for universe in current - wanted:
                for ip in self._interfaces:
                    if (ip, universe) in self._joined:
                        try:
                            leave_multicast(self._sock, sacn_multicast_addr(universe), ip)
                        except OSError as exc:
                            logger.warning("退出组播失败 %s / U%d: %s", ip, universe, exc)
                        self._joined.discard((ip, universe))
            for universe in sorted(wanted - current):
                for ip in self._interfaces:
                    try:
                        join_multicast(self._sock, sacn_multicast_addr(universe), ip)
                    except (OSError, ValueError) as exc:
                        report.failed.append(f"{ip} / U{universe}: {exc}")
                    else:
                        self._joined.add((ip, universe))
                        report.joined += 1
            if report.failed:
                self.last_failures = list(report.failed)
        return report

    def clear(self) -> None:
        """忘记全部订阅(socket 关闭时系统会自动退出组播组)。"""
        with self._lock:
            self._joined.clear()
