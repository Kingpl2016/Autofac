"""``.artrec`` 灯光节目文件的读写。

以 Art-Net Studio 的 Rust 实现(``artrec-core``)为准,与《ArtRec 灯光节目录制文件规范 v1.0》
有出入的地方都按 Rust 实现处理:

- 文件头固定 64 字节(规范里的 C 结构体含 ``reserved[34]``,实际 88 字节,与正文矛盾)。
- 物理排布为 A(文件头) → B(Universe 描述表) → D(Chunk 池) → C(帧索引表)。帧索引的长度
  在录制结束前未知,所以放在 D 区之后;各分区位置全部由文件头里的偏移字段指明。
- Chunk 的 CRC16 对**解压前的原始 Payload** 计算,算法是 CRC-16/CCITT-FALSE。
- 每个 Chunk 是一个独立的标准 Zstd 帧,帧头不写原始大小、不带校验和、不用字典。

格式限制(超出时写入器直接报错,不做静默截断):

- Universe 编号 ≤ 2047(``net`` 0~127、``subuni`` 0~15)。
- 单帧全量 Payload ≤ 65527 字节(约 127 路 512 通道)。
- 文件 ≤ 4 GiB(偏移字段是 u32)。
"""

from __future__ import annotations

import binascii
import struct
from bisect import bisect_right
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from enum import IntEnum
from typing import BinaryIO

import zstandard

MAGIC = b"ARTR"
ENDIAN_TAG_BE = 0xAA55
ENDIAN_TAG_LE = 0x55AA
HEADER_SIZE = 64
UNIDESC_SIZE = 16
FRAMEINDEX_SIZE = 16
CHUNKHDR_SIZE = 8
VER_MAJOR = 1
VER_MINOR = 0
SUPPORTED_MAJOR = 1

MAX_NET = 127
MAX_UNIVERSE = MAX_NET * 16 + 15  # 2047
MAX_CHUNK_BYTES = 0xFFFF
MAX_FULL_PAYLOAD = MAX_CHUNK_BYTES - CHUNKHDR_SIZE  # 65527
MAX_DIFF_CHANGES = (MAX_FULL_PAYLOAD - 2) // 5
MAX_FILE_BYTES = 0xFFFFFFFF

FLAG_LOOP = 1 << 0
FLAG_SMPTE = 1 << 1
FLAG_DIFF_FRAME = 1 << 2

CHUNK_FULL = 0
CHUNK_DIFF = 1


class Compress(IntEnum):
    """压缩算法。"""

    NONE = 0
    ZSTD = 1


class ArtRecError(ValueError):
    """``.artrec`` 读写错误的基类。"""


class ArtRecFormatError(ArtRecError):
    """文件格式不合法(魔数、版本、截断、索引乱序等)。"""


class ArtRecCrcError(ArtRecError):
    """Chunk 的 CRC16 校验失败。"""


def crc16_ccitt(data: bytes | memoryview) -> int:
    """CRC-16/CCITT-FALSE(多项式 0x1021,初值 0xFFFF,不反转,无异或输出)。

    Args:
        data: 要校验的字节。

    Returns:
        16 位校验值。
    """
    return binascii.crc_hqx(data, 0xFFFF)


