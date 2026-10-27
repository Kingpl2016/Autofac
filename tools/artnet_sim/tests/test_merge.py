from artnet_sim.node.merge import ArtnetMerger, SacnMerger, htp

S = 1_000_000_000  # 1 秒(ns)


def test_htp_helper():
    assert htp([b"\x01\x05"]) == b"\x01\x05"
    assert htp([b"\x01\x05", b"\x03\x02"]) == b"\x03\x05"
    assert htp([b"\x01", b"\x00\x09\x07"]) == b"\x01\x09\x07"  # 较短的帧按 0 补齐
    assert htp([b"\x01", b"\x02", b"\x03"]) == b"\x03"


def test_single_source_passes_through():
    m = ArtnetMerger()
    assert m.feed("10.0.0.1", 0, b"\x01\x02", 0)
    assert m.output == b"\x01\x02" and not m.merging
    m.feed("10.0.0.1", 0, b"\x09\x09", 1)
    assert m.output == b"\x09\x09"


def test_two_sources_merge_htp():
    m = ArtnetMerger("htp")
    m.feed("10.0.0.1", 0, b"\x10\x00\x30", 0)
    m.feed("10.0.0.2", 0, b"\x00\x20\x10", 1)
    assert m.merging
    assert m.output == b"\x10\x20\x30"
    m.feed("10.0.0.1", 0, b"\x00\x00\x00", 2)  # A 全部降到 0
    assert m.output == b"\x00\x20\x10"  # 只剩 B 的值


def test_two_sources_merge_ltp_takes_latest_frame():
    m = ArtnetMerger("ltp")
    m.feed("10.0.0.1", 0, b"\xff\xff", 0)
    m.feed("10.0.0.2", 0, b"\x01\x01", 1)
    assert m.output == b"\x01\x01"
    m.feed("10.0.0.1", 0, b"\x07\x07", 2)
    assert m.output == b"\x07\x07"


def test_different_physical_from_same_ip_is_a_second_source():
    m = ArtnetMerger()
    m.feed("10.0.0.1", 0, b"\x01", 0)
    m.feed("10.0.0.1", 1, b"\x02", 1)
    assert m.merging and m.output == b"\x02"


def test_third_source_is_ignored():
    m = ArtnetMerger()
    m.feed("10.0.0.1", 0, b"\x01", 0)
    m.feed("10.0.0.2", 0, b"\x02", 1)
    assert not m.feed("10.0.0.3", 0, b"\xff", 2)
    assert m.output == b"\x02" and m.ignored == 1
    assert [s["ip"] for s in m.sources(3)] == ["10.0.0.1", "10.0.0.2"]


def test_failed_source_is_held_for_ten_seconds_then_merge_ends():
    m = ArtnetMerger("htp", hold_s=10.0)
    m.feed("10.0.0.1", 0, b"\x10", 0)
    m.feed("10.0.0.2", 0, b"\x20", 0)
    # A 持续发送,B 停发
    for sec in range(1, 10):
        m.feed("10.0.0.1", 0, b"\x10", sec * S)
    assert m.merging  # B 还在 10 秒保留期内
    assert m.output == b"\x20"  # 仍然合并着 B 的旧值
    m.feed("10.0.0.1", 0, b"\x10", 11 * S)
    assert not m.merging
    assert m.output == b"\x10"


def test_failed_source_recovering_keeps_merge_going():
    m = ArtnetMerger(hold_s=10.0)
    m.feed("10.0.0.1", 0, b"\x10", 0)
    m.feed("10.0.0.2", 0, b"\x20", 0)
    m.feed("10.0.0.1", 0, b"\x10", 8 * S)
    m.feed("10.0.0.2", 0, b"\x30", 9 * S)
    assert m.merging and m.output == b"\x30"


def test_both_sources_failing_holds_last_output():
    m = ArtnetMerger(hold_s=10.0)
    m.feed("10.0.0.1", 0, b"\x10", 0)
    m.feed("10.0.0.2", 0, b"\x20", 0)
    assert m.expire(30 * S)
    assert not m.merging
    assert m.output == b"\x20"  # 保持最后一次合并结果
    assert m.sources(30 * S) == []


def test_expire_reports_changes():
    m = ArtnetMerger(hold_s=10.0)
    m.feed("10.0.0.1", 0, b"\x10", 0)
    m.feed("10.0.0.2", 0, b"\x20", 5 * S)
    assert not m.expire(6 * S)
    assert m.expire(11 * S)  # A 过期,合并结束,输出改为 B
    assert m.output == b"\x20"


def test_cancel_merge_locks_to_the_next_sender():
    m = ArtnetMerger(hold_s=10.0)
    m.feed("10.0.0.1", 0, b"\x10", 0)
    m.feed("10.0.0.2", 0, b"\x20", 0)
    m.cancel_merge()
    assert m.feed("10.0.0.2", 0, b"\x05", 1 * S)  # 结束合并的源
    assert not m.merging and m.output == b"\x05"
    assert not m.feed("10.0.0.1", 0, b"\xff", 2 * S)  # 其他 IP 被丢弃
    assert m.output == b"\x05"
    # 锁定源停发超过保留时间后,其他 IP 可以重新接入
    assert m.feed("10.0.0.1", 0, b"\x07", 20 * S)
    assert m.output == b"\x07"


def test_sacn_priority_arbitration():
    m = SacnMerger()
    m.feed("aa", "10.0.0.1", "低", 100, b"\xff\xff", 0)
    assert m.output == b"\xff\xff"
    m.feed("bb", "10.0.0.2", "高", 150, b"\x01\x02", 1)
    assert m.output == b"\x01\x02"  # 高优先级整体胜出,不做逐通道合并
    assert not m.merging
    sources = {s["name"]: s for s in m.sources(2)}
    assert sources["高"]["winning"] and not sources["低"]["winning"]


def test_sacn_equal_priority_merges_htp():
    m = SacnMerger()
    m.feed("aa", "10.0.0.1", "A", 100, b"\x10\x00", 0)
    m.feed("bb", "10.0.0.2", "B", 100, b"\x00\x20", 1)
    assert m.merging and m.output == b"\x10\x20"


def test_sacn_terminated_removes_source_immediately():
    m = SacnMerger()
    m.feed("aa", "10.0.0.1", "A", 100, b"\x10", 0)
    m.feed("bb", "10.0.0.2", "B", 150, b"\x20", 1)
    m.feed("bb", "10.0.0.2", "B", 150, b"\x20", 2, terminated=True)
    assert m.output == b"\x10"  # 高优先级源结束后,低优先级源接管


def test_sacn_source_times_out_after_2_5_seconds():
    m = SacnMerger()
    m.feed("aa", "10.0.0.1", "A", 100, b"\x10", 0)
    m.feed("bb", "10.0.0.2", "B", 150, b"\x20", 0)
    m.feed("aa", "10.0.0.1", "A", 100, b"\x11", 2 * S)
    assert not m.expire(2 * S)
    assert m.expire(3 * S)  # B 超过 2.5 秒没数据
    assert m.output == b"\x11"
    assert m.expire(10 * S) is False  # A 也过期后无源可算,保持输出
    assert m.output == b"\x11"


def test_sacn_source_cap():
    m = SacnMerger()
    for i in range(8):
        assert m.feed(f"c{i}", "10.0.0.1", "x", 100, b"\x01", i)
    assert not m.feed("c9", "10.0.0.1", "x", 100, b"\x01", 9)
    assert m.ignored == 1
