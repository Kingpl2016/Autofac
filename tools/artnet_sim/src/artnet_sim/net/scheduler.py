"""高精度周期调度器:一个线程驱动所有发送任务。

所有任务放进一个最小堆,线程按最早到期的任务休眠:离到期还远时用 ``clock.sleep``
分段休眠(每段不超过 ``max_sleep``,以便及时响应新增/删除任务),临近到期时切换到
``clock.spin_until`` 精确等待。

补帧策略:任务被耽搁超过一个周期时**丢弃错过的帧**而不是突发补发,保持相位向前走,
并把丢掉的帧数计入 ``skipped``。这样一次长时间卡顿不会在恢复后把网络冲垮。
"""

from __future__ import annotations

import heapq
import itertools
import logging
import sys
import threading
from collections import deque
from dataclasses import dataclass
from typing import Protocol

from artnet_sim.net.clock import Clock, RealClock

logger = logging.getLogger(__name__)


class ScheduledTask(Protocol):
    """可被调度的任务。"""

    @property
    def interval(self) -> float:
        """触发周期(秒),每次重新排程时读取,所以可以在运行中改变。"""
        ...

    def fire(self, now: float) -> None:
        """执行一次。

        Args:
            now: 触发时的时钟读数。
        """
        ...

    def jitter(self) -> float:
        """下一次触发在标称时刻之外额外推迟的秒数(≥ 0),不累积进周期。"""
        ...


@dataclass(frozen=True, slots=True)
class SchedulerStats:
    """调度器的运行统计。

    Attributes:
        fired: 已触发次数。
        skipped: 因耽搁而丢弃的帧数。
        errors: 任务抛出异常的次数。
        late_p50: 触发迟到时间的中位数(秒)。
        late_p99: 触发迟到时间的 99 分位(秒)。
        late_max: 触发迟到时间的最大值(秒)。
        samples: 参与统计的样本数。
    """

    fired: int
    skipped: int
    errors: int
    late_p50: float
    late_p99: float
    late_max: float
    samples: int


class _Entry:
    """堆里的一项。"""

    __slots__ = ("cancelled", "due", "nominal", "order", "task")

    def __init__(self, nominal: float, due: float, order: int, task: ScheduledTask) -> None:
        self.nominal = nominal
        self.due = due
        self.order = order
        self.task = task
        self.cancelled = False

    def __lt__(self, other: _Entry) -> bool:
        return (self.due, self.order) < (other.due, other.order)


def _boost_current_thread() -> None:
    """尽力把当前线程优先级提到略高于普通(仅 Windows),失败则忽略。"""
    if sys.platform != "win32":
        return
    try:
        import ctypes

        kernel32 = ctypes.WinDLL("kernel32")  # type: ignore[attr-defined]
        kernel32.GetCurrentThread.restype = ctypes.c_void_p
        kernel32.SetThreadPriority.argtypes = [ctypes.c_void_p, ctypes.c_int]
        kernel32.SetThreadPriority(kernel32.GetCurrentThread(), 1)  # THREAD_PRIORITY_ABOVE_NORMAL
    except (OSError, AttributeError):
        pass


