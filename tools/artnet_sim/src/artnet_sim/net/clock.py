"""时钟抽象:真实时钟(混合 sleep + 自旋)与可手动推进的假时钟。

Python 3.11 起 Windows 上的 ``time.sleep()`` 使用高精度可等待定时器,不再受默认
15.6ms 系统定时器精度限制。但仍会有几十到几百微秒的唤醒抖动,所以 :class:`RealClock`
先 ``sleep`` 到目标时刻之前一小段(``spin_margin``),剩下的时间用 ``sleep(0)`` 让出
时间片并自旋等待。
"""

from __future__ import annotations

import time
from typing import Protocol


class Clock(Protocol):
    """调度器依赖的时钟接口。"""

    def now(self) -> float:
        """返回当前时刻(秒,单调递增)。"""
        ...

    def sleep(self, seconds: float) -> None:
        """休眠大约 ``seconds`` 秒(可提前返回,不保证精度)。"""
        ...

    def spin_until(self, deadline: float) -> None:
        """精确等待到 ``deadline``(秒)。"""
        ...


class RealClock:
    """基于 ``time.perf_counter`` 的真实时钟。"""

    def now(self) -> float:
        """返回当前 ``perf_counter`` 时刻。"""
        return time.perf_counter()

    def sleep(self, seconds: float) -> None:
        """调用 ``time.sleep``。

        Args:
            seconds: 休眠秒数,小于等于 0 时不休眠。
        """
        if seconds > 0:
            time.sleep(seconds)

    def spin_until(self, deadline: float) -> None:
        """自旋等待到 ``deadline``,每圈 ``sleep(0)`` 让出时间片给其他线程。

        Args:
            deadline: 目标时刻,与 :meth:`now` 同一时间轴。
        """
        while time.perf_counter() < deadline:
            time.sleep(0)


class FakeClock:
    """测试用假时钟:时间只在 ``sleep`` / ``advance`` 时前进。

    Args:
        start: 初始时刻。
    """

    def __init__(self, start: float = 0.0) -> None:
        self._now = start

    def now(self) -> float:
        """返回当前假时间。"""
        return self._now

    def sleep(self, seconds: float) -> None:
        """把假时间向前推进 ``seconds``。

        Args:
            seconds: 推进的秒数,小于 0 时忽略。
        """
        if seconds > 0:
            self._now += seconds

    def spin_until(self, deadline: float) -> None:
        """把假时间推进到 ``deadline``(已经超过则不动)。

        Args:
            deadline: 目标时刻。
        """
        if deadline > self._now:
            self._now = deadline

    def advance(self, seconds: float) -> None:
        """显式推进假时间。

        Args:
            seconds: 推进的秒数。
        """
        self._now += seconds
