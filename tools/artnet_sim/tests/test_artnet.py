import pytest

from artnet_sim.protocol import artnet


def test_build_dmx_golden_bytes():
    # 手工拼出的期望字节:奇数长度(3)补齐为 4。
    expected = bytes.fromhex(
        "41 72 74 2d 4e 65 74 00"  # "Art-Net\0"
        "00 50"  # OpDmx 0x5000 小端
        "00 0e"  # 协议版本 14
        "05 00"  # Sequence=5 Physical=0
        "01 00"  # Port-Address=1 小端
        "00 04"  # Length=4 大端
        "ff 00 80 00"
    )
    assert artnet.build_dmx(1, 5, bytes([255, 0, 128])) == expected


def test_build_dmx_pads_odd_length_and_truncates():
    assert len(artnet.build_dmx(0, 0, b"\x01" * 3)) == 18 + 4
    assert len(artnet.build_dmx(0, 0, b"\x01" * 600)) == artnet.ARTDMX_MAX_LEN
    assert len(artnet.build_dmx(0, 0, b"\x01" * 512)) == 530


def test_build_dmx_port_address_is_little_endian():
    pkt = artnet.build_dmx(0x1234, 0, b"\x00\x00")
    assert pkt[14:16] == bytes([0x34, 0x12])


@pytest.mark.parametrize(
    ("port", "seq", "data"),
    [(0x8000, 0, b"\x00"), (-1, 0, b"\x00"), (0, 256, b"\x00"), (0, -1, b"\x00"), (0, 0, b"")],
)
def test_build_dmx_rejects_invalid(port, seq, data):
    with pytest.raises(ValueError):
        artnet.build_dmx(port, seq, data)


def test_dmx_roundtrip():
    data = bytes(range(256)) * 2
    parsed = artnet.parse_dmx(artnet.build_dmx(0x7FFF, 200, data))
    assert parsed is not None
    assert parsed.port_address == 0x7FFF
    assert parsed.sequence == 200
    assert parsed.data == data
    assert parsed.declared_length == 512
    assert parsed.protocol_version == 14


def test_parse_dmx_is_lenient_about_length_field():
    # 与 Rust 端一致:Length 字段不校验,取全部剩余字节。
    pkt = bytearray(artnet.build_dmx(1, 1, b"\x01\x02\x03\x04"))
    pkt[16:18] = (100).to_bytes(2, "big")
    parsed = artnet.parse_dmx(bytes(pkt))
    assert parsed is not None
    assert parsed.data == b"\x01\x02\x03\x04"
    assert parsed.declared_length == 100


def test_parse_dmx_rejects_bad_input():
    good = artnet.build_dmx(1, 1, b"\x01\x02")
    assert artnet.parse_dmx(good[:17]) is None  # 不足 18 字节
    assert artnet.parse_dmx(b"Art-Nex\x00" + good[8:]) is None  # 头错误
    bad_port = bytearray(good)
    bad_port[14:16] = (0x8000).to_bytes(2, "little")
    assert artnet.parse_dmx(bytes(bad_port)) is None  # Port-Address > 0x7FFF
    assert artnet.parse_dmx(artnet.build_poll()) is None  # OpCode 不符
    assert artnet.parse_dmx(b"") is None


def test_poll_golden_and_roundtrip():
    expected = bytes.fromhex("41 72 74 2d 4e 65 74 00 00 20 00 0e 02 10")
    assert artnet.build_poll() == expected
    poll = artnet.parse_poll(expected)
    assert poll is not None
    assert (poll.flags, poll.diag_priority, poll.protocol_version) == (0x02, 0x10, 14)


def test_parse_poll_rejects_short():
    assert artnet.parse_poll(artnet.build_poll()[:13]) is None


def test_opcode_of():
    assert artnet.opcode_of(artnet.build_dmx(0, 0, b"\x00\x00")) == artnet.OpCode.DMX
    assert artnet.opcode_of(artnet.build_poll()) == artnet.OpCode.POLL
    assert artnet.opcode_of(b"Art-Net") is None
    assert artnet.opcode_of(b"x" * 20) is None
    assert artnet.is_artnet(artnet.build_poll())