class Scheduler:
    """周期任务调度器。

    Args:
        clock: 时钟;默认真实时钟。
        spin_margin: 距到期不足这么多秒时改为自旋等待。
        max_sleep: 单次休眠的上限秒数,决定新增任务的响应延迟。
        history: 保留多少个最近的迟到样本用于统计。
        boost_priority: 是否尝试提升调度线程优先级。
    """

    def __init__(
        self,
        clock: Clock | None = None,
        *,
        spin_margin: float = 0.001,
        max_sleep: float = 0.005,
        history: int = 4096,
        boost_priority: bool = True,
    ) -> None:
        self._clock: Clock = clock or RealClock()
        self._spin_margin = spin_margin
        self._max_sleep = max_sleep
        self._boost = boost_priority
        self._heap: list[_Entry] = []
        self._entries: dict[int, _Entry] = {}
        self._counter = itertools.count()
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._lateness: deque[float] = deque(maxlen=history)
        self._fired = 0
        self._skipped = 0
        self._errors = 0

    @property
    def clock(self) -> Clock:
        """调度器使用的时钟。"""
        return self._clock

    def add(self, task: ScheduledTask, start_at: float | None = None) -> None:
        """加入一个任务。

        Args:
            task: 要调度的任务;同一个任务重复加入会先移除旧的排程。
            start_at: 首次触发时刻;为 ``None`` 时立即触发。
        """
        now = self._clock.now()
        nominal = now if start_at is None else start_at
        with self._lock:
            old = self._entries.pop(id(task), None)
            if old is not None:
                old.cancelled = True
            entry = _Entry(nominal, nominal, next(self._counter), task)
            self._entries[id(task)] = entry
            heapq.heappush(self._heap, entry)

    def remove(self, task: ScheduledTask) -> bool:
        """移除一个任务。

        Args:
            task: 要移除的任务。

        Returns:
            任务原本在调度器里返回 ``True``。
        """
        with self._lock:
            entry = self._entries.pop(id(task), None)
            if entry is None:
                return False
            entry.cancelled = True
            return True

    def task_count(self) -> int:
        """当前被调度的任务数。"""
        with self._lock:
            return len(self._entries)

    def _peek(self) -> _Entry | None:
        """取出最早到期的有效项(不弹出),顺带清理已取消的项。"""
        with self._lock:
            while self._heap and self._heap[0].cancelled:
                heapq.heappop(self._heap)
            return self._heap[0] if self._heap else None

    def _pop_if_head(self, entry: _Entry) -> bool:
        """若 ``entry`` 仍是堆顶且有效则弹出。"""
        with self._lock:
            if self._heap and self._heap[0] is entry and not entry.cancelled:
                heapq.heappop(self._heap)
                return True
            return False

    def _fire(self, entry: _Entry) -> None:
        """执行到期的项并重新排程。"""
        task = entry.task
        before = self._clock.now()
        lateness = max(0.0, before - entry.due)
        try:
            task.fire(before)
        except Exception:
            self._errors += 1
            logger.exception("调度任务抛出异常,已忽略")
        self._fired += 1
        self._lateness.append(lateness)

        after = self._clock.now()
        interval = max(task.interval, 1e-4)
        nominal = entry.nominal + interval
        if nominal < after:
            missed = int((after - nominal) / interval) + 1
            nominal += missed * interval
            self._skipped += missed
        try:
            jitter = max(0.0, task.jitter())
        except Exception:
            jitter = 0.0
        with self._lock:
            if entry.cancelled or self._entries.get(id(task)) is not entry:
                return
            entry.nominal = nominal
            entry.due = nominal + jitter
            entry.order = next(self._counter)
            heapq.heappush(self._heap, entry)

    def run_pending(self) -> int:
        """触发所有已到期的任务(不休眠),供测试配合假时钟使用。

        Returns:
            本次触发的任务次数。
        """
        count = 0
        while True:
            entry = self._peek()
            if entry is None or entry.due > self._clock.now():
                return count
            if self._pop_if_head(entry):
                self._fire(entry)
                count += 1

    def start(self) -> None:
        """启动调度线程。"""
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="send-scheduler", daemon=True)
        self._thread.start()

    def stop(self, timeout: float = 2.0) -> None:
        """停止调度线程。

        Args:
            timeout: 等待线程退出的最长秒数。
        """
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout)
            self._thread = None

    def _run(self) -> None:
        """线程主体。"""
        if self._boost:
            _boost_current_thread()
        clock = self._clock
        while not self._stop.is_set():
            entry = self._peek()
            if entry is None:
                clock.sleep(self._max_sleep)
                continue
            delay = entry.due - clock.now()
            if delay > self._spin_margin:
                clock.sleep(min(delay - self._spin_margin, self._max_sleep))
                continue
            clock.spin_until(entry.due)
            if self._pop_if_head(entry):
                self._fire(entry)

    def stats(self) -> SchedulerStats:
        """返回当前统计快照。

        Returns:
            迟到时间的分位数与计数。
        """
        samples = sorted(self._lateness)
        n = len(samples)
        if n:
            p50 = samples[n // 2]
            p99 = samples[min(n - 1, int(n * 0.99))]
            peak = samples[-1]
        else:
            p50 = p99 = peak = 0.0
        return SchedulerStats(self._fired, self._skipped, self._errors, p50, p99, peak, n)
