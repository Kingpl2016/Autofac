import pytest

from artnet_sim.node.config import NodeConfig, PortConfig, group_binds
from artnet_sim.node.virtual_node import VirtualNode
from artnet_sim.protocol import artnet, artnet_ext, sacn
from artnet_sim.protocol.artnet_ext import AddressCommand as Cmd

S = 1_000_000_000
CTRL = ("10.0.0.100", 55555)
SRC_A = ("10.0.0.1", 40001)
SRC_B = ("10.0.0.2", 40002)
CID_A = bytes([0xA] * 16)
CID_B = bytes([0xB] * 16)


def make(ports=None, **kwargs):
    ports = ports or [PortConfig("output", 0x0101)]
    return VirtualNode(NodeConfig(id="n1", ip="10.0.0.50", ports=ports, **kwargs))


def dmx(addr, fill, seq=1, physical=0):
    pkt = bytearray(artnet.build_dmx(addr, seq, bytes([fill]) * 4))
    pkt[13] = physical
    return bytes(pkt)


def replies_of(node):
    return [artnet_ext.parse_poll_reply(p) for p in node.build_replies()]


def poll(node, t=S, **kw):
    return node.handle_artnet(artnet.build_poll(**kw), CTRL, t)


def test_group_binds_by_count_and_net_sub():
    ports = [PortConfig(address=a) for a in (0x10, 0x11, 0x12, 0x13, 0x14, 0x20, 0x21)]
    assert group_binds(ports) == [[0, 1, 2, 3], [4], [5, 6]]  # 满 4 个新开一组;0x20 换了 SubNet


def test_poll_reply_describes_ports_like_studio_expects():
    node = make(
        [
            PortConfig("output", 0x0123),
            PortConfig("input", 0x0125),
            PortConfig("both", 0x0126, merge_mode="ltp"),
        ]
    )
    (reply,) = replies_of(node)
    assert reply.ip == "10.0.0.50" and reply.bind_ip == "10.0.0.50" and reply.bind_index == 1
    assert (reply.net_switch, reply.sub_switch) == (1, 2)
    assert reply.num_ports == 3
    assert reply.port_types[:3] == (0x80, 0x40, 0xC0)
    assert [(p.index, p.direction, p.universe) for p in reply.expand_ports()] == [
        (0, "output", 0x123),
        (1, "input", 0x125),
        (2, "input", 0x126),
        (2, "output", 0x126),
    ]
    assert reply.good_output_a[2] & artnet_ext.GOOD_OUTPUT_LTP
    assert reply.status2 & artnet_ext.STATUS2_PORT_ADDRESS_15BIT
    assert reply.mac == node.config.mac_bytes() and reply.mac[0] == 0x02


def test_many_ports_produce_multiple_binds_with_same_ip_and_names():
    ports = [PortConfig("output", 0x0100 + i) for i in range(6)]
    node = make(ports)
    replies = replies_of(node)
    assert [r.bind_index for r in replies] == [1, 2]
    assert [r.num_ports for r in replies] == [4, 2]
    assert len({r.long_name for r in replies}) == 1  # 多 Bind 必须上报相同的长名
    assert len({r.ip for r in replies}) == 1
    assert len({r.mac for r in replies}) == 1
    assert [p.universe for p in replies[1].expand_ports()] == [0x104, 0x105]


def test_node_report_counter_increments_per_reply_round():
    node = make()
    first = replies_of(node)[0].node_report
    second = replies_of(node)[0].node_report
    assert first.startswith("#0001 [0001]") and second.startswith("#0001 [0002]")


def test_poll_returns_reply_addressed_to_requester():
    node = make()
    out = poll(node)
    assert len(out) == 1 and out[0].to_ip == CTRL[0]
    assert artnet_ext.parse_poll_reply(out[0].payload) is not None
    assert node.counters["polls"] == 1


def test_targeted_poll_only_replies_when_range_matches():
    node = make([PortConfig("output", 0x0101)])
    assert poll(node, target=(0x0100, 0x0102))
    assert not poll(node, target=(0x0200, 0x0300))
    assert not poll(node, target=(0x0000, 0x0100))


