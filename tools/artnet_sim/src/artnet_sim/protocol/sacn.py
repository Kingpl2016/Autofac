"""sACN(ANSI E1.31)数据包编解码(基础集:数据包与 Stream_Terminated)。

偏移与 Rust 工程 ``artnet-net`` 的 ``sacn.rs`` 完全一致:

======  ====================================================
偏移    字段
======  ====================================================
0..38   Root 层(Preamble、Postamble、ACN PID、flags+长度、向量、CID)
38..115 Framing 层(flags+长度、向量、源名称 64 字节、优先级、同步地址、序号、Options、Universe)
115..126 DMP 层(flags+长度、向量、地址类型、首地址、地址增量、属性数、START Code)
126..   通道数据
======  ====================================================
"""

from __future__ import annotations

import struct
import uuid
from dataclasses import dataclass

from artnet_sim.protocol.common import MAX_CHANNELS

#: ACN 包标识符 ``"ASC-E1.17\0\0\0"``。
ACN_PID = b"ASC-E1.17\x00\x00\x00"

#: Root 层向量:E1.31 数据包(同步包与 Discovery 包使用 ``VECTOR_ROOT_E131_EXTENDED``)。
VECTOR_ROOT_E131_DATA = 0x00000004

#: Framing 层向量:数据包。
VECTOR_E131_DATA_PACKET = 0x00000002

#: DMP 层向量:Set Property。
VECTOR_DMP_SET_PROPERTY = 0x02

#: Options 位:预览数据。
OPT_PREVIEW = 0x80

#: Options 位:Stream_Terminated,源已停止发送该 Universe。
OPT_STREAM_TERMINATED = 0x40

#: Options 位:强制同步。
OPT_FORCE_SYNC = 0x20

#: 源名称字段长度。
SOURCE_NAME_LEN = 64

#: 通道数据起始偏移,也是 0 通道时的报文长度。
DATA_OFFSET = 126

#: 报文最大长度(126 + 512)。
SACN_MAX_LEN = DATA_OFFSET + MAX_CHANNELS

#: 默认优先级。
DEFAULT_PRIORITY = 100

#: 优先级有效范围上限。
MAX_PRIORITY = 200

_SOURCE_NAME_OFFSET = 44
_PRIORITY_OFFSET = 108
_SYNC_OFFSET = 109
_SEQUENCE_OFFSET = 111
_OPTIONS_OFFSET = 112
_UNIVERSE_OFFSET = 113


@dataclass(frozen=True, slots=True)
class SacnData:
    """解析出的 sACN 数据包。

    Attributes:
        universe: Universe 编号。
        priority: 优先级,0~200。
        sequence: 序号。
        options: Framing 层 Options 字节。
        sync_address: 同步地址,0 表示不同步。
        source_name: 源名称(UTF-8,截断到第一个 NUL)。
        cid: 发送者 CID,16 字节。
        start_code: DMP 层 START Code,DMX 数据为 0。
        data: 通道数据(不含 START Code)。
    """

    universe: int
    priority: int
    sequence: int
    options: int
    sync_address: int
    source_name: str
    cid: bytes
    start_code: int
    data: bytes

    @property
    def terminated(self) -> bool:
        """该包是否带有 Stream_Terminated 标志。"""
        return bool(self.options & OPT_STREAM_TERMINATED)

    @property
    def preview(self) -> bool:
        """该包是否为预览数据。"""
        return bool(self.options & OPT_PREVIEW)


def new_cid() -> bytes:
    """生成随机 CID(UUID v4 的 16 字节)。

    Returns:
        16 字节 CID。
    """
    return uuid.uuid4().bytes


def is_sacn(buf: bytes) -> bool:
    """判断缓冲是否带有合法的 ACN Root 层标识。

    Args:
        buf: UDP 载荷。

    Returns:
        Root 层标识匹配返回 ``True``。
    """
    return len(buf) >= 38 and buf[4:16] == ACN_PID


def _flags_len(length: int) -> bytes:
    """合成 PDU 的 flags+length 字段(高 4 位恒为 ``0x7``)。"""
    return struct.pack(">H", 0x7000 | (length & 0x0FFF))


