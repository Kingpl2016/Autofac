"""单条数据流的统计:序号缺口、到达间隔、包率。

序号规则:

- sACN:序号 0~255 循环。
- Art-Net:序号 1~255 循环,0 表示发送方未启用序号,此类包只计数、不做缺口分析。

判定规则参照 E1.31 对序号的处理:与上一个有效序号相比,差值(按循环取最近的有符号差)

- 为 0:重复包;
- 为正:按顺序到达,差值大于 1 说明中间丢了 ``差值 - 1`` 个包;
- 在 -19 ~ -1:乱序(迟到)的包,不改变期望序号;若先前把它算成了丢包,则扣回;
- 小于 -19:视为发送方重启或序号复位,重新开始。
"""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass

#: 差值落在 ``[-OUT_OF_ORDER_WINDOW, -1]`` 内视为乱序,更小的视为复位。
OUT_OF_ORDER_WINDOW = 19

# 序号事件。
EVENT_FIRST = "first"
EVENT_OK = "ok"
EVENT_GAP = "gap"
EVENT_DUPLICATE = "duplicate"
EVENT_LATE = "late"
EVENT_RESET = "reset"
EVENT_UNTRACKED = "untracked"


@dataclass(frozen=True, slots=True)
class SeqEvent:
    """一次序号观察的结果。

    Attributes:
        kind: 事件类型,取值见本模块的 ``EVENT_*`` 常量。
        lost: 本次新增判定丢失的包数(仅 ``gap`` 事件非零)。
    """

    kind: str
    lost: int = 0


class SequenceTracker:
    """跟踪一条数据流的序号连续性。

    Args:
        protocol: ``artnet`` 或 ``sacn``,决定序号的循环方式。
    """

    def __init__(self, protocol: str) -> None:
        self._artnet = protocol == "artnet"
        self._last: int | None = None
        self.lost = 0
        self.out_of_order = 0
        self.duplicates = 0
        self.resets = 0
        self.untracked = 0

    def _delta(self, seq: int, last: int) -> int:
        """计算按循环取最近的有符号差值。"""
        if self._artnet:  # 1..255 → 0..254,模 255
            return ((seq - last + 127) % 255) - 127
        return ((seq - last + 128) % 256) - 128

    def observe(self, seq: int) -> SeqEvent:
        """观察一个新到达包的序号并更新计数。

        Args:
            seq: 包里的序号。

        Returns:
            这次观察的判定结果。
        """
        if self._artnet:
            if seq == 0:
                self.untracked += 1
                return SeqEvent(EVENT_UNTRACKED)
            seq -= 1  # 映射到 0..254
        if self._last is None:
            self._last = seq
            return SeqEvent(EVENT_FIRST)
        delta = self._delta(seq, self._last)
        if delta == 0:
            self.duplicates += 1
            return SeqEvent(EVENT_DUPLICATE)
        if delta > 0:
            self._last = seq
            if delta > 1:
                self.lost += delta - 1
                return SeqEvent(EVENT_GAP, delta - 1)
            return SeqEvent(EVENT_OK)
        if delta >= -OUT_OF_ORDER_WINDOW:
            self.out_of_order += 1
            if self.lost > 0:
                self.lost -= 1  # 先前判定为丢失的包其实只是迟到
            return SeqEvent(EVENT_LATE)
        self.resets += 1
        self._last = seq
        return SeqEvent(EVENT_RESET)


class IntervalStats:
    """到达间隔统计:Welford 在线均值/方差 + 最近样本的分位数。

    Args:
        window: 保留多少个最近的样本用于计算分位数。
    """

    def __init__(self, window: int = 512) -> None:
        self._recent: deque[float] = deque(maxlen=window)
        self.count = 0
        self._mean = 0.0
        self._m2 = 0.0
        self.minimum = math.inf
        self.maximum = 0.0

    def add(self, seconds: float) -> None:
        """加入一个到达间隔样本。

        Args:
            seconds: 与上一个包的时间间隔(秒)。
        """
        self._recent.append(seconds)
        self.count += 1
        delta = seconds - self._mean
        self._mean += delta / self.count
        self._m2 += delta * (seconds - self._mean)
        self.minimum = min(self.minimum, seconds)
        self.maximum = max(self.maximum, seconds)

    @property
    def mean(self) -> float:
        """间隔均值(秒);没有样本时为 0。"""
        return self._mean if self.count else 0.0

    @property
    def stddev(self) -> float:
        """间隔标准差(秒),即抖动的常用度量;样本不足 2 个时为 0。"""
        return math.sqrt(self._m2 / (self.count - 1)) if self.count > 1 else 0.0

    def percentile(self, q: float) -> float:
        """最近窗口内的分位数。

        Args:
            q: 分位,0~1。

        Returns:
            分位对应的间隔(秒);没有样本时为 0。
        """
        if not self._recent:
            return 0.0
        ordered = sorted(self._recent)
        return ordered[min(len(ordered) - 1, int(len(ordered) * q))]


class RateMeter:
    """滑动窗口包率计。

    Args:
        window: 窗口长度(秒)。
    """

    def __init__(self, window: float = 1.0) -> None:
        self._window_ns = int(window * 1e9)
        self._times: deque[int] = deque()
        self._bytes: deque[int] = deque()
        self._byte_sum = 0

    def add(self, t_ns: int, size: int) -> None:
        """记录一个包。

        Args:
            t_ns: 到达时刻(纳秒,单调时钟)。
            size: 包字节数。
        """
        self._times.append(t_ns)
        self._bytes.append(size)
        self._byte_sum += size
        self._trim(t_ns)

    def _trim(self, now_ns: int) -> None:
        """丢弃窗口外的记录。"""
        limit = now_ns - self._window_ns
        while self._times and self._times[0] < limit:
            self._times.popleft()
            self._byte_sum -= self._bytes.popleft()

    def rates(self, now_ns: int) -> tuple[float, float]:
        """返回窗口内的(包/秒, 字节/秒)。

        Args:
            now_ns: 当前时刻(纳秒,单调时钟)。

        Returns:
            ``(pps, bytes_per_second)``。
        """
        self._trim(now_ns)
        seconds = self._window_ns / 1e9
        return len(self._times) / seconds, self._byte_sum / seconds