def test_offline_node_is_silent_and_ignores_data():
    node = make()
    node.set_online(False)
    assert poll(node) == []
    node.handle_artnet(dmx(0x0101, 9), SRC_A, S)
    assert node.port_output(0) == b""
    node.set_online(True)
    assert poll(node)
    node.handle_artnet(dmx(0x0101, 9), SRC_A, 2 * S)
    assert node.port_output(0) == bytes([9]) * 4


def test_dmx_reaches_matching_output_port_only():
    node = make(
        [PortConfig("output", 0x0101), PortConfig("output", 0x0102), PortConfig("input", 0x0103)]
    )
    node.handle_artnet(dmx(0x0102, 7), SRC_A, S)
    node.handle_artnet(dmx(0x0103, 8), SRC_A, S)  # 输入口不接收网络数据
    node.handle_artnet(dmx(0x0999, 9), SRC_A, S)
    assert node.port_output(0) == b""
    assert node.port_output(1) == bytes([7]) * 4
    assert node.port_output(2) == b""
    assert node.counters["dmx"] == 1


def test_good_output_active_bit_follows_data_age():
    node = make(active_timeout_s=4.0)
    node.handle_artnet(dmx(0x0101, 1), SRC_A, S)
    assert replies_of(node)[0].good_output_a[0] & artnet_ext.GOOD_DATA_ACTIVE
    node.tick(10 * S)
    node.handle_artnet(artnet.build_poll(), CTRL, 10 * S)
    assert not replies_of(node)[0].good_output_a[0] & artnet_ext.GOOD_DATA_ACTIVE


def test_merging_shown_in_reply_and_htp_ltp_switchable_by_command():
    node = make()
    node.handle_artnet(dmx(0x0101, 0x10), SRC_A, S)
    node.handle_artnet(dmx(0x0101, 0x20), SRC_B, S)
    assert node.port_output(0) == b"\x20" * 4
    reply = replies_of(node)[0]
    assert reply.good_output_a[0] & artnet_ext.GOOD_OUTPUT_MERGING
    assert not reply.good_output_a[0] & artnet_ext.GOOD_OUTPUT_LTP
    # 切到 LTP:最后到达的帧胜出
    node.handle_artnet(artnet_ext.ArtAddress(command=Cmd.MERGE_LTP_0).build(), CTRL, 2 * S)
    node.handle_artnet(dmx(0x0101, 0x05), SRC_A, 2 * S)
    assert node.port_output(0) == b"\x05" * 4
    assert replies_of(node)[0].good_output_a[0] & artnet_ext.GOOD_OUTPUT_LTP
    node.handle_artnet(artnet_ext.ArtAddress(command=Cmd.MERGE_HTP_0).build(), CTRL, 3 * S)
    node.handle_artnet(dmx(0x0101, 0x06), SRC_A, 3 * S)
    assert node.port_output(0) == b"\x20" * 4


def test_cancel_merge_command():
    node = make()
    node.handle_artnet(dmx(0x0101, 0x10), SRC_A, S)
    node.handle_artnet(dmx(0x0101, 0x20), SRC_B, S)
    node.handle_artnet(artnet_ext.ArtAddress(command=Cmd.CANCEL_MERGE).build(), CTRL, 2 * S)
    node.handle_artnet(dmx(0x0101, 0x07), SRC_B, 2 * S)
    node.handle_artnet(dmx(0x0101, 0x70), SRC_A, 2 * S)  # 被锁定丢弃
    assert node.port_output(0) == b"\x07" * 4
    assert not replies_of(node)[0].good_output_a[0] & artnet_ext.GOOD_OUTPUT_MERGING


