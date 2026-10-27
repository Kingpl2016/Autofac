import pytest

from artnet_sim.protocol import artnet_ext as ext
from artnet_sim.protocol.artnet import OpCode
from artnet_sim.protocol.decode import decode


def make_reply(**kwargs) -> ext.ArtPollReply:
    base = {
        "ip": "192.168.1.50",
        "version": (2, 3),
        "net_switch": 1,
        "sub_switch": 2,
        "oem": 0x1234,
        "esta_man": 0x4142,
        "short_name": "SimNode",
        "long_name": "Simulated node",
        "node_report": ext.format_node_report(ext.NodeReportCode.POWER_OK, 7, "OK"),
        "num_ports": 2,
        "port_types": (0x80, 0x40, 0, 0),
        "good_input": (0, 0x80, 0, 0),
        "good_output_a": (0x80, 0, 0, 0),
        "sw_in": (0, 5, 0, 0),
        "sw_out": (3, 0, 0, 0),
        "mac": bytes.fromhex("0a0b0c0d0e0f"),
        "bind_ip": "192.168.1.50",
        "bind_index": 2,
    }
    return ext.ArtPollReply(**(base | kwargs))


def test_poll_reply_offsets_follow_spec_table():
    pkt = make_reply().build()
    assert len(pkt) == 239
    assert pkt[0:8] == b"Art-Net\x00"
    assert pkt[8:10] == bytes.fromhex("00 21")  # OpPollReply 0x2100 小端
    assert pkt[10:14] == bytes([192, 168, 1, 50])
    assert pkt[14:16] == bytes.fromhex("36 19")  # Port 0x1936 小端
    assert pkt[16:18] == bytes([2, 3])
    assert pkt[18] == 1  # NetSwitch
    assert pkt[19] == 2  # SubSwitch
    assert pkt[20:22] == bytes.fromhex("12 34")  # Oem 高字节在前
    assert pkt[24:26] == bytes.fromhex("42 41")  # EstaManLo, EstaManHi
    assert pkt[26:33] == b"SimNode"
    assert pkt[33:44] == b"\x00" * 11
    assert pkt[44:58] == b"Simulated node"
    assert pkt[108:136].startswith(b"#0001 [0007] OK")
    assert pkt[172:174] == bytes([0, 2])  # NumPorts
    assert pkt[174:178] == bytes([0x80, 0x40, 0, 0])  # PortTypes
    assert pkt[178:182] == bytes([0, 0x80, 0, 0])  # GoodInput
    assert pkt[182:186] == bytes([0x80, 0, 0, 0])  # GoodOutputA
    assert pkt[186:190] == bytes([0, 5, 0, 0])  # SwIn
    assert pkt[190:194] == bytes([3, 0, 0, 0])  # SwOut
    assert pkt[194] == 100  # AcnPriority
    assert pkt[200] == 0  # Style
    assert pkt[201:207] == bytes.fromhex("0a 0b 0c 0d 0e 0f")
    assert pkt[207:211] == bytes([192, 168, 1, 50])  # BindIp
    assert pkt[211] == 2  # BindIndex
    assert pkt[212] & 0x08  # Status2: 15 位 Port-Address
    assert pkt[228:239] == b"\x00" * 11  # Filler


def test_poll_reply_roundtrip():
    original = make_reply(refresh_rate=44, user=0x0102, status3=0x08)
    parsed = ext.parse_poll_reply(original.build())
    assert parsed == original


def test_poll_reply_expand_ports_matches_studio_rules():
    ports = make_reply().expand_ports()
    assert [(p.index, p.direction, p.universe, p.active) for p in ports] == [
        (0, "output", (1 << 8) | (2 << 4) | 3, True),
        (1, "input", (1 << 8) | (2 << 4) | 5, True),
    ]


