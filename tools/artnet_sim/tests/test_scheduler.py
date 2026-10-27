import threading
import time

from artnet_sim.net.clock import FakeClock, RealClock
from artnet_sim.net.scheduler import Scheduler


class Ticker:
    def __init__(self, interval, jitter=0.0, boom=False):
        self._interval = interval
        self._jitter = jitter
        self.boom = boom
        self.fired: list[float] = []

    @property
    def interval(self):
        return self._interval

    @interval.setter
    def interval(self, value):
        self._interval = value

    def fire(self, now):
        self.fired.append(now)
        if self.boom:
            raise RuntimeError("boom")

    def jitter(self):
        return self._jitter


def make():
    clock = FakeClock()
    return clock, Scheduler(clock, boost_priority=False)


def advance_and_run(clock, sched, seconds, step=0.001):
    end = clock.now() + seconds
    while clock.now() < end:
        clock.advance(step)
        sched.run_pending()


def test_fires_on_a_regular_grid():
    clock, sched = make()
    t = Ticker(0.1)
    sched.add(t)
    sched.run_pending()
    advance_and_run(clock, sched, 0.55)
    assert len(t.fired) == 6  # 0.0, 0.1, ... 0.5
    gaps = [b - a for a, b in zip(t.fired, t.fired[1:], strict=False)]
    assert all(abs(g - 0.1) < 0.0015 for g in gaps)


def test_start_at_delays_first_fire():
    clock, sched = make()
    t = Ticker(0.1)
    sched.add(t, start_at=0.5)
    advance_and_run(clock, sched, 0.4)
    assert t.fired == []
    advance_and_run(clock, sched, 0.2)
    assert len(t.fired) >= 1 and t.fired[0] >= 0.5


def test_remove_stops_firing():
    clock, sched = make()
    t = Ticker(0.1)
    sched.add(t)
    sched.run_pending()
    assert sched.remove(t) is True
    assert sched.remove(t) is False
    advance_and_run(clock, sched, 1.0)
    assert len(t.fired) == 1
    assert sched.task_count() == 0


def test_stall_skips_missed_frames_instead_of_bursting():
    clock, sched = make()
    t = Ticker(0.1)
    sched.add(t)
    sched.run_pending()
    clock.advance(1.05)  # 一次长卡顿
    sched.run_pending()
    assert len(t.fired) == 2  # 只补一次,不会连发 10 次
    stats = sched.stats()
    assert stats.skipped == 9
    clock.advance(0.1)
    sched.run_pending()
    assert len(t.fired) == 3  # 相位保持在 0.1 的网格上


def test_jitter_shifts_due_without_accumulating():
    clock, sched = make()
    t = Ticker(0.1, jitter=0.03)
    sched.add(t)
    sched.run_pending()
    advance_and_run(clock, sched, 0.2)
    assert len(t.fired) == 2
    assert 0.12 <= t.fired[1] <= 0.14  # 标称 0.1 + 抖动 0.03
    advance_and_run(clock, sched, 0.1)
    assert len(t.fired) == 3
    assert 0.22 <= t.fired[2] <= 0.24  # 标称 0.2 + 0.03,没有累积到 0.26


def test_interval_change_applies_on_next_reschedule():
    clock, sched = make()
    t = Ticker(0.1)
    sched.add(t)
    sched.run_pending()
    advance_and_run(clock, sched, 0.11)
    t.interval = 0.5
    advance_and_run(clock, sched, 0.1)
    advance_and_run(clock, sched, 0.6)
    assert len(t.fired) <= 4


def test_task_exception_does_not_stop_scheduler():
    clock, sched = make()
    bad = Ticker(0.1, boom=True)
    good = Ticker(0.1)
    sched.add(bad)
    sched.add(good)
    sched.run_pending()
    advance_and_run(clock, sched, 0.25)
    assert len(good.fired) == 3
    assert sched.stats().errors == 3


def test_re_adding_replaces_schedule():
    clock, sched = make()
    t = Ticker(0.1)
    sched.add(t)
    sched.add(t)
    sched.run_pending()
    assert len(t.fired) == 1
    assert sched.task_count() == 1


def test_stats_percentiles():
    clock, sched = make()
    t = Ticker(0.1)
    sched.add(t)
    sched.run_pending()
    for _ in range(5):
        clock.advance(0.1 + 0.002)  # 每次晚 2ms 才被处理
        sched.run_pending()
    stats = sched.stats()
    assert stats.fired == 6
    assert stats.samples == 6
    assert stats.late_max >= 0.0015


def test_real_thread_runs_and_stops():
    sched = Scheduler(RealClock(), boost_priority=False)
    t = Ticker(0.02)
    sched.add(t)
    sched.start()
    time.sleep(0.35)
    sched.stop()
    count = len(t.fired)
    assert 12 <= count <= 19, count
    time.sleep(0.1)
    assert len(t.fired) == count  # 停止之后不再触发


def test_real_thread_picks_up_tasks_added_while_running():
    sched = Scheduler(RealClock(), boost_priority=False)
    sched.start()
    try:
        time.sleep(0.05)
        t = Ticker(0.02)
        sched.add(t)
        deadline = time.monotonic() + 1.0
        while len(t.fired) < 3 and time.monotonic() < deadline:
            time.sleep(0.01)
        assert len(t.fired) >= 3
        sched.remove(t)
        n = len(t.fired)
        time.sleep(0.1)
        assert len(t.fired) <= n + 1
    finally:
        sched.stop()


def test_clocks_basic_behaviour():
    fake = FakeClock(10.0)
    fake.sleep(1.0)
    fake.sleep(-5.0)
    assert fake.now() == 11.0
    fake.spin_until(11.5)
    fake.spin_until(11.0)
    assert fake.now() == 11.5
    real = RealClock()
    a = real.now()
    real.spin_until(a + 0.002)
    assert real.now() >= a + 0.002
    done = threading.Event()
    threading.Thread(target=lambda: (real.sleep(0.01), done.set())).start()
    assert done.wait(1)
