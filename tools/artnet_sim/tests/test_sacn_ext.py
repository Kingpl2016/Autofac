import pytest

from artnet_sim.protocol import sacn
from artnet_sim.protocol.decode import decode

CID = bytes(range(16))


def test_sync_packet_layout():
    pkt = sacn.build_sync(sync_address=0x0102, cid=CID, sequence=9)
    assert len(pkt) == 49
    assert pkt[0:4] == b"\x00\x10\x00\x00"
    assert pkt[4:16] == sacn.ACN_PID
    assert pkt[16:18] == (0x7000 | 33).to_bytes(2, "big")  # Root PDU 长度 22 + 11
    assert pkt[18:22] == bytes.fromhex("00 00 00 08")  # Root 向量为 EXTENDED
    assert pkt[22:38] == CID
    assert pkt[38:40] == (0x7000 | 11).to_bytes(2, "big")
    assert pkt[40:44] == bytes.fromhex("00 00 00 01")
    assert pkt[44] == 9  # 序号
    assert pkt[45:47] == bytes.fromhex("01 02")  # 同步地址
    assert pkt[47:49] == b"\x00\x00"  # 保留


def test_sync_roundtrip_and_kind():
    pkt = sacn.build_sync(5, CID, 200)
    assert sacn.packet_kind(pkt) == "sync"
    parsed = sacn.parse_sync(pkt)
    assert parsed == sacn.SacnSync(sequence=200, sync_address=5, cid=CID)
    assert sacn.parse_data(pkt) is None
    assert sacn.parse_discovery(pkt) is None


@pytest.mark.parametrize(
    "kwargs", [{"sync_address": 0}, {"sync_address": 64000}, {"sequence": 256}]
)
def test_sync_rejects_invalid(kwargs):
    args = {"sync_address": 1, "cid": CID, "sequence": 0} | kwargs
    with pytest.raises(ValueError):
        sacn.build_sync(**args)


def test_discovery_single_page_layout():
    (pkt,) = sacn.build_discovery(CID, [3, 1, 2, 2], source_name="Disc")
    assert len(pkt) == 120 + 6
    assert pkt[16:18] == (0x7000 | (len(pkt) - 16)).to_bytes(2, "big")
    assert pkt[18:22] == bytes.fromhex("00 00 00 08")
    assert pkt[38:40] == (0x7000 | (len(pkt) - 38)).to_bytes(2, "big")
    assert pkt[40:44] == bytes.fromhex("00 00 00 02")
    assert pkt[44:48] == b"Disc"
    assert pkt[108:112] == b"\x00" * 4  # 保留
    assert pkt[112:114] == (0x7000 | (len(pkt) - 112)).to_bytes(2, "big")
    assert pkt[114:118] == bytes.fromhex("00 00 00 01")
    assert pkt[118] == 0  # 页
    assert pkt[119] == 0  # 最后一页
    assert pkt[120:126] == bytes.fromhex("00 01 00 02 00 03")  # 去重、升序


def test_discovery_roundtrip():
    (pkt,) = sacn.build_discovery(CID, [10, 20, 63999], "源A")
    assert sacn.packet_kind(pkt) == "discovery"
    parsed = sacn.parse_discovery(pkt)
    assert parsed == sacn.SacnDiscovery("源A", CID, 0, 0, (10, 20, 63999))


def test_discovery_empty_list_still_one_page():
    (pkt,) = sacn.build_discovery(CID, [])
    parsed = sacn.parse_discovery(pkt)
    assert parsed is not None
    assert parsed.universes == ()
    assert len(pkt) == 120


def test_discovery_paginates_at_512():
    universes = list(range(1, 1201))
    pages = sacn.build_discovery(CID, universes)
    assert len(pages) == 3
    parsed = [sacn.parse_discovery(p) for p in pages]
    assert all(p is not None for p in parsed)
    assert [p.page for p in parsed] == [0, 1, 2]
    assert {p.last_page for p in parsed} == {2}
    assert [len(p.universes) for p in parsed] == [512, 512, 176]
    merged = [u for p in parsed for u in p.universes]
    assert merged == universes
    assert len(pages[0]) == 120 + 1024


def test_discovery_rejects_invalid():
    with pytest.raises(ValueError):
        sacn.build_discovery(b"short", [1])
    with pytest.raises(ValueError):
        sacn.build_discovery(CID, [0])
    with pytest.raises(ValueError):
        sacn.build_discovery(CID, [64000])


def test_parse_discovery_rejects_unsorted_or_truncated():
    (pkt,) = sacn.build_discovery(CID, [1, 2])
    bad = bytearray(pkt)
    bad[120:124] = bytes.fromhex("00 02 00 01")
    assert sacn.parse_discovery(bytes(bad)) is None
    assert sacn.parse_discovery(pkt[:121]) is None
    assert sacn.parse_discovery(pkt[:-2]) is None


def test_packet_kind_for_data_and_garbage():
    assert sacn.packet_kind(sacn.build_data(1, b"\x00", CID)) == "data"
    assert sacn.packet_kind(b"") is None
    assert sacn.packet_kind(b"Art-Net\x00" + bytes(50)) is None


def test_decode_dispatch():
    assert decode(sacn.build_sync(3, CID)).kind == "sACN 同步包"
    (disc,) = sacn.build_discovery(CID, [1, 2, 3])
    result = decode(disc)
    assert result.kind == "sACN Universe Discovery"
    assert dict(result.fields)["Universe 数"] == "3"
    assert decode(sacn.build_data(1, b"\x00", CID)).kind == "sACN 数据包"


def test_constants():
    assert sacn.DISCOVERY_INTERVAL_S == 10.0
    assert sacn.NETWORK_DATA_LOSS_TIMEOUT_S == 2.5
