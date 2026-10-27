import pytest

from artnet_sim.capture import stats as st
from artnet_sim.capture.stats import IntervalStats, RateMeter, SequenceTracker


def feed(tracker, seqs):
    return [tracker.observe(s).kind for s in seqs]


def test_artnet_in_order_and_wrap_skips_zero():
    t = SequenceTracker("artnet")
    kinds = feed(t, [1, 2, 3])
    assert kinds == [st.EVENT_FIRST, st.EVENT_OK, st.EVENT_OK]
    t = SequenceTracker("artnet")
    assert feed(t, [254, 255, 1, 2]) == [st.EVENT_FIRST, st.EVENT_OK, st.EVENT_OK, st.EVENT_OK]
    assert t.lost == 0


def test_artnet_zero_means_sequence_disabled():
    t = SequenceTracker("artnet")
    assert feed(t, [0, 0, 0]) == [st.EVENT_UNTRACKED] * 3
    assert t.untracked == 3 and t.lost == 0
    # 0 夹在正常序号之间也不会打乱跟踪
    assert feed(t, [5, 0, 6]) == [st.EVENT_FIRST, st.EVENT_UNTRACKED, st.EVENT_OK]


def test_sacn_wraps_through_zero():
    t = SequenceTracker("sacn")
    assert feed(t, [254, 255, 0, 1]) == [st.EVENT_FIRST] + [st.EVENT_OK] * 3
    assert t.lost == 0


def test_gap_counts_lost_packets():
    t = SequenceTracker("sacn")
    feed(t, [10, 11])
    event = t.observe(15)
    assert (event.kind, event.lost) == (st.EVENT_GAP, 3)
    assert t.lost == 3


def test_gap_across_wrap():
    t = SequenceTracker("sacn")
    feed(t, [254])
    assert t.observe(1).lost == 2  # 255、0 丢失
    t = SequenceTracker("artnet")
    feed(t, [254])
    assert t.observe(2).lost == 2  # 255、1 丢失


def test_duplicate():
    t = SequenceTracker("artnet")
    assert feed(t, [3, 4, 4, 5]) == [
        st.EVENT_FIRST,
        st.EVENT_OK,
        st.EVENT_DUPLICATE,
        st.EVENT_OK,
    ]
    assert t.duplicates == 1


def test_late_packet_is_out_of_order_and_repays_loss():
    t = SequenceTracker("sacn")
    feed(t, [1, 2, 4])  # 3 暂时被判为丢失
    assert t.lost == 1
    assert t.observe(3).kind == st.EVENT_LATE  # 3 迟到了
    assert t.out_of_order == 1
    assert t.lost == 0
    assert t.observe(5).kind == st.EVENT_OK  # 期望序号没有被迟到包拉回去


def test_swap_pattern_counts_one_ooo_and_no_loss():
    t = SequenceTracker("artnet")
    feed(t, [1, 2, 4, 3, 5, 6])
    assert (t.lost, t.out_of_order, t.duplicates, t.resets) == (0, 1, 0, 0)


def test_reset_when_sequence_jumps_far_back():
    t = SequenceTracker("sacn")
    feed(t, [200, 201, 202])
    assert t.observe(100).kind == st.EVENT_RESET  # 差值 -102
    assert t.resets == 1
    assert t.observe(101).kind == st.EVENT_OK  # 从新的起点继续


def test_out_of_order_window_boundary():
    t = SequenceTracker("sacn")
    feed(t, [100])
    assert t.observe(81).kind == st.EVENT_LATE  # 差 -19,仍算乱序
    t = SequenceTracker("sacn")
    feed(t, [100])
    assert t.observe(80).kind == st.EVENT_RESET  # 差 -20,视为复位


def test_interval_stats_welford():
    s = IntervalStats()
    assert (s.mean, s.stddev, s.percentile(0.99)) == (0.0, 0.0, 0.0)
    for v in (1.0, 2.0, 3.0):
        s.add(v)
    assert s.mean == pytest.approx(2.0)
    assert s.stddev == pytest.approx(1.0)
    assert (s.minimum, s.maximum, s.count) == (1.0, 3.0, 3)


def test_interval_percentile_uses_recent_window():
    s = IntervalStats(window=100)
    for _ in range(99):
        s.add(0.0227)
    s.add(0.5)
    assert s.percentile(0.5) == pytest.approx(0.0227)
    assert s.percentile(0.99) == pytest.approx(0.5)
    for _ in range(100):
        s.add(0.01)  # 旧的异常值被挤出窗口
    assert s.percentile(0.99) == pytest.approx(0.01)
    assert s.maximum == 0.5  # 但全局最大值保留


def test_constant_intervals_have_zero_jitter():
    s = IntervalStats()
    for _ in range(50):
        s.add(1 / 44)
    assert s.stddev == pytest.approx(0.0, abs=1e-12)


def test_rate_meter_window():
    meter = RateMeter(window=1.0)
    for i in range(44):
        meter.add(i * 22_727_272, 530)
    now = 43 * 22_727_272
    pps, bps = meter.rates(now)
    assert pps == pytest.approx(44.0, abs=1.5)
    assert bps == pytest.approx(44 * 530, rel=0.05)
    pps, bps = meter.rates(now + 5_000_000_000)  # 5 秒后窗口已空
    assert (pps, bps) == (0.0, 0.0)
