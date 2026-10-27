import io
import struct
from pathlib import Path

import pytest

from artnet_sim.protocol.artrec import (
    CHUNK_DIFF,
    CHUNK_FULL,
    FLAG_DIFF_FRAME,
    HEADER_SIZE,
    MAX_UNIVERSE,
    ArtRecCrcError,
    ArtRecError,
    ArtRecFormatError,
    ArtRecReader,
    ArtRecWriter,
    Compress,
    DiffChange,
    UniDesc,
    apply_diff,
    crc16_ccitt,
    decode_diff,
    encode_diff,
)

FIXTURE = Path(__file__).parent / "fixtures" / "rust_sample.artrec"


def f0():
    return [bytes((u * 7 + c) % 251 for c in range(512)) for u in range(3)]


def f2():
    return [bytes((u * 11 + c * 3) % 256 for c in range(512)) for u in range(3)]


def frame1():
    buffers = [bytearray(b) for b in f0()]
    buffers[0][5], buffers[1][511], buffers[2][0] = 200, 100, 9
    return [bytes(b) for b in buffers]


def write_sample(compress=Compress.ZSTD, universes=(0, 5, 100)) -> bytes:
    fp = io.BytesIO()
    w = ArtRecWriter(
        fp,
        [UniDesc.from_universe(u) for u in universes],
        compress=compress,
        flags=FLAG_DIFF_FRAME,
        rec_start_us=1_700_000_000_000_000,
    )
    w.add_full_frame(0, f0())
    w.add_diff_frame(1000, [DiffChange(0, 5, 200), DiffChange(1, 511, 100), DiffChange(2, 0, 9)])
    w.add_full_frame(2500, f2())
    w.finish(3000)
    return fp.getvalue()


def test_crc16_check_value():
    # CRC-16/CCITT-FALSE 的标准校验值
    assert crc16_ccitt(b"123456789") == 0x29B1
    assert crc16_ccitt(b"") == 0xFFFF


def test_reads_file_written_by_the_rust_implementation():
    reader = ArtRecReader(FIXTURE.read_bytes())
    h = reader.header
    assert (h.ver_major, h.ver_minor, h.frame_count, h.universe_count) == (1, 0, 3, 3)
    assert h.total_duration_us == 3000 and h.rec_start_us == 1_700_000_000_000_000
    assert h.compress_algo == Compress.ZSTD and h.compress_level == 3 and h.allows_diff
    assert reader.universes == [0, 5, 100]
    frames = [(t, [bytes(b) for b in bufs]) for t, bufs in reader.iter_frames()]
    assert frames == [(0, f0()), (1000, frame1()), (2500, f2())]
    assert [reader.chunk_type(i) for i in range(3)] == [CHUNK_FULL, CHUNK_DIFF, CHUNK_FULL]


def test_header_and_descriptors_are_byte_identical_to_rust():
    ours = write_sample()
    rust = FIXTURE.read_bytes()
    # 头(64) + 3 条 UniDesc(48) 与压缩算法无关,必须逐字节相同
    assert ours[: HEADER_SIZE + 48] == rust[: HEADER_SIZE + 48]


def test_python_written_file_roundtrips_for_both_compressions():
    for compress in (Compress.ZSTD, Compress.NONE):
        reader = ArtRecReader(write_sample(compress))
        assert reader.header.compress_algo == compress
        frames = [(t, [bytes(b) for b in bufs]) for t, bufs in reader.iter_frames()]
        assert frames == [(0, f0()), (1000, frame1()), (2500, f2())]


def test_random_access_and_time_lookup():
    reader = ArtRecReader(write_sample())
    assert [bytes(b) for b in reader.buffers_at(1)] == frame1()
    assert [bytes(b) for b in reader.buffers_at(2)] == f2()
    assert reader.frame_at_time(-1) == -1
    assert [reader.frame_at_time(t) for t in (0, 999, 1000, 2499, 2500, 10**9)] == [
        0,
        0,
        1,
        1,
        2,
        2,
    ]