def test_artaddress_programs_addresses_names_and_replies():
    node = make([PortConfig("output", 0x0101), PortConfig("input", 0x0102)])
    cmd = artnet_ext.ArtAddress(
        net_switch=0x85,
        sub_switch=0x83,
        sw_out=(0x87, 0, 0, 0),
        sw_in=(0, 0x89, 0, 0),
        port_name="新短名",
        long_name="新长名",
        acn_priority=150,
    )
    out = node.handle_artnet(cmd.build(), CTRL, S)
    assert len(out) == 1 and out[0].to_ip == CTRL[0]
    reply = artnet_ext.parse_poll_reply(out[0].payload)
    assert (reply.net_switch, reply.sub_switch) == (5, 3)
    assert reply.sw_out[0] == 7 and reply.sw_in[1] == 9
    assert (reply.short_name, reply.long_name, reply.acn_priority) == ("新短名", "新长名", 150)
    assert reply.status1 >> 4 & 0b11 == 0b10  # 已被网络编程
    assert node.subscribed_addresses() == [0x0537, 0x0539]
    # 新地址立即生效
    node.handle_artnet(dmx(0x0537, 4), SRC_A, 2 * S)
    assert node.port_output(0) == b"\x04" * 4


def test_artaddress_zero_restores_physical_settings_and_ff_priority_keeps_value():
    node = make([PortConfig("output", 0x0101)])
    node.handle_artnet(
        artnet_ext.ArtAddress(net_switch=0x85, sub_switch=0x83, sw_out=(0x87, 0, 0, 0)).build(),
        CTRL,
        S,
    )
    node.handle_artnet(
        artnet_ext.ArtAddress(net_switch=0, sub_switch=0, sw_out=(0, 0, 0, 0)).build(), CTRL, 2 * S
    )
    assert node.subscribed_addresses() == [0x0101]
    assert node.acn_priority == 100  # 255 表示不修改


def test_artaddress_unprogrammed_values_are_ignored():
    node = make()
    node.handle_artnet(
        artnet_ext.ArtAddress(net_switch=0x05, sw_out=(0x07, 0, 0, 0)).build(), CTRL, S
    )
    assert node.subscribed_addresses() == [0x0101]  # 最高位未置位 → 忽略


def test_artaddress_targets_the_right_bind():
    node = make([PortConfig("output", 0x0100 + i) for i in range(5)])
    node.handle_artnet(artnet_ext.ArtAddress(bind_index=2, net_switch=0x89).build(), CTRL, S)
    replies = replies_of(node)
    assert [r.net_switch for r in replies] == [1, 9]


def test_led_and_failsafe_commands_show_in_status():
    node = make()
    node.handle_artnet(artnet_ext.ArtAddress(command=Cmd.LED_LOCATE).build(), CTRL, S)
    assert replies_of(node)[0].status1 >> 6 == 0b01
    node.handle_artnet(artnet_ext.ArtAddress(command=Cmd.LED_MUTE).build(), CTRL, S)
    assert replies_of(node)[0].status1 >> 6 == 0b10
    node.handle_artnet(artnet_ext.ArtAddress(command=Cmd.LED_NORMAL).build(), CTRL, S)
    assert replies_of(node)[0].status1 >> 6 == 0b11
    node.handle_artnet(artnet_ext.ArtAddress(command=Cmd.FAIL_FULL).build(), CTRL, S)
    assert replies_of(node)[0].status3 >> 6 == 0b10


def test_direction_commands_change_port_types():
    node = make([PortConfig("output", 0x0101)])
    node.handle_artnet(artnet_ext.ArtAddress(command=Cmd.DIRECTION_RX_0).build(), CTRL, S)
    assert replies_of(node)[0].port_types[0] == 0x40
    node.handle_artnet(artnet_ext.ArtAddress(command=Cmd.DIRECTION_TX_0).build(), CTRL, S)
    assert replies_of(node)[0].port_types[0] == 0x80


def test_clear_output_command():
    node = make()
    node.handle_artnet(dmx(0x0101, 9), SRC_A, S)
    node.handle_artnet(artnet_ext.ArtAddress(command=Cmd.CLEAR_OP_0).build(), CTRL, S)
    assert node.port_output(0) == b"\x00" * 4