def test_poll_reply_expand_ports_bidirectional_slot():
    reply = make_reply(
        port_types=(0xC0, 0, 0, 0),
        sw_in=(1, 0, 0, 0),
        sw_out=(2, 0, 0, 0),
        good_input=(0, 0, 0, 0),
        good_output_a=(0, 0, 0, 0),
    )
    ports = reply.expand_ports()
    assert [(p.direction, p.universe, p.active) for p in ports] == [
        ("input", 0x0121, False),
        ("output", 0x0122, False),
    ]


def test_poll_reply_masks_net_and_sub_like_studio():
    # Studio 取 net_switch & 0x7F、sub_switch & 0x0F、sw & 0x0F。
    reply = make_reply(
        net_switch=0xFF,
        sub_switch=0xF5,
        port_types=(0x80, 0, 0, 0),
        sw_out=(0xA7, 0, 0, 0),
        good_output_a=(0, 0, 0, 0),
    )
    (port,) = reply.expand_ports()
    assert port.universe == (0x7F << 8) | (5 << 4) | 7


def test_poll_reply_accepts_207_bytes_and_fills_zero():
    pkt = make_reply().build()[:207]
    parsed = ext.parse_poll_reply(pkt)
    assert parsed is not None
    assert parsed.bind_ip == "0.0.0.0"
    assert parsed.bind_index == 0
    assert parsed.refresh_rate == 0


def test_poll_reply_rejects_short_or_wrong_opcode():
    pkt = make_reply().build()
    assert ext.parse_poll_reply(pkt[:206]) is None
    wrong = bytearray(pkt)
    wrong[9] = 0x50
    assert ext.parse_poll_reply(bytes(wrong)) is None


def test_poll_reply_string_truncation_and_utf8():
    pkt = make_reply(short_name="x" * 40, long_name="灯" * 40).build()
    assert pkt[26:43] == b"x" * 17 and pkt[43] == 0
    parsed = ext.parse_poll_reply(pkt)
    assert parsed is not None
    assert parsed.short_name == "x" * 17
    assert parsed.long_name.startswith("灯")


@pytest.mark.parametrize(
    "kwargs",
    [
        {"port_types": (0, 0, 0)},
        {"sw_in": (0, 0, 0, 256)},
        {"mac": b"\x00" * 5},
        {"num_ports": 5},
        {"bind_index": 256},
        {"oem": 0x10000},
        {"ip": "999.1.1.1"},
    ],
)
def test_poll_reply_build_rejects_invalid(kwargs):
    with pytest.raises(ValueError):
        make_reply(**kwargs).build()


def test_format_node_report():
    assert ext.format_node_report(1, 12, "OK") == "#0001 [0012] OK"
    assert ext.format_node_report(0xD, 10005, "short") == "#000d [0005] short"


def test_address_layout_follows_spec_table():
    pkt = ext.ArtAddress(
        net_switch=0x81,
        bind_index=2,
        port_name="P1",
        long_name="Long",
        sw_in=(0x81, 0, 0, 0),
        sw_out=(0, 0x82, 0, 0),
        sub_switch=0x83,
        acn_priority=150,
        command=ext.AddressCommand.LED_LOCATE,
    ).build()
    assert len(pkt) == 107
    assert pkt[8:10] == bytes.fromhex("00 60")
    assert pkt[12] == 0x81
    assert pkt[13] == 2
    assert pkt[14:16] == b"P1"
    assert pkt[32:36] == b"Long"
    assert pkt[96:100] == bytes([0x81, 0, 0, 0])
    assert pkt[100:104] == bytes([0, 0x82, 0, 0])
    assert pkt[104] == 0x83
    assert pkt[105] == 150
    assert pkt[106] == 0x04


def test_address_roundtrip_and_defaults():
    addr = ext.ArtAddress(port_name="A", long_name="B", command=ext.AddressCommand.MERGE_LTP_2)
    assert ext.parse_address(addr.build()) == addr
    assert ext.ArtAddress().acn_priority == 255
    assert ext.parse_address(addr.build()[:106]) is None