def build_data(
    universe: int,
    data: bytes | bytearray,
    cid: bytes,
    source_name: str = "artnet-sim",
    priority: int = DEFAULT_PRIORITY,
    sequence: int = 0,
    options: int = 0,
    sync_address: int = 0,
) -> bytes:
    """构造 E1.31 数据包。

    Args:
        universe: Universe 编号,1~63999。
        data: 通道数据(不含 START Code),超过 512 字节会被截断。
        cid: 发送者 CID,16 字节。
        source_name: 源名称,UTF-8 编码后截断到 63 字节,其余以 NUL 补齐。
        priority: 优先级,0~200。
        sequence: 序号,0~255。
        options: Framing 层 Options 字节。
        sync_address: 同步地址,0 表示不同步。

    Returns:
        完整的 sACN 数据包。

    Raises:
        ValueError: 参数超出范围或 ``cid`` 长度不是 16。
    """
    if len(cid) != 16:
        raise ValueError(f"CID 必须为 16 字节,实际 {len(cid)}")
    if not 1 <= universe <= 0xFFFF:
        raise ValueError(f"Universe 超出范围: {universe}")
    if not 0 <= priority <= MAX_PRIORITY:
        raise ValueError(f"优先级超出范围 0~{MAX_PRIORITY}: {priority}")
    if not 0 <= sequence <= 0xFF:
        raise ValueError(f"序号超出范围 0~255: {sequence}")
    if not 0 <= options <= 0xFF:
        raise ValueError(f"options 超出范围 0~255: {options}")
    if not 0 <= sync_address <= 0xFFFF:
        raise ValueError(f"同步地址超出范围 0~65535: {sync_address}")

    channels = bytes(data[:MAX_CHANNELS])
    n = len(channels)
    dmp_len = 10 + 1 + n
    framing_len = 77 + dmp_len
    root_len = 22 + framing_len

    name = source_name.encode("utf-8")[: SOURCE_NAME_LEN - 1].ljust(SOURCE_NAME_LEN, b"\x00")

    root = (
        b"\x00\x10\x00\x00"
        + ACN_PID
        + _flags_len(root_len)
        + struct.pack(">I", VECTOR_ROOT_E131_DATA)
        + cid
    )
    framing = (
        _flags_len(framing_len)
        + struct.pack(">I", VECTOR_E131_DATA_PACKET)
        + name
        + bytes((priority,))
        + struct.pack(">H", sync_address)
        + bytes((sequence, options))
        + struct.pack(">H", universe)
    )
    dmp = (
        _flags_len(dmp_len)
        + bytes((VECTOR_DMP_SET_PROPERTY, 0xA1))
        + struct.pack(">HHH", 0, 1, n + 1)
        + b"\x00"
    )
    return root + framing + dmp + channels


def build_terminated(
    universe: int,
    data: bytes | bytearray,
    cid: bytes,
    source_name: str = "artnet-sim",
    priority: int = DEFAULT_PRIORITY,
    sequence: int = 0,
) -> bytes:
    """构造带 Stream_Terminated 标志的数据包。

    源停止发送某个 Universe 时发出,规范建议连发 3 次。

    Args:
        universe: Universe 编号。
        data: 通道数据(不含 START Code)。
        cid: 发送者 CID,16 字节。
        source_name: 源名称。
        priority: 优先级,0~200。
        sequence: 序号,0~255。

    Returns:
        完整的 sACN 数据包。
    """
    return build_data(
        universe, data, cid, source_name, priority, sequence, options=OPT_STREAM_TERMINATED
    )


def parse_data(buf: bytes) -> SacnData | None:
    """解析 E1.31 数据包。

    接受规则与 Rust 端一致:Root 向量为 ``0x4``、Framing 向量为 ``0x2``、
    DMP 向量为 ``0x2``,且报文长度足够容纳声明的属性数。

    Args:
        buf: UDP 载荷。

    Returns:
        解析结果;不是数据包或长度不足时返回 ``None``。
    """
    if not is_sacn(buf) or len(buf) < DATA_OFFSET:
        return None
    if int.from_bytes(buf[18:22], "big") != VECTOR_ROOT_E131_DATA:
        return None
    if int.from_bytes(buf[40:44], "big") != VECTOR_E131_DATA_PACKET:
        return None
    if buf[117] != VECTOR_DMP_SET_PROPERTY:
        return None
    prop_count = int.from_bytes(buf[123:125], "big")
    if prop_count == 0 or len(buf) < 125 + prop_count:
        return None
    raw_name = bytes(buf[_SOURCE_NAME_OFFSET : _SOURCE_NAME_OFFSET + SOURCE_NAME_LEN])
    name = raw_name.split(b"\x00", 1)[0].decode("utf-8", errors="replace")
    return SacnData(
        universe=int.from_bytes(buf[_UNIVERSE_OFFSET : _UNIVERSE_OFFSET + 2], "big"),
        priority=buf[_PRIORITY_OFFSET],
        sequence=buf[_SEQUENCE_OFFSET],
        options=buf[_OPTIONS_OFFSET],
        sync_address=int.from_bytes(buf[_SYNC_OFFSET : _SYNC_OFFSET + 2], "big"),
        source_name=name,
        cid=bytes(buf[22:38]),
        start_code=buf[125],
        data=bytes(buf[126 : 125 + prop_count]),
    )