def test_acn_select_switches_port_to_sacn_and_back():
    node = make([PortConfig("output", 0x0001)])
    assert node.sacn_universes() == set()
    node.handle_artnet(artnet_ext.ArtAddress(command=Cmd.ACN_SEL_0).build(), CTRL, S)
    assert node.sacn_universes() == {2}  # Port-Address 1 + 偏移 1
    assert replies_of(node)[0].good_output_a[0] & artnet_ext.GOOD_OUTPUT_SACN
    node.handle_artnet(dmx(0x0001, 9), SRC_A, S)  # sACN 模式不再接收 ArtDmx
    assert node.port_output(0) == b""
    node.handle_artnet(artnet_ext.ArtAddress(command=Cmd.ARTNET_SEL_0).build(), CTRL, S)
    assert node.sacn_universes() == set()
    node.handle_artnet(dmx(0x0001, 9), SRC_A, S)
    assert node.port_output(0) == b"\x09" * 4


def sacn_pkt(universe, fill, cid=CID_A, prio=100, name="台", options=0, start_code_data=None):
    return sacn.build_data(universe, bytes([fill]) * 4, cid, name, priority=prio, options=options)


def test_sacn_mode_port_receives_and_arbitrates_by_priority():
    node = make([PortConfig("output", 0x0000, protocol="sacn")])
    assert node.sacn_universes() == {1}
    node.handle_sacn(sacn_pkt(1, 0x10, CID_A, 100), SRC_A, S)
    assert node.port_output(0) == b"\x10" * 4
    node.handle_sacn(sacn_pkt(1, 0x20, CID_B, 150, "高"), SRC_B, S)
    assert node.port_output(0) == b"\x20" * 4
    node.handle_sacn(sacn_pkt(2, 0x99), SRC_A, S)  # 其他 Universe 不理会
    assert node.port_output(0) == b"\x20" * 4
    node.handle_sacn(
        sacn_pkt(1, 0x20, CID_B, 150, options=sacn.OPT_STREAM_TERMINATED), SRC_B, 2 * S
    )
    assert node.port_output(0) == b"\x10" * 4  # 高优先级源终止后低优先级接管
    snap = node.snapshot(2 * S)["ports"][0]
    assert snap["protocol"] == "sacn" and snap["sources"][0]["priority"] == 100


def test_sacn_universe_offset_zero():
    node = VirtualNode(
        NodeConfig(
            id="n",
            ip="10.0.0.50",
            ports=[PortConfig("output", 0x0005, protocol="sacn")],
            sacn_universe_offset=0,
        )
    )
    assert node.sacn_universes() == {5}


def test_sacn_ignores_non_zero_start_code_and_artnet_mode_ports():
    node = make([PortConfig("output", 0x0000, protocol="sacn"), PortConfig("output", 0x0001)])
    pkt = bytearray(sacn_pkt(1, 5))
    pkt[125] = 0xDD  # 每地址优先级包,不是 DMX 数据
    node.handle_sacn(bytes(pkt), SRC_A, S)
    assert node.port_output(0) == b""
    node.handle_sacn(sacn_pkt(2, 5), SRC_A, S)  # 端口 1 是 Art-Net 模式
    assert node.port_output(1) == b""


def test_artsync_buffers_dmx_until_sync_arrives():
    node = make([PortConfig("output", 0x0101), PortConfig("output", 0x0102)])
    node.handle_artnet(dmx(0x0101, 1), SRC_A, S)  # 首帧:此时还是异步模式,直接输出
    node.handle_artnet(artnet_ext.build_sync(), SRC_A, S)  # 进入同步模式
    assert node.sync_active
    node.handle_artnet(dmx(0x0101, 2), SRC_A, 2 * S)
    node.handle_artnet(dmx(0x0102, 3), SRC_A, 2 * S)
    assert node.port_output(0) == b"\x01" * 4 and node.port_output(1) == b""  # 被缓冲
    node.handle_artnet(artnet_ext.build_sync(), SRC_A, 2 * S)
    assert node.port_output(0) == b"\x02" * 4 and node.port_output(1) == b"\x03" * 4