def test_diff_payload_helpers():
    changes = [DiffChange(0, 3, 9), DiffChange(1, 0, 255)]
    payload = encode_diff(changes)
    assert payload == bytes.fromhex("0002 0000 0003 09 0001 0000 ff".replace(" ", ""))
    assert decode_diff(payload) == changes
    buffers = [bytearray(4), bytearray(2)]
    apply_diff(buffers, [*changes, DiffChange(0, 99, 1), DiffChange(7, 0, 1)])  # 越界被忽略
    assert buffers == [bytearray([0, 0, 0, 9]), bytearray([255, 0])]
    with pytest.raises(ArtRecFormatError):
        decode_diff(b"\x00")
    with pytest.raises(ArtRecFormatError):
        decode_diff(b"\x00\x02\x00\x00\x00\x00\x00")


def test_empty_recording_is_valid():
    fp = io.BytesIO()
    w = ArtRecWriter(fp, [UniDesc.from_universe(1)])
    w.finish()
    reader = ArtRecReader(fp.getvalue())
    assert reader.header.frame_count == 0 and reader.duration_us == 0
    assert list(reader.iter_frames()) == []


def test_writer_validation():
    with pytest.raises(ArtRecError, match="重复"):
        ArtRecWriter(io.BytesIO(), [UniDesc.from_universe(1), UniDesc.from_universe(1)])
    with pytest.raises(ArtRecError, match="2047"):
        UniDesc.from_universe(MAX_UNIVERSE + 1)
    with pytest.raises(ArtRecError, match="127"):
        ArtRecWriter(io.BytesIO(), [UniDesc.from_universe(u) for u in range(128)])
    ArtRecWriter(io.BytesIO(), [UniDesc.from_universe(u) for u in range(127)])  # 127 路刚好够
    w = ArtRecWriter(io.BytesIO(), [UniDesc.from_universe(1)])
    with pytest.raises(ArtRecError, match="1 路|需要"):
        w.add_full_frame(0, [bytes(512), bytes(512)])
    with pytest.raises(ArtRecError, match="512"):
        w.add_full_frame(0, [bytes(100)])
    with pytest.raises(ArtRecError, match="ALLOW_DIFF_FRAME"):
        w.add_diff_frame(0, [])
    w.add_full_frame(100, [bytes(512)])
    with pytest.raises(ArtRecError, match="单调"):
        w.add_full_frame(50, [bytes(512)])
    with pytest.raises(ArtRecError, match="不能小于"):
        w.finish(10)


def test_reader_rejects_bad_files():
    good = write_sample()
    with pytest.raises(ArtRecFormatError, match="魔数"):
        ArtRecReader(b"XXXX" + good[4:])
    with pytest.raises(ArtRecFormatError, match="不足"):
        ArtRecReader(good[:20])
    bad_tag = bytearray(good)
    bad_tag[4:6] = b"\x12\x34"
    with pytest.raises(ArtRecFormatError, match="字节序"):
        ArtRecReader(bytes(bad_tag))
    future = bytearray(good)
    future[6:8] = (2).to_bytes(2, "big")
    with pytest.raises(ArtRecFormatError, match="主版本"):
        ArtRecReader(bytes(future))
    bad_algo = bytearray(good)
    bad_algo[50] = 9
    with pytest.raises(ArtRecFormatError, match="压缩算法"):
        ArtRecReader(bytes(bad_algo))
    with pytest.raises(ArtRecFormatError, match="截断"):
        ArtRecReader(good[: len(good) - 20])


def test_reader_rejects_unsorted_index():
    data = bytearray(write_sample())
    reader = ArtRecReader(bytes(data))
    off = reader.header.frame_index_offset
    data[off : off + 8] = struct.pack(">Q", 99999)  # 首帧时间戳大于后面的帧
    with pytest.raises(ArtRecFormatError, match="升序"):
        ArtRecReader(bytes(data))


def test_crc_corruption_is_detected():
    data = bytearray(write_sample(Compress.NONE))
    reader = ArtRecReader(bytes(data))
    pos = reader.header.chunk_pool_offset + reader.index[0].chunk_pos + 8 + 10
    data[pos] ^= 0xFF
    bad = ArtRecReader(bytes(data))
    with pytest.raises(ArtRecCrcError):
        bad.read_chunk(0)
    bad.read_chunk(1)  # 其他帧不受影响