# ---------------------------------------------------------------------------
# 扩展包:同步包与 Universe Discovery 包(ANSI E1.31-2018 Appendix A / Table 4-2、4-3)
# ---------------------------------------------------------------------------

#: Root 层向量:E1.31 扩展包(同步包与 Discovery 包)。注意与数据包的 ``0x4`` 不同。
VECTOR_ROOT_E131_EXTENDED = 0x00000008

#: Framing 层向量:同步包。
VECTOR_E131_EXTENDED_SYNCHRONIZATION = 0x00000001

#: Framing 层向量:Universe Discovery 包。
VECTOR_E131_EXTENDED_DISCOVERY = 0x00000002

#: Universe Discovery 层向量:Universe 列表。
VECTOR_UNIVERSE_DISCOVERY_UNIVERSE_LIST = 0x00000001

#: 同步包总长度。
SYNC_PACKET_LEN = 49

#: Discovery 包固定部分长度(不含 Universe 列表)。
DISCOVERY_HEADER_LEN = 120

#: 单页 Discovery 包最多容纳的 Universe 数。
DISCOVERY_MAX_UNIVERSES_PER_PAGE = 512

#: 源发送 Discovery 包的周期(秒)。
DISCOVERY_INTERVAL_S = 10.0

#: 数据丢失判定超时(秒)。接收端在此时间内收不到某源的数据即视为该源已丢失。
NETWORK_DATA_LOSS_TIMEOUT_S = 2.5


@dataclass(frozen=True, slots=True)
class SacnSync:
    """解析出的同步包。

    Attributes:
        sequence: 序号。
        sync_address: 被同步的同步地址(Universe 编号)。
        cid: 发送者 CID。
    """

    sequence: int
    sync_address: int
    cid: bytes


@dataclass(frozen=True, slots=True)
class SacnDiscovery:
    """解析出的 Universe Discovery 包(一页)。

    Attributes:
        source_name: 源名称。
        cid: 发送者 CID。
        page: 当前页号,从 0 起。
        last_page: 最后一页的页号。
        universes: 本页列出的 Universe,升序。
    """

    source_name: str
    cid: bytes
    page: int
    last_page: int
    universes: tuple[int, ...]


def packet_kind(buf: bytes) -> str | None:
    """根据 Root / Framing 向量判断 sACN 报文种类。

    Args:
        buf: UDP 载荷。

    Returns:
        ``"data"``、``"sync"``、``"discovery"``;无法判定时返回 ``None``。
    """
    if not is_sacn(buf) or len(buf) < 44:
        return None
    root_vector = int.from_bytes(buf[18:22], "big")
    framing_vector = int.from_bytes(buf[40:44], "big")
    if root_vector == VECTOR_ROOT_E131_DATA and framing_vector == VECTOR_E131_DATA_PACKET:
        return "data"
    if root_vector == VECTOR_ROOT_E131_EXTENDED:
        if framing_vector == VECTOR_E131_EXTENDED_SYNCHRONIZATION:
            return "sync"
        if framing_vector == VECTOR_E131_EXTENDED_DISCOVERY:
            return "discovery"
    return None


def _root_layer(pdu_length: int, vector: int, cid: bytes) -> bytes:
    """构造 Root 层(38 字节)。

    Args:
        pdu_length: Root PDU 长度(从 flags+length 字段起算到报文末尾)。
        vector: Root 层向量。
        cid: 发送者 CID。
    """
    return b"\x00\x10\x00\x00" + ACN_PID + _flags_len(pdu_length) + struct.pack(">I", vector) + cid


def build_sync(sync_address: int, cid: bytes, sequence: int = 0) -> bytes:
    """构造 E1.31 同步包(49 字节)。

    同步包应发往 ``sync_address`` 对应 Universe 的组播地址。

    Args:
        sync_address: 同步地址,1~63999。
        cid: 发送者 CID,16 字节。
        sequence: 序号,0~255。

    Returns:
        完整的同步包。

    Raises:
        ValueError: 参数超出范围或 ``cid`` 长度不是 16。
    """
    if len(cid) != 16:
        raise ValueError(f"CID 必须为 16 字节,实际 {len(cid)}")
    if not 1 <= sync_address <= 63999:
        raise ValueError(f"同步地址超出范围 1~63999: {sync_address}")
    if not 0 <= sequence <= 0xFF:
        raise ValueError(f"序号超出范围 0~255: {sequence}")
    framing = (
        _flags_len(11)
        + struct.pack(">I", VECTOR_E131_EXTENDED_SYNCHRONIZATION)
        + bytes((sequence,))
        + struct.pack(">H", sync_address)
        + b"\x00\x00"
    )
    return _root_layer(22 + len(framing), VECTOR_ROOT_E131_EXTENDED, cid) + framing


