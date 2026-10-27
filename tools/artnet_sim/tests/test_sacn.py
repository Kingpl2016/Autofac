import pytest

from artnet_sim.protocol import sacn

CID = bytes(range(16))


def test_build_data_layout_matches_rust_offsets():
    pkt = sacn.build_data(
        universe=0x0102,
        data=b"\xaa\xbb\xcc",
        cid=CID,
        source_name="Test",
        priority=150,
        sequence=7,
    )
    assert len(pkt) == 126 + 3
    # Root 层
    assert pkt[0:4] == b"\x00\x10\x00\x00"
    assert pkt[4:16] == b"ASC-E1.17\x00\x00\x00"
    assert pkt[16:18] == bytes.fromhex("70 71")  # 0x7000 | (22 + 91)
    assert pkt[18:22] == bytes.fromhex("00 00 00 04")
    assert pkt[22:38] == CID
    # Framing 层
    assert pkt[38:40] == bytes.fromhex("70 5b")  # 0x7000 | 91
    assert pkt[40:44] == bytes.fromhex("00 00 00 02")
    assert pkt[44:48] == b"Test"
    assert pkt[48:108] == b"\x00" * 60
    assert pkt[108] == 150  # 优先级
    assert pkt[109:111] == b"\x00\x00"  # 同步地址
    assert pkt[111] == 7  # 序号
    assert pkt[112] == 0  # Options
    assert pkt[113:115] == bytes.fromhex("01 02")  # Universe 大端
    # DMP 层
    assert pkt[115:117] == bytes.fromhex("70 0e")  # 0x7000 | 14
    assert pkt[117] == 0x02
    assert pkt[118] == 0xA1
    assert pkt[119:121] == b"\x00\x00"
    assert pkt[121:123] == b"\x00\x01"
    assert pkt[123:125] == bytes.fromhex("00 04")  # 属性数 = 通道数 + START Code
    assert pkt[125] == 0x00  # START Code
    assert pkt[126:] == b"\xaa\xbb\xcc"


def test_full_universe_length_fields():
    pkt = sacn.build_data(1, b"\x01" * 512, CID)
    assert len(pkt) == sacn.SACN_MAX_LEN == 638
    assert pkt[16:18] == (0x7000 | (638 - 16)).to_bytes(2, "big")
    assert pkt[38:40] == (0x7000 | (638 - 38)).to_bytes(2, "big")
    assert pkt[115:117] == (0x7000 | (638 - 115)).to_bytes(2, "big")
    assert pkt[123:125] == (513).to_bytes(2, "big")


def test_truncates_over_512_channels():
    assert len(sacn.build_data(1, b"\x01" * 700, CID)) == 638


def test_source_name_truncation_and_utf8():
    pkt = sacn.build_data(1, b"\x00", CID, source_name="x" * 100)
    assert pkt[44 + 63] == 0  # 最后一个字节始终为 NUL
    assert pkt[44 : 44 + 63] == b"x" * 63
    parsed = sacn.parse_data(sacn.build_data(1, b"\x00", CID, source_name="灯光控制台"))
    assert parsed is not None
    assert parsed.source_name == "灯光控制台"


def test_roundtrip():
    data = bytes(range(200))
    parsed = sacn.parse_data(
        sacn.build_data(63999, data, CID, "src", priority=200, sequence=255, sync_address=9)
    )
    assert parsed is not None
    assert parsed.universe == 63999
    assert parsed.priority == 200
    assert parsed.sequence == 255
    assert parsed.sync_address == 9
    assert parsed.cid == CID
    assert parsed.start_code == 0
    assert parsed.data == data
    assert not parsed.terminated


def test_terminated_flag():
    pkt = sacn.build_terminated(5, b"\x01\x02", CID, sequence=3)
    assert pkt[112] == 0x40
    parsed = sacn.parse_data(pkt)
    assert parsed is not None
    assert parsed.terminated
    assert not parsed.preview


def test_preview_flag():
    parsed = sacn.parse_data(sacn.build_data(1, b"\x00", CID, options=sacn.OPT_PREVIEW))
    assert parsed is not None
    assert parsed.preview


@pytest.mark.parametrize(
    "kwargs",
    [
        {"universe": 0},
        {"universe": 65536},
        {"priority": 201},
        {"priority": -1},
        {"sequence": 256},
        {"options": 256},
        {"sync_address": 65536},
    ],
)
def test_build_rejects_invalid(kwargs):
    args = {"universe": 1, "data": b"\x00", "cid": CID} | kwargs
    with pytest.raises(ValueError):
        sacn.build_data(**args)


def test_build_rejects_bad_cid():
    with pytest.raises(ValueError):
        sacn.build_data(1, b"\x00", b"short")


def test_parse_rejects_bad_input():
    good = sacn.build_data(1, b"\x01\x02\x03", CID)
    assert sacn.parse_data(b"") is None
    assert sacn.parse_data(good[:125]) is None
    assert sacn.parse_data(good[:127]) is None  # 属性数声明 4,但数据不足
    for offset, patch in [(4, b"X"), (21, b"\x05"), (43, b"\x09"), (117, b"\x03")]:
        bad = bytearray(good)
        bad[offset : offset + len(patch)] = patch
        assert sacn.parse_data(bytes(bad)) is None
    zero_props = bytearray(good)
    zero_props[123:125] = b"\x00\x00"
    assert sacn.parse_data(bytes(zero_props)) is None


def test_is_sacn():
    assert sacn.is_sacn(sacn.build_data(1, b"\x00", CID))
    assert not sacn.is_sacn(b"Art-Net\x00" + b"\x00" * 40)


def test_new_cid_is_16_random_bytes():
    a, b = sacn.new_cid(), sacn.new_cid()
    assert len(a) == 16
    assert a != b