def test_zstd_corruption_is_a_format_error():
    data = bytearray(write_sample(Compress.ZSTD))
    reader = ArtRecReader(bytes(data))
    pos = reader.header.chunk_pool_offset + reader.index[0].chunk_pos + 8
    data[pos : pos + 4] = b"\x00\x00\x00\x00"
    with pytest.raises(ArtRecFormatError):
        ArtRecReader(bytes(data)).read_chunk(0)


def test_diff_frame_without_header_flag_is_rejected():
    data = bytearray(write_sample(Compress.NONE))
    data[10:14] = (0).to_bytes(4, "big")  # 清掉 flags
    with pytest.raises(ArtRecFormatError, match="ALLOW_DIFF_FRAME"):
        list(ArtRecReader(bytes(data)).iter_frames())


def test_file_starting_with_diff_frame_cannot_be_rebuilt():
    fp = io.BytesIO()
    w = ArtRecWriter(fp, [UniDesc.from_universe(1)], flags=FLAG_DIFF_FRAME)
    w.add_diff_frame(0, [DiffChange(0, 0, 1)])
    w.finish()
    reader = ArtRecReader(fp.getvalue())
    with pytest.raises(ArtRecFormatError, match="差分帧开头"):
        list(reader.iter_frames())
    with pytest.raises(ArtRecFormatError, match="没有全量帧"):
        reader.buffers_at(0)


def to_little_endian(data: bytes) -> bytes:
    """把一个大端、无压缩的文件改写成小端文件(用来验证字节序自适应)。"""
    reader = ArtRecReader(data)
    h = reader.header
    out = bytearray(data)
    head = struct.pack(
        "<4sHHHIQQIIIIIBB",
        b"ARTR",
        0xAA55,
        h.ver_major,
        h.ver_minor,
        h.flags,
        h.rec_start_us,
        h.total_duration_us,
        h.universe_count,
        h.frame_count,
        h.universe_desc_offset,
        h.frame_index_offset,
        h.chunk_pool_offset,
        int(h.compress_algo),
        h.compress_level,
    )
    out[:52] = head
    # endian_tag 在小端文件里读到的是 0x55AA,即字节 AA 55 的小端解释
    out[4:6] = struct.pack("<H", 0xAA55)
    for i, u in enumerate(reader.unis):
        off = h.universe_desc_offset + i * 16
        out[off : off + 8] = struct.pack("<HHHH", u.net, u.subuni, u.universe, u.dmx_len)
    for i, e in enumerate(reader.index):
        off = h.frame_index_offset + i * 16
        out[off : off + 16] = struct.pack("<QIHH", e.time_us, e.chunk_pos, e.chunk_cmp_len, 0)
        cpos = h.chunk_pool_offset + e.chunk_pos
        ctype = int.from_bytes(data[cpos : cpos + 2], "big")
        raw_sz = int.from_bytes(data[cpos + 2 : cpos + 4], "big")
        cmp_sz = int.from_bytes(data[cpos + 4 : cpos + 6], "big")
        crc = int.from_bytes(data[cpos + 6 : cpos + 8], "big")
        out[cpos : cpos + 8] = struct.pack("<HHHH", ctype, raw_sz, cmp_sz, crc)
    return bytes(out)


def test_little_endian_file_is_read():
    le = to_little_endian(write_sample(Compress.NONE))
    # 头部 endian_tag 字节是 55 AA(小端存放 0xAA55),读取端按 0x55AA 判为小端
    assert le[4:6] == b"\x55\xaa"
    reader = ArtRecReader(le)
    frames = [(t, [bytes(b) for b in bufs]) for t, bufs in reader.iter_frames()]
    assert frames == [(0, f0()), (1000, frame1()), (2500, f2())]


def test_open_from_path(tmp_path):
    path = tmp_path / "x.artrec"
    path.write_bytes(write_sample())
    assert ArtRecReader.open(str(path)).header.frame_count == 3
    with pytest.raises(OSError):
        ArtRecReader.open(str(tmp_path / "missing.artrec"))
