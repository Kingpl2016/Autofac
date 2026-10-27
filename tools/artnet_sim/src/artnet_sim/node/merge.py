"""输出口的数据合并:Art-Net(最多两个源,HTP/LTP)与 sACN(优先级仲裁)。

时间一律是 ``time.perf_counter_ns()`` 风格的纳秒整数,由调用方传入,方便用假时间测试。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

#: Art-Net 合并最多同时容纳的源数(规范规定为两个,多出的会被忽略)。
ARTNET_MAX_SOURCES = 2

#: sACN 最多同时跟踪的源数。
SACN_MAX_SOURCES = 8

#: sACN 数据丢失超时(秒)。
SACN_LOSS_TIMEOUT_S = 2.5


def htp(frames: list[bytes]) -> bytes:
    """逐通道取最大值,较短的帧按 0 补齐。

    Args:
        frames: 至少一帧。

    Returns:
        长度等于最长帧的合并结果。
    """
    if len(frames) == 1:
        return frames[0]
    width = max(len(f) for f in frames)
    padded = [f.ljust(width, b"\x00") for f in frames]
    return bytes(map(max, *padded))


@dataclass(slots=True)
class _ArtSlot:
    """Art-Net 合并缓冲里的一个源。"""

    ip: str
    physical: int
    data: bytes
    last_ns: int
    packets: int = 0


class ArtnetMerger:
    """一个 Art-Net 输出口的合并器。

    源以 ``(IP, Physical)`` 区分。同一 Port-Address 下出现第二个源就进入合并状态;
    第三个源会被忽略。某个源停发后在缓冲里保留 ``hold_s`` 秒,期间它回来就继续合并,
    否则退出合并。两个源都停了,输出保持最后一次的合并结果。

    Args:
        mode: ``htp`` 或 ``ltp``。LTP 取最后到达的那一帧。
        hold_s: 失效源的保留时间(秒)。
    """

    def __init__(self, mode: str = "htp", hold_s: float = 10.0) -> None:
        self.mode = mode
        self.hold_s = hold_s
        self._slots: list[_ArtSlot] = []
        self._output = b""
        self._locked_ip: str | None = None
        self._cancel_pending = False
        self.ignored = 0

    @property
    def merging(self) -> bool:
        """当前是否有两个源在合并。"""
        return len(self._slots) >= ARTNET_MAX_SOURCES

    @property
    def output(self) -> bytes:
        """当前输出的通道数据。"""
        return self._output

    def cancel_merge(self) -> None:
        """对应 ArtAddress 的 ``AcCancelMerge``:下一个到达的 ArtDmx 结束合并。

        结束合并的那个源之外的 IP 发来的数据会被丢弃,直到该源停发超过保留时间。
        """
        self._cancel_pending = True

    def feed(self, ip: str, physical: int, data: bytes, t_ns: int) -> bool:
        """喂入一帧 ArtDmx 数据。

        Args:
            ip: 来源 IP。
            physical: 报文里的 Physical 字段。
            data: 通道数据。
            t_ns: 到达时刻(纳秒)。

        Returns:
            数据被接受返回 ``True``;被忽略(第三个源,或被取消合并后锁定的其他 IP)返回 ``False``。
        """
        self._drop_expired(t_ns)
        if self._cancel_pending:
            self._cancel_pending = False
            self._slots.clear()
            self._locked_ip = ip
        elif self._locked_ip is not None and ip != self._locked_ip:
            self.ignored += 1
            return False

        slot = next((s for s in self._slots if s.ip == ip and s.physical == physical), None)
        if slot is None:
            if len(self._slots) >= ARTNET_MAX_SOURCES:
                self.ignored += 1
                return False
            slot = _ArtSlot(ip, physical, data, t_ns)
            self._slots.append(slot)
        slot.data = data
        slot.last_ns = t_ns
        slot.packets += 1
        self._recompute(latest=data)
        return True

    def _drop_expired(self, t_ns: int) -> bool:
        """移除超过保留时间的源;返回是否有变化。"""
        if self.hold_s < 0:
            return False
        limit = int(self.hold_s * 1e9)
        kept = [s for s in self._slots if t_ns - s.last_ns <= limit]
        changed = len(kept) != len(self._slots)
        self._slots = kept
        if self._locked_ip is not None and not any(s.ip == self._locked_ip for s in kept):
            self._locked_ip = None
        return changed

    def expire(self, t_ns: int) -> bool:
        """周期性维护:清理过期源并在必要时重新计算输出。

        Args:
            t_ns: 当前时刻(纳秒)。

        Returns:
            合并状态或输出发生变化返回 ``True``。
        """
        was_merging = self.merging
        before = self._output
        if self._drop_expired(t_ns) and self._slots:
            self._recompute(latest=self._slots[-1].data)
        return was_merging != self.merging or before != self._output

    def _recompute(self, latest: bytes) -> None:
        """按当前源重新计算输出。"""
        if not self._slots:
            return  # 所有源都没了:保持最后的输出
        if len(self._slots) == 1:
            self._output = self._slots[0].data
        elif self.mode == "ltp":
            self._output = latest
        else:
            self._output = htp([s.data for s in self._slots])

    def sources(self, t_ns: int) -> list[dict[str, Any]]:
        """列出当前源,供界面显示。

        Args:
            t_ns: 当前时刻(纳秒)。

        Returns:
            每个源一个字典。
        """
        return [
            {
                "ip": s.ip,
                "physical": s.physical,
                "packets": s.packets,
                "age_ms": round((t_ns - s.last_ns) / 1e6, 1),
            }
            for s in self._slots
        ]


@dataclass(slots=True)
class _SacnSlot:
    """sACN 合并缓冲里的一个源。"""

    cid: str
    ip: str
    name: str
    priority: int
    data: bytes
    last_ns: int
    packets: int = 0


class SacnMerger:
    """一个 sACN 输出口的合并器:最高优先级的源胜出,同优先级的源逐通道取大(HTP)。

    源以 CID 区分。收到 ``Stream_Terminated`` 的源立即移除;超过 2.5 秒没数据的源视为丢失。
    """

    def __init__(self) -> None:
        self._slots: dict[str, _SacnSlot] = {}
        self._output = b""
        self.ignored = 0

    @property
    def output(self) -> bytes:
        """当前输出的通道数据。"""
        return self._output

    @property
    def merging(self) -> bool:
        """是否有多个源在同一优先级上合并。"""
        top = self._top_priority()
        return top is not None and sum(1 for s in self._slots.values() if s.priority == top) > 1

    def _top_priority(self) -> int | None:
        """当前最高优先级;没有源时为 ``None``。"""
        return max((s.priority for s in self._slots.values()), default=None)

    def feed(
        self,
        cid: str,
        ip: str,
        name: str,
        priority: int,
        data: bytes,
        t_ns: int,
        terminated: bool = False,
    ) -> bool:
        """喂入一帧 sACN 数据。

        Args:
            cid: 发送者 CID(十六进制)。
            ip: 来源 IP。
            name: 源名称。
            priority: 优先级。
            data: 通道数据。
            t_ns: 到达时刻(纳秒)。
            terminated: 该帧是否带 Stream_Terminated 标志。

        Returns:
            被接受返回 ``True``;源数量已达上限时返回 ``False``。
        """
        self._drop_expired(t_ns)
        if terminated:
            self._slots.pop(cid, None)
            self._recompute()
            return True
        slot = self._slots.get(cid)
        if slot is None:
            if len(self._slots) >= SACN_MAX_SOURCES:
                self.ignored += 1
                return False
            slot = _SacnSlot(cid, ip, name, priority, data, t_ns)
            self._slots[cid] = slot
        slot.ip, slot.name, slot.priority = ip, name, priority
        slot.data = data
        slot.last_ns = t_ns
        slot.packets += 1
        self._recompute()
        return True

    def _drop_expired(self, t_ns: int) -> bool:
        """移除数据丢失超时的源;返回是否有变化。"""
        limit = int(SACN_LOSS_TIMEOUT_S * 1e9)
        stale = [cid for cid, s in self._slots.items() if t_ns - s.last_ns > limit]
        for cid in stale:
            del self._slots[cid]
        return bool(stale)

    def expire(self, t_ns: int) -> bool:
        """周期性维护。

        Args:
            t_ns: 当前时刻(纳秒)。

        Returns:
            输出发生变化返回 ``True``。
        """
        before = self._output
        if self._drop_expired(t_ns):
            self._recompute()
        return before != self._output

    def _recompute(self) -> None:
        """按优先级仲裁重新计算输出;没有源时保持最后的输出。"""
        top = self._top_priority()
        if top is None:
            return
        self._output = htp([s.data for s in self._slots.values() if s.priority == top])

    def sources(self, t_ns: int) -> list[dict[str, Any]]:
        """列出当前源,供界面显示。

        Args:
            t_ns: 当前时刻(纳秒)。

        Returns:
            每个源一个字典。
        """
        top = self._top_priority()
        return [
            {
                "cid": s.cid,
                "ip": s.ip,
                "name": s.name,
                "priority": s.priority,
                "winning": s.priority == top,
                "packets": s.packets,
                "age_ms": round((t_ns - s.last_ns) / 1e6, 1),
            }
            for s in self._slots.values()
        ]
