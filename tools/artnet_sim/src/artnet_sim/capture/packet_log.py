"""包日志:有界环形缓冲,支持过滤与增量查询。"""

from __future__ import annotations

import threading
from collections import deque
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class LoggedPacket:
    """日志里的一条记录。

    Attributes:
        number: 单调递增的序号,从 1 开始,用于增量拉取。
        t_ns: 到达时刻(纳秒,单调时钟)。
        src_ip: 来源 IP。
        src_port: 来源端口。
        protocol: ``artnet`` / ``sacn`` / ``unknown``。
        universe: 数据包的 Universe;非数据包为 ``None``。
        data: 完整的 UDP 载荷。
    """

    number: int
    t_ns: int
    src_ip: str
    src_port: int
    protocol: str
    universe: int | None
    data: bytes


@dataclass(frozen=True, slots=True)
class PacketFilter:
    """包日志过滤条件;为 ``None`` 的字段不参与过滤。

    Attributes:
        src_ip: 只保留这个来源 IP 的包。
        universe: 只保留这个 Universe 的数据包。
        protocol: 只保留这个协议的包。
    """

    src_ip: str | None = None
    universe: int | None = None
    protocol: str | None = None

    def matches(self, packet: LoggedPacket) -> bool:
        """判断一条记录是否满足条件。

        Args:
            packet: 待判断的记录。

        Returns:
            全部条件都满足返回 ``True``。
        """
        if self.src_ip is not None and packet.src_ip != self.src_ip:
            return False
        if self.universe is not None and packet.universe != self.universe:
            return False
        return self.protocol is None or packet.protocol == self.protocol


class PacketLog:
    """线程安全的环形包日志。

    Args:
        capacity: 最多保留多少条,超过后丢弃最旧的。
    """

    def __init__(self, capacity: int = 5000) -> None:
        if capacity < 1:
            raise ValueError("capacity 必须 ≥ 1")
        self._items: deque[LoggedPacket] = deque(maxlen=capacity)
        self._lock = threading.Lock()
        self._counter = 0
        self.paused = False

    @property
    def total(self) -> int:
        """历史上记录过的总条数(含已被挤出缓冲的)。"""
        return self._counter

    def add(
        self,
        t_ns: int,
        addr: tuple[str, int],
        protocol: str,
        universe: int | None,
        data: bytes,
    ) -> int:
        """追加一条记录。暂停状态下不记录。

        Args:
            t_ns: 到达时刻(纳秒)。
            addr: 来源 ``(IP, 端口)``。
            protocol: 协议名。
            universe: 数据包的 Universe,非数据包为 ``None``。
            data: UDP 载荷。

        Returns:
            新记录的序号;暂停时返回 0。
        """
        if self.paused:
            return 0
        with self._lock:
            self._counter += 1
            self._items.append(
                LoggedPacket(self._counter, t_ns, addr[0], addr[1], protocol, universe, data)
            )
            return self._counter

    def query(
        self,
        packet_filter: PacketFilter | None = None,
        *,
        limit: int = 200,
        after: int = 0,
    ) -> list[LoggedPacket]:
        """查询记录。

        Args:
            packet_filter: 过滤条件;``None`` 表示不过滤。
            limit: 最多返回多少条(取符合条件的**最新**的 ``limit`` 条,按时间升序排列)。
            after: 只返回序号大于它的记录,用于增量拉取。

        Returns:
            按序号升序的记录列表。
        """
        with self._lock:
            items = list(self._items)
        selected = [
            p
            for p in items
            if p.number > after and (packet_filter is None or packet_filter.matches(p))
        ]
        return selected[-limit:] if limit > 0 else selected

    def get(self, number: int) -> LoggedPacket | None:
        """按序号取一条记录。

        Args:
            number: 记录序号。

        Returns:
            记录;已被挤出缓冲或不存在返回 ``None``。
        """
        with self._lock:
            if not self._items or number < self._items[0].number or number > self._items[-1].number:
                return None
            # 序号连续,所以下标可以直接算出来。
            item = self._items[number - self._items[0].number]
        return item if item.number == number else None

    def clear(self) -> None:
        """清空缓冲(序号计数不重置,避免增量拉取出现回退)。"""
        with self._lock:
            self._items.clear()