def test_decode_switch_semantics():
    assert ext.decode_switch(0x87) == ("program", 7)
    assert ext.decode_switch(0x00) == ("reset", None)
    assert ext.decode_switch(0x07) == ("ignore", None)


def test_sync_packet():
    pkt = ext.build_sync()
    assert pkt == bytes.fromhex("41 72 74 2d 4e 65 74 00 00 52 00 0e 00 00")
    assert ext.parse_sync(pkt)
    assert not ext.parse_sync(pkt[:13])
    assert not ext.parse_sync(b"Art-Net\x00" + bytes(10))


def test_time_code_packet():
    tc = ext.ArtTimeCode(frames=12, seconds=34, minutes=56, hours=7, type=ext.TimeCodeType.EBU)
    pkt = tc.build()
    assert len(pkt) == 19
    assert pkt[8:10] == bytes.fromhex("00 97")
    assert pkt[12:14] == b"\x00\x00"  # Filler
    assert pkt[14:19] == bytes([12, 34, 56, 7, 1])
    assert ext.parse_time_code(pkt) == tc


@pytest.mark.parametrize(
    "kwargs",
    [{"frames": 30}, {"seconds": 60}, {"minutes": 60}, {"hours": 24}, {"type": 4}, {"frames": -1}],
)
def test_time_code_rejects_out_of_range(kwargs):
    args = {"frames": 0, "seconds": 0, "minutes": 0, "hours": 0} | kwargs
    with pytest.raises(ValueError):
        ext.ArtTimeCode(**args).build()


def test_nzs_packet():
    pkt = ext.ArtNzs(sequence=3, start_code=0x91, port_address=0x0123, data=b"\x01\x02\x03").build()
    assert len(pkt) == 18 + 3
    assert pkt[8:10] == bytes.fromhex("00 51")
    assert pkt[12] == 3
    assert pkt[13] == 0x91
    assert pkt[14] == 0x23  # SubUni(低字节)
    assert pkt[15] == 0x01  # Net
    assert pkt[16:18] == bytes.fromhex("00 03")
    parsed = ext.parse_nzs(pkt)
    assert parsed == ext.ArtNzs(3, 0x91, 0x0123, b"\x01\x02\x03")


@pytest.mark.parametrize(
    "kwargs",
    [
        {"start_code": 0},
        {"start_code": 0xCC},
        {"data": b""},
        {"data": b"\x00" * 513},
        {"port_address": 0x8000},
        {"sequence": 256},
    ],
)
def test_nzs_rejects_invalid(kwargs):
    args = {"sequence": 0, "start_code": 0x91, "port_address": 0, "data": b"\x01"} | kwargs
    with pytest.raises(ValueError):
        ext.ArtNzs(**args).build()


def test_decode_dispatch_for_extension_packets():
    assert decode(make_reply().build()).kind == "ArtPollReply"
    assert decode(ext.ArtAddress(command=ext.AddressCommand.LED_MUTE).build()).kind == "ArtAddress"
    assert decode(ext.build_sync()).kind == "ArtSync"
    assert decode(ext.ArtTimeCode(1, 2, 3, 4).build()).kind == "ArtTimeCode"
    assert decode(ext.ArtNzs(0, 0x91, 1, b"\x01").build()).kind == "ArtNzs"


def test_decode_poll_reply_lists_ports():
    fields = dict(decode(make_reply().build()).fields)
    assert fields["短名"] == "SimNode"
    assert "Universe 291" in fields["端口 1 输出"]  # 0x123
    assert "有数据" in fields["端口 2 输入"]


def test_opcode_enum_values():
    assert OpCode.POLL_REPLY == 0x2100
    assert OpCode.SYNC == 0x5200
    assert OpCode.ADDRESS == 0x6000
    assert OpCode.TIME_CODE == 0x9700
    assert OpCode.NZS == 0x5100