def parse_sync(buf: bytes) -> SacnSync | None:
    """解析 E1.31 同步包。

    Args:
        buf: UDP 载荷。

    Returns:
        解析结果;不是同步包或长度不足 49 字节时返回 ``None``。
    """
    if packet_kind(buf) != "sync" or len(buf) < SYNC_PACKET_LEN:
        return None
    return SacnSync(
        sequence=buf[44],
        sync_address=int.from_bytes(buf[45:47], "big"),
        cid=bytes(buf[22:38]),
    )


def build_discovery(
    cid: bytes,
    universes: list[int] | tuple[int, ...],
    source_name: str = "artnet-sim",
) -> list[bytes]:
    """构造 Universe Discovery 包,必要时自动分页。

    Discovery 包发往保留 Universe 64214 的组播地址(``239.255.250.214``),规范建议
    每 10 秒发送一次。Universe 列表会去重并升序排列,每页最多 512 个。

    Args:
        cid: 发送者 CID,16 字节。
        universes: 该源正在发送的 Universe 列表。
        source_name: 源名称,最多 63 字节 UTF-8。

    Returns:
        每页一个报文的列表;``universes`` 为空时仍返回一页空列表。

    Raises:
        ValueError: ``cid`` 长度不是 16、Universe 超出 1~63999,或分页数超过 256。
    """
    if len(cid) != 16:
        raise ValueError(f"CID 必须为 16 字节,实际 {len(cid)}")
    ordered = sorted(set(universes))
    for u in ordered:
        if not 1 <= u <= 63999:
            raise ValueError(f"Universe 超出范围 1~63999: {u}")
    per_page = DISCOVERY_MAX_UNIVERSES_PER_PAGE
    pages = [ordered[i : i + per_page] for i in range(0, len(ordered), per_page)] or [[]]
    if len(pages) > 256:
        raise ValueError(f"Universe 过多,分页数 {len(pages)} 超过 256")
    name = source_name.encode("utf-8")[: SOURCE_NAME_LEN - 1].ljust(SOURCE_NAME_LEN, b"\x00")
    last_page = len(pages) - 1
    packets: list[bytes] = []
    for page_no, page in enumerate(pages):
        listing = b"".join(struct.pack(">H", u) for u in page)
        disc_layer = (
            _flags_len(8 + len(listing))
            + struct.pack(">I", VECTOR_UNIVERSE_DISCOVERY_UNIVERSE_LIST)
            + bytes((page_no, last_page))
            + listing
        )
        framing = (
            _flags_len(74 + len(disc_layer))
            + struct.pack(">I", VECTOR_E131_EXTENDED_DISCOVERY)
            + name
            + b"\x00\x00\x00\x00"
            + disc_layer
        )
        packets.append(_root_layer(22 + len(framing), VECTOR_ROOT_E131_EXTENDED, cid) + framing)
    return packets


def parse_discovery(buf: bytes) -> SacnDiscovery | None:
    """解析 Universe Discovery 包(一页)。

    Args:
        buf: UDP 载荷。

    Returns:
        解析结果;不是 Discovery 包、长度不足、列表长度与声明不符,或 Universe 列表
        不是严格升序时返回 ``None``。
    """
    if packet_kind(buf) != "discovery" or len(buf) < DISCOVERY_HEADER_LEN:
        return None
    if int.from_bytes(buf[114:118], "big") != VECTOR_UNIVERSE_DISCOVERY_UNIVERSE_LIST:
        return None
    layer_len = int.from_bytes(buf[112:114], "big") & 0x0FFF
    count = (layer_len - 8) // 2
    if layer_len < 8 or (layer_len - 8) % 2 or len(buf) < 112 + layer_len:
        return None
    universes = tuple(
        int.from_bytes(buf[DISCOVERY_HEADER_LEN + 2 * i : DISCOVERY_HEADER_LEN + 2 * i + 2], "big")
        for i in range(count)
    )
    if any(a >= b for a, b in zip(universes, universes[1:], strict=False)):
        return None
    raw_name = bytes(buf[44:108])
    return SacnDiscovery(
        source_name=raw_name.split(b"\x00", 1)[0].decode("utf-8", errors="replace"),
        cid=bytes(buf[22:38]),
        page=buf[118],
        last_page=buf[119],
        universes=universes,
    )