def test_artsync_from_other_ip_is_ignored_and_timeout_returns_to_async():
    node = make()
    node.handle_artnet(dmx(0x0101, 1), SRC_A, S)
    node.handle_artnet(artnet_ext.build_sync(), SRC_B, S)  # 与最近 ArtDmx 的来源不同
    assert not node.sync_active
    node.handle_artnet(artnet_ext.build_sync(), SRC_A, S)
    assert node.sync_active
    node.handle_artnet(dmx(0x0101, 2), SRC_A, 6 * S)  # 超过 4 秒没有 ArtSync
    assert not node.sync_active
    assert node.port_output(0) == b"\x02" * 4


def test_timecode_is_recorded():
    node = make()
    node.handle_artnet(artnet_ext.ArtTimeCode(1, 2, 3, 4).build(), CTRL, S)
    assert node.snapshot(S)["timecode"] == "04:03:02:01"


def test_tick_notifies_subscribers_when_state_changes():
    node = make()
    poll(node, t=S, flags=0x02)  # 订阅状态变化通知
    assert node.tick(S) == []  # 建立基线
    node.handle_artnet(dmx(0x0101, 1), SRC_A, 2 * S)
    out = node.tick(2 * S)
    assert [r.to_ip for r in out] == [CTRL[0]]
    assert artnet_ext.parse_poll_reply(out[0].payload).good_output_a[0] & 0x80
    assert node.tick(2 * S) == []  # 没有新变化
    out = node.tick(20 * S)  # 数据超时 → 状态再次变化
    assert len(out) == 1


def test_no_notification_without_subscription():
    node = make()
    poll(node, t=S, flags=0x00)
    node.tick(S)
    node.handle_artnet(dmx(0x0101, 1), SRC_A, 2 * S)
    assert node.tick(2 * S) == []


def test_snapshot_shape():
    node = make([PortConfig("output", 0x0101), PortConfig("input", 0x0102)])
    node.handle_artnet(dmx(0x0101, 1), SRC_A, S)
    snap = node.snapshot(S)
    assert snap["ip"] == "10.0.0.50" and snap["binds"] == 1 and snap["online"]
    p0, p1 = snap["ports"]
    assert p0["active"] and p0["packets"] == 1 and p0["channels"] == 4
    assert p0["sources"][0]["ip"] == "10.0.0.1"
    assert p1["direction"] == "input" and not p1["active"]


@pytest.mark.parametrize(
    "kwargs",
    [
        {"id": ""},
        {"ip": "300.1.1.1"},
        {"short_name": "x" * 18},
        {"long_name": "x" * 64},
        {"ports": []},
        {"ports": [PortConfig(direction="sideways")]},
        {"ports": [PortConfig(address=0x8000)]},
        {"ports": [PortConfig(merge_mode="max")]},
        {"ports": [PortConfig(protocol="dmx")]},
        {"acn_priority": 201},
        {"sacn_universe_offset": 2},
        {"active_timeout_s": 0},
        {"mac": "zz"},
        {"mac": "0102"},
        {"version": (1,)},
    ],
)
def test_node_config_validation(kwargs):
    base = {"id": "n", "ip": "10.0.0.5"} | kwargs
    with pytest.raises(ValueError):
        NodeConfig(**base).validate()


def test_node_config_from_dict_and_mac_derivation():
    config = NodeConfig.from_dict(
        {
            "id": "n",
            "ip": "127.0.0.2",
            "ports": [{"direction": "both", "address": 3}],
            "version": [2, 1],
        }
    )
    assert config.ports[0].direction == "both" and config.version == (2, 1)
    assert config.mac_bytes() == NodeConfig(id="n").mac_bytes()  # 由 id 派生,稳定
    assert config.mac_bytes() != NodeConfig(id="m").mac_bytes()
    assert NodeConfig(id="n", mac="AA:bb-cc.dd ee ff").mac_bytes() == bytes.fromhex("aabbccddeeff")
    for bad in ({"id": "n", "bogus": 1}, {"id": "n", "ports": [{"nope": 1}]}):
        with pytest.raises(ValueError):
            NodeConfig.from_dict(bad)