@dataclass(frozen=True, slots=True)
class UniDesc:
    """B 区的一条 Universe 描述。

    Attributes:
        net: Art-Net Net,0~127。
        subuni: Art-Net SubUni,0~15。
        universe: 完整 Universe 编号 = ``net * 16 + subuni``。
        dmx_len: 该 Universe 的通道数(支持短帧)。
    """

    net: int
    subuni: int
    universe: int
    dmx_len: int

    @classmethod
    def from_universe(cls, universe: int, dmx_len: int = 512) -> UniDesc:
        """由线性 Universe 编号构造。

        Args:
            universe: Universe 编号,0~2047。
            dmx_len: 通道数,1~512。

        Returns:
            描述对象。

        Raises:
            ArtRecError: 编号或通道数超出范围。
        """
        if not 0 <= universe <= MAX_UNIVERSE:
            raise ArtRecError(f"Universe {universe} 超出 .artrec 可表示的范围 0~{MAX_UNIVERSE}")
        if not 1 <= dmx_len <= 512:
            raise ArtRecError(f"dmx_len 必须在 1~512,实际 {dmx_len}")
        return cls(universe // 16, universe % 16, universe, dmx_len)

    def to_bytes(self) -> bytes:
        """序列化为 16 字节(大端,后 8 字节为保留区)。"""
        return struct.pack(">HHHH", self.net, self.subuni, self.universe, self.dmx_len).ljust(
            UNIDESC_SIZE, b"\x00"
        )


@dataclass(frozen=True, slots=True)
class FrameIndex:
    """C 区的一条帧索引。

    Attributes:
        time_us: 相对节目起点的时间戳(微秒)。
        chunk_pos: Chunk 在 D 区内的相对偏移。
        chunk_cmp_len: Chunk 总字节数(块头 + 压缩后的 Payload)。
    """

    time_us: int
    chunk_pos: int
    chunk_cmp_len: int

    def to_bytes(self) -> bytes:
        """序列化为 16 字节(大端)。"""
        return struct.pack(">QIHH", self.time_us, self.chunk_pos, self.chunk_cmp_len, 0)


@dataclass(frozen=True, slots=True)
class ChunkHdr:
    """D 区的 Chunk 块头。

    Attributes:
        chunk_type: 0 全量帧,1 差分帧。
        payload_raw_sz: 解压后的 Payload 字节数。
        payload_cmp_sz: 压缩后的 Payload 字节数(不含块头)。
        crc16: 原始 Payload 的 CRC16。
    """

    chunk_type: int
    payload_raw_sz: int
    payload_cmp_sz: int
    crc16: int

    def to_bytes(self) -> bytes:
        """序列化为 8 字节(大端)。"""
        return struct.pack(
            ">HHHH", self.chunk_type, self.payload_raw_sz, self.payload_cmp_sz, self.crc16
        )


@dataclass(frozen=True, slots=True)
class FileHeader:
    """A 区文件头(64 字节)。

    Attributes:
        flags: 全局标志位。
        rec_start_us: 录制开始的 Unix 时间(微秒)。
        total_duration_us: 节目总时长(微秒)。
        universe_count: Universe 描述条数。
        frame_count: 帧索引条数。
        universe_desc_offset: B 区偏移。
        frame_index_offset: C 区偏移。
        chunk_pool_offset: D 区偏移。
        compress_algo: 压缩算法。
        compress_level: Zstd 等级。
        ver_major: 主版本。
        ver_minor: 次版本。
    """

    flags: int
    rec_start_us: int
    total_duration_us: int
    universe_count: int
    frame_count: int
    universe_desc_offset: int
    frame_index_offset: int
    chunk_pool_offset: int
    compress_algo: Compress
    compress_level: int
    ver_major: int = VER_MAJOR
    ver_minor: int = VER_MINOR

    def to_bytes(self) -> bytes:
        """序列化为固定 64 字节(大端,保留区为 0)。"""
        head = struct.pack(
            ">4sHHHIQQIIIIIBB",
            MAGIC,
            ENDIAN_TAG_BE,
            self.ver_major,
            self.ver_minor,
            self.flags,
            self.rec_start_us,
            self.total_duration_us,
            self.universe_count,
            self.frame_count,
            self.universe_desc_offset,
            self.frame_index_offset,
            self.chunk_pool_offset,
            int(self.compress_algo),
            self.compress_level,
        )
        return head.ljust(HEADER_SIZE, b"\x00")

    @property
    def allows_diff(self) -> bool:
        """是否允许出现差分帧。"""
        return bool(self.flags & FLAG_DIFF_FRAME)

    @property
    def loop_play(self) -> bool:
        """是否推荐循环播放。"""
        return bool(self.flags & FLAG_LOOP)

    @classmethod
    def from_bytes(cls, buf: bytes | memoryview) -> tuple[FileHeader, str]:
        """解析文件头并判定字节序。

        Args:
            buf: 至少 52 字节。

        Returns:
            ``(文件头, 字节序前缀)``,字节序前缀是 ``">"`` 或 ``"<"``。

        Raises:
            ArtRecFormatError: 魔数、字节序标记、版本或压缩算法不合法,或数据过短。
        """
        if len(buf) < 52:
            raise ArtRecFormatError("文件头不足 52 字节")
        if bytes(buf[:4]) != MAGIC:
            raise ArtRecFormatError(f"魔数不对: {bytes(buf[:4])!r}")
        tag = struct.unpack(">H", buf[4:6])[0]
        if tag == ENDIAN_TAG_BE:
            order = ">"
        elif tag == ENDIAN_TAG_LE:
            order = "<"
        else:
            raise ArtRecFormatError(f"字节序标记不合法: 0x{tag:04X}")
        fields = struct.unpack(f"{order}HHIQQIIIIIBB", bytes(buf[6:52]))
        major, minor, flags, start, duration = fields[:5]
        uni_count, frame_count, uni_off, idx_off, pool_off, algo, level = fields[5:]
        if major > SUPPORTED_MAJOR:
            raise ArtRecFormatError(f"文件主版本 {major} 高于支持的 {SUPPORTED_MAJOR}")
        try:
            compress = Compress(algo)
        except ValueError:
            raise ArtRecFormatError(f"未知的压缩算法: {algo}") from None
        header = cls(
            flags,
            start,
            duration,
            uni_count,
            frame_count,
            uni_off,
            idx_off,
            pool_off,
            compress,
            level,
            major,
            minor,
        )
        return header, order


@dataclass(frozen=True, slots=True)
class DiffChange:
    """差分帧里的一个变更点。

    Attributes:
        uni_idx: Universe 在描述表里的下标。
        ch_addr: 通道地址,0~511。
        ch_val: 新数值。
    """

    uni_idx: int
    ch_addr: int
    ch_val: int


def encode_diff(changes: Sequence[DiffChange]) -> bytes:
    """编码差分帧的 Payload(``u16 数量`` + N × 5 字节)。

    Args:
        changes: 变更点列表。

    Returns:
        原始 Payload。
    """
    out = bytearray(struct.pack(">H", len(changes)))
    for c in changes:
        out += struct.pack(">HHB", c.uni_idx, c.ch_addr, c.ch_val)
    return bytes(out)


def decode_diff(payload: bytes) -> list[DiffChange]:
    """解码差分帧的 Payload。

    Args:
        payload: 原始 Payload。

    Returns:
        变更点列表。

    Raises:
        ArtRecFormatError: 长度与声明的条数不符。
    """
    if len(payload) < 2:
        raise ArtRecFormatError("差分帧缺少 changed_cnt")
    count = struct.unpack(">H", payload[:2])[0]
    if len(payload) < 2 + count * 5:
        raise ArtRecFormatError("差分帧长度不足以容纳声明的变更条数")
    return [
        DiffChange(*struct.unpack(">HHB", payload[2 + i * 5 : 7 + i * 5])) for i in range(count)
    ]


def apply_diff(buffers: list[bytearray], changes: Sequence[DiffChange]) -> None:
    """把差分应用到各路缓冲上,越界的变更点被忽略。

    Args:
        buffers: 各路 DMX 缓冲(就地修改)。
        changes: 变更点列表。
    """
    for c in changes:
        if c.uni_idx < len(buffers) and c.ch_addr < len(buffers[c.uni_idx]):
            buffers[c.uni_idx][c.ch_addr] = c.ch_val


def _validate_unis(unis: Sequence[UniDesc]) -> None:
    """校验描述表:无重复、总长不超过单 Chunk 上限。"""
    seen: set[int] = set()
    for u in unis:
        if u.universe in seen:
            raise ArtRecError(f"Universe {u.universe} 重复")
        seen.add(u.universe)
    total = sum(u.dmx_len for u in unis)
    if total > MAX_FULL_PAYLOAD:
        raise ArtRecError(f"全量帧 Payload {total} 字节超过上限 {MAX_FULL_PAYLOAD}(约 127 路)")


class ArtRecWriter:
    """流式写入器。

    Args:
        fp: 可读写可定位的二进制流(文件或 ``BytesIO``)。
        unis: Universe 描述表,顺序决定 Payload 里各路数据的拼接顺序。
        compress: 压缩算法。
        level: Zstd 压缩等级。
        flags: 全局标志位。
        rec_start_us: 录制开始的 Unix 时间(微秒)。

    Raises:
        ArtRecError: 描述表不合法。
    """

    def __init__(
        self,
        fp: BinaryIO,
        unis: Sequence[UniDesc],
        *,
        compress: Compress = Compress.ZSTD,
        level: int = 3,
        flags: int = 0,
        rec_start_us: int = 0,
    ) -> None:
        _validate_unis(unis)
        self._fp = fp
        self.unis = list(unis)
        self._compress = Compress(compress)
        self._level = level
        self._flags = flags
        self._rec_start_us = rec_start_us
        self._compressor = (
            zstandard.ZstdCompressor(level=level, write_content_size=False, write_checksum=False)
            if self._compress == Compress.ZSTD
            else None
        )
        self._pool_offset = HEADER_SIZE + len(self.unis) * UNIDESC_SIZE
        self._pool_len = 0
        self.index: list[FrameIndex] = []
        fp.seek(0)
        fp.write(self._header(0, 0, 0).to_bytes())
        for u in self.unis:
            fp.write(u.to_bytes())

    def _header(self, duration_us: int, frame_count: int, index_offset: int) -> FileHeader:
        """构造当前状态对应的文件头。"""
        return FileHeader(
            flags=self._flags,
            rec_start_us=self._rec_start_us,
            total_duration_us=duration_us,
            universe_count=len(self.unis),
            frame_count=frame_count,
            universe_desc_offset=HEADER_SIZE,
            frame_index_offset=index_offset,
            chunk_pool_offset=self._pool_offset,
            compress_algo=self._compress,
            compress_level=self._level,
        )

    @property
    def frame_count(self) -> int:
        """已写入的帧数。"""
        return len(self.index)

    @property
    def last_time_us(self) -> int | None:
        """最后一帧的时间戳;还没有帧时为 ``None``。"""
        return self.index[-1].time_us if self.index else None

    @property
    def bytes_written(self) -> int:
        """已占用的字节数(头 + B 区 + Chunk 池,不含尚未写出的索引表)。"""
        return self._pool_offset + self._pool_len

    def add_full_frame(self, time_us: int, buffers: Sequence[bytes | bytearray]) -> FrameIndex:
        """写入一帧全量帧。

        Args:
            time_us: 时间戳(微秒),不能小于上一帧。
            buffers: 与描述表一一对应的各路数据,长度必须等于各自的 ``dmx_len``。

        Returns:
            新追加的索引条目。

        Raises:
            ArtRecError: 路数、长度、时间或体积不合法。
        """
        if len(buffers) != len(self.unis):
            raise ArtRecError(f"需要 {len(self.unis)} 路数据,实际 {len(buffers)}")
        for u, buf in zip(self.unis, buffers, strict=True):
            if len(buf) != u.dmx_len:
                raise ArtRecError(f"Universe {u.universe} 需要 {u.dmx_len} 字节,实际 {len(buf)}")
        return self._write_chunk(CHUNK_FULL, time_us, b"".join(bytes(b) for b in buffers))

    def add_diff_frame(self, time_us: int, changes: Sequence[DiffChange]) -> FrameIndex:
        """写入一帧差分帧(需要 flags 含 ``FLAG_DIFF_FRAME``)。

        Args:
            time_us: 时间戳(微秒)。
            changes: 相对上一帧的变更点。

        Returns:
            新追加的索引条目。

        Raises:
            ArtRecError: 文件头没有声明允许差分帧,或变更点过多。
        """
        if not self._flags & FLAG_DIFF_FRAME:
            raise ArtRecError("文件头未设置 ALLOW_DIFF_FRAME,不能写差分帧")
        if len(changes) > MAX_DIFF_CHANGES:
            raise ArtRecError(f"差分帧变更点过多: {len(changes)} > {MAX_DIFF_CHANGES}")
        return self._write_chunk(CHUNK_DIFF, time_us, encode_diff(changes))

    def _write_chunk(self, chunk_type: int, time_us: int, raw: bytes) -> FrameIndex:
        """压缩并写出一个 Chunk,返回对应的索引条目。"""
        if self.index and time_us < self.index[-1].time_us:
            raise ArtRecError(f"时间戳必须单调不减: {self.index[-1].time_us} → {time_us}")
        if time_us < 0:
            raise ArtRecError("时间戳不能为负")
        packed = self._compressor.compress(raw) if self._compressor else raw
        total = CHUNKHDR_SIZE + len(packed)
        if len(raw) > MAX_CHUNK_BYTES or total > MAX_CHUNK_BYTES:
            raise ArtRecError(f"Chunk 过大: {total} 字节(上限 {MAX_CHUNK_BYTES})")
        end = self.bytes_written + total + (len(self.index) + 1) * FRAMEINDEX_SIZE
        if end > MAX_FILE_BYTES:
            raise ArtRecError("文件将超过 4 GiB(偏移字段是 u32)")
        header = ChunkHdr(chunk_type, len(raw), len(packed), crc16_ccitt(raw))
        self._fp.seek(self._pool_offset + self._pool_len)
        self._fp.write(header.to_bytes())
        self._fp.write(packed)
        entry = FrameIndex(time_us, self._pool_len, total)
        self._pool_len += total
        self.index.append(entry)
        return entry

    def finish(self, total_duration_us: int | None = None) -> None:
        """结束录制:写出帧索引表并回填文件头。

        Args:
            total_duration_us: 节目总时长(微秒);默认取最后一帧的时间戳。
        """
        duration = total_duration_us if total_duration_us is not None else (self.last_time_us or 0)
        if self.index and duration < self.index[-1].time_us:
            raise ArtRecError("total_duration_us 不能小于最后一帧的时间戳")
        index_offset = self._pool_offset + self._pool_len
        self._fp.seek(index_offset)
        for entry in self.index:
            self._fp.write(entry.to_bytes())
        self._fp.seek(0)
        self._fp.write(self._header(duration, len(self.index), index_offset).to_bytes())
        self._fp.flush()


class ArtRecReader:
    """随机访问读取器。把整个文件读进内存,索引表一次性解析。

    Args:
        data: 完整的文件内容。

    Raises:
        ArtRecFormatError: 文件头、描述表或索引表不合法(包括索引时间戳乱序)。
    """

    def __init__(self, data: bytes) -> None:
        self._data = memoryview(data)
        self.header, self._order = FileHeader.from_bytes(self._data[:HEADER_SIZE])
        h = self.header
        size = len(self._data)
        uni_end = h.universe_desc_offset + h.universe_count * UNIDESC_SIZE
        idx_end = h.frame_index_offset + h.frame_count * FRAMEINDEX_SIZE
        if uni_end > size or idx_end > size or h.chunk_pool_offset > size:
            raise ArtRecFormatError("文件被截断:描述表或索引表超出文件末尾")
        self.unis: list[UniDesc] = []
        for i in range(h.universe_count):
            off = h.universe_desc_offset + i * UNIDESC_SIZE
            net, sub, uni, length = struct.unpack(f"{self._order}HHHH", self._data[off : off + 8])
            self.unis.append(UniDesc(net, sub, uni, length))
        self.index: list[FrameIndex] = []
        for i in range(h.frame_count):
            off = h.frame_index_offset + i * FRAMEINDEX_SIZE
            time_us, pos, length, _ = struct.unpack(
                f"{self._order}QIHH", self._data[off : off + FRAMEINDEX_SIZE]
            )
            self.index.append(FrameIndex(time_us, pos, length))
        times = [f.time_us for f in self.index]
        if any(a > b for a, b in zip(times, times[1:], strict=False)):
            raise ArtRecFormatError("帧索引的时间戳不是升序,文件已损坏")
        self._times = times
        self._decompressor = (
            zstandard.ZstdDecompressor() if h.compress_algo == Compress.ZSTD else None
        )

    @classmethod
    def open(cls, path: str) -> ArtRecReader:
        """从文件路径读取。

        Args:
            path: 文件路径。

        Returns:
            读取器。

        Raises:
            ArtRecFormatError: 文件不合法。
            OSError: 文件无法读取。
        """
        with open(path, "rb") as fp:
            return cls(fp.read())

    @property
    def universes(self) -> list[int]:
        """描述表里的 Universe 编号,保持文件里的顺序。"""
        return [u.universe for u in self.unis]

    @property
    def duration_us(self) -> int:
        """节目总时长(微秒)。"""
        return self.header.total_duration_us

    def read_chunk(self, i: int) -> tuple[ChunkHdr, bytes]:
        """读取并校验第 ``i`` 个 Chunk。

        Args:
            i: 帧下标。

        Returns:
            ``(块头, 解压后的原始 Payload)``。

        Raises:
            IndexError: 下标越界。
            ArtRecFormatError: 块头或 Payload 超出文件,或解压失败/长度不符。
            ArtRecCrcError: CRC16 不匹配。
        """
        entry = self.index[i]
        start = self.header.chunk_pool_offset + entry.chunk_pos
        end = start + entry.chunk_cmp_len
        if entry.chunk_cmp_len < CHUNKHDR_SIZE or end > len(self._data):
            raise ArtRecFormatError(f"第 {i} 帧的 Chunk 超出文件范围")
        ctype, raw_sz, cmp_sz, crc = struct.unpack(
            f"{self._order}HHHH", self._data[start : start + CHUNKHDR_SIZE]
        )
        hdr = ChunkHdr(ctype, raw_sz, cmp_sz, crc)
        payload = bytes(self._data[start + CHUNKHDR_SIZE : start + CHUNKHDR_SIZE + cmp_sz])
        if len(payload) != cmp_sz:
            raise ArtRecFormatError(f"第 {i} 帧的 Payload 被截断")
        if self._decompressor is not None:
            try:
                raw = self._decompressor.decompress(payload, max_output_size=max(raw_sz, 1))
            except zstandard.ZstdError as exc:
                raise ArtRecFormatError(f"第 {i} 帧 Zstd 解压失败: {exc}") from exc
        else:
            raw = payload
        if len(raw) != raw_sz:
            raise ArtRecFormatError(f"第 {i} 帧解压得到 {len(raw)} 字节,与块头声明的 {raw_sz} 不符")
        if crc16_ccitt(raw) != crc:
            raise ArtRecCrcError(f"第 {i} 帧 CRC16 不匹配")
        if ctype == CHUNK_DIFF and not self.header.allows_diff:
            raise ArtRecFormatError(f"第 {i} 帧是差分帧,但文件头没有设置 ALLOW_DIFF_FRAME")
        return hdr, raw

    def split_full(self, payload: bytes) -> list[bytearray]:
        """把全量帧 Payload 按描述表切成各路缓冲。

        Args:
            payload: 全量帧的原始 Payload。

        Returns:
            与描述表一一对应的缓冲列表。

        Raises:
            ArtRecFormatError: 总长度与描述表不符。
        """
        total = sum(u.dmx_len for u in self.unis)
        if len(payload) != total:
            raise ArtRecFormatError(f"全量帧 Payload {len(payload)} 字节,描述表要求 {total}")
        out, pos = [], 0
        for u in self.unis:
            out.append(bytearray(payload[pos : pos + u.dmx_len]))
            pos += u.dmx_len
        return out

    def frame_at_time(self, time_us: int) -> int:
        """查找 ``time_us`` 时刻应显示的帧。

        Args:
            time_us: 播放时间(微秒)。

        Returns:
            最大的满足 ``index[i].time_us <= time_us`` 的下标;早于首帧时为 ``-1``。
        """
        return bisect_right(self._times, time_us) - 1

    def buffers_at(self, i: int) -> list[bytearray]:
        """重建第 ``i`` 帧的完整各路缓冲:从最近的全量帧开始依次应用差分帧。

        Args:
            i: 帧下标。

        Returns:
            各路缓冲(新对象,可随意修改)。

        Raises:
            ArtRecFormatError: 往前找不到全量帧(文件损坏)。
        """
        start = i
        while start >= 0 and self.chunk_type(start) != CHUNK_FULL:
            start -= 1
        if start < 0:
            raise ArtRecFormatError(f"第 {i} 帧之前没有全量帧,无法重建画面")
        _hdr, raw = self.read_chunk(start)
        buffers = self.split_full(raw)
        for k in range(start + 1, i + 1):
            _hdr, raw = self.read_chunk(k)
            apply_diff(buffers, decode_diff(raw))
        return buffers

    def chunk_type(self, i: int) -> int:
        """只读块头里的 chunk_type,不解压。"""
        entry = self.index[i]
        start = self.header.chunk_pool_offset + entry.chunk_pos
        if entry.chunk_cmp_len < CHUNKHDR_SIZE or start + CHUNKHDR_SIZE > len(self._data):
            raise ArtRecFormatError(f"第 {i} 帧的 Chunk 超出文件范围")
        return int(struct.unpack(f"{self._order}H", self._data[start : start + 2])[0])

    def iter_frames(self) -> Iterator[tuple[int, list[bytearray]]]:
        """按顺序遍历所有帧,差分帧自动合成为完整画面。

        Yields:
            ``(time_us, 各路缓冲)``;缓冲对象在迭代间被复用,需要保留请自行拷贝。
        """
        buffers: list[bytearray] | None = None
        for i, entry in enumerate(self.index):
            hdr, raw = self.read_chunk(i)
            if hdr.chunk_type == CHUNK_FULL:
                buffers = self.split_full(raw)
            elif buffers is None:
                raise ArtRecFormatError("文件以差分帧开头,无法重建画面")
            else:
                apply_diff(buffers, decode_diff(raw))
            yield entry.time_us, buffers
