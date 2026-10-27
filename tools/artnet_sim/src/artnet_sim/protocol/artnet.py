"""Art-Net 数据包编解码(基础集:ArtDmx、ArtPoll)。

字节布局与 Rust 工程 ``artnet-net`` 保持一致:

- 报文以 ``"Art-Net\\0"`` 开头,随后 OpCode(小端)。
- ArtDmx 固定头 18 字节:ID(8) OpCode(2) ProtVer(2,大端) Sequence(1) Physical(1)
  Port-Address(2,小端) Length(2,大端),其后是通道数据。
- ArtDmx 的数据长度必须为偶数,构造时不足补 0。
"""

from __future__ import annotations

import struct
from collections.abc import Iterable
from dataclasses import dataclass
from enum import IntEnum

from artnet_sim.protocol.common import MAX_CHANNELS, MAX_PORT_ADDRESS

#: 报文头标识 ``Art-Net\0``。
ARTNET_ID = b"Art-Net\x00"

#: 协议版本(14),高字节在前。
PROTOCOL_VERSION = (0, 14)

#: ArtDmx 固定头长度。
ARTDMX_HEADER_LEN = 18

#: ArtDmx 报文最大长度。
ARTDMX_MAX_LEN = ARTDMX_HEADER_LEN + MAX_CHANNELS

#: ArtPoll 最小报文长度。
ARTPOLL_LEN = 14


class OpCode(IntEnum):
    """Art-Net OpCode(报文中按小端存放)。"""

    POLL = 0x2000
    POLL_REPLY = 0x2100
    DMX = 0x5000
    NZS = 0x5100
    SYNC = 0x5200
    ADDRESS = 0x6000
    TIME_CODE = 0x9700


@dataclass(frozen=True, slots=True)
class ArtDmx:
    """解析出的 ArtDmx 报文。

    Attributes:
        port_address: 15 位 Port-Address。
        sequence: 序号,0 表示不启用序号。
        physical: 来源物理端口。
        data: 通道数据(报文头之后的全部字节)。
        declared_length: 报文头里声明的数据长度,可能与 ``len(data)`` 不一致。
        protocol_version: 报文头里声明的协议版本。
    """

    port_address: int
    sequence: int
    physical: int
    data: bytes
    declared_length: int
    protocol_version: int


#: ArtPoll Flags 位 1:节点状态变化时主动发送 ArtPollReply。
POLL_FLAG_REPLY_ON_CHANGE = 0x02

#: ArtPoll Flags 位 5:启用 Targeted Mode,只有订阅了范围内 Port-Address 的节点才回复。
POLL_FLAG_TARGETED = 0x20

#: 带 Targeted Mode 范围字段的 ArtPoll 长度。
ARTPOLL_TARGETED_LEN = 18


@dataclass(frozen=True, slots=True)
class ArtPoll:
    """解析出的 ArtPoll 报文。

    Attributes:
        flags: TalkToMe 标志位。
        diag_priority: 诊断消息的最低优先级。
        protocol_version: 报文头里声明的协议版本。
        target_top: Targeted Mode 范围上限(含),报文过短时为 0。
        target_bottom: Targeted Mode 范围下限(含),报文过短时为 0。
    """

    flags: int
    diag_priority: int
    protocol_version: int
    target_top: int = 0
    target_bottom: int = 0

    @property
    def targeted(self) -> bool:
        """是否启用了 Targeted Mode。"""
        return bool(self.flags & POLL_FLAG_TARGETED)

    @property
    def reply_on_change(self) -> bool:
        """发送方是否要求节点状态变化时主动回复。"""
        return bool(self.flags & POLL_FLAG_REPLY_ON_CHANGE)

    def wants(self, port_addresses: Iterable[int]) -> bool:
        """节点(订阅了 ``port_addresses``)是否应当回复这个 ArtPoll。

        Args:
            port_addresses: 节点订阅的全部 Port-Address。

        Returns:
            未启用 Targeted Mode 时恒为 ``True``;启用时,只要有一个地址落在
            ``[target_bottom, target_top]`` 内就为 ``True``。
        """
        if not self.targeted:
            return True
        return any(self.target_bottom <= pa <= self.target_top for pa in port_addresses)


def opcode_of(buf: bytes) -> int | None:
    """读取 Art-Net 报文的 OpCode。

    Args:
        buf: UDP 载荷。

    Returns:
        OpCode 数值;报文过短或不是 Art-Net 时返回 ``None``。
    """
    if len(buf) < 10 or buf[:8] != ARTNET_ID:
        return None
    return int.from_bytes(buf[8:10], "little")


def is_artnet(buf: bytes) -> bool:
    """判断缓冲是否以 Art-Net 报文头开头。

    Args:
        buf: UDP 载荷。

    Returns:
        是 Art-Net 报文返回 ``True``。
    """
    return opcode_of(buf) is not None


def build_dmx(port_address: int, sequence: int, data: bytes | bytearray) -> bytes:
    """构造 ArtDmx 报文。

    数据超过 512 字节会被截断,奇数长度末尾补 0。

    Args:
        port_address: 15 位 Port-Address。
        sequence: 序号,0~255,0 表示不启用序号。
        data: 通道数据,不能为空。

    Returns:
        完整的 ArtDmx 报文。

    Raises:
        ValueError: ``port_address`` 超出 15 位、``sequence`` 超出 0~255,或 ``data`` 为空。
    """
    if not 0 <= port_address <= MAX_PORT_ADDRESS:
        raise ValueError(f"Port-Address 超出范围 0~{MAX_PORT_ADDRESS}: {port_address}")
    if not 0 <= sequence <= 0xFF:
        raise ValueError(f"序号超出范围 0~255: {sequence}")
    if not data:
        raise ValueError("ArtDmx 至少需要 1 个通道")
    payload = bytes(data[:MAX_CHANNELS])
    if len(payload) & 1:
        payload += b"\x00"
    header = (
        ARTNET_ID
        + struct.pack("<H", OpCode.DMX)
        + bytes(PROTOCOL_VERSION)
        + bytes((sequence, 0))
        + struct.pack("<H", port_address)
        + struct.pack(">H", len(payload))
    )
    return header + payload


def parse_dmx(buf: bytes) -> ArtDmx | None:
    """解析 ArtDmx 报文。

    接受规则与 Rust 端一致:长度不小于 18 字节,Port-Address 不超过 ``0x7FFF``;
    ``Length`` 字段不做校验,通道数据取偏移 18 起的全部剩余字节。

    Args:
        buf: UDP 载荷。

    Returns:
        解析结果;不是 ArtDmx 或格式不合法时返回 ``None``。
    """
    if opcode_of(buf) != OpCode.DMX or len(buf) < ARTDMX_HEADER_LEN:
        return None
    port_address = int.from_bytes(buf[14:16], "little")
    if port_address > MAX_PORT_ADDRESS:
        return None
    return ArtDmx(
        port_address=port_address,
        sequence=buf[12],
        physical=buf[13],
        data=bytes(buf[ARTDMX_HEADER_LEN:]),
        declared_length=int.from_bytes(buf[16:18], "big"),
        protocol_version=int.from_bytes(buf[10:12], "big"),
    )


def build_poll(
    flags: int = 0x02,
    diag_priority: int = 0x10,
    target: tuple[int, int] | None = None,
) -> bytes:
    """构造 ArtPoll 报文。

    Args:
        flags: TalkToMe 标志位,默认 ``0x02``(节点状态变化时主动回复)。
        diag_priority: 诊断消息最低优先级,默认 ``0x10``(低优先级)。
        target: Targeted Mode 的 ``(下限, 上限)`` Port-Address,含两端。给定时自动置位
            Flags 位 5 并生成 18 字节报文;``None`` 为普通的 14 字节报文。

    Returns:
        完整的 ArtPoll 报文。

    Raises:
        ValueError: ``flags``、``diag_priority`` 超出 0~255,或 ``target`` 范围不合法。
    """
    if not 0 <= flags <= 0xFF:
        raise ValueError(f"flags 超出范围 0~255: {flags}")
    if not 0 <= diag_priority <= 0xFF:
        raise ValueError(f"diag_priority 超出范围 0~255: {diag_priority}")
    head = ARTNET_ID + struct.pack("<H", OpCode.POLL) + bytes(PROTOCOL_VERSION)
    if target is None:
        return head + bytes((flags, diag_priority))
    bottom, top = target
    if not 0 <= bottom <= top <= MAX_PORT_ADDRESS:
        raise ValueError(f"Targeted 范围不合法: {target}")
    return (
        head + bytes((flags | POLL_FLAG_TARGETED, diag_priority)) + struct.pack(">HH", top, bottom)
    )


def parse_poll(buf: bytes) -> ArtPoll | None:
    """解析 ArtPoll 报文。

    Args:
        buf: UDP 载荷。

    Returns:
        解析结果;不是 ArtPoll 或长度不足 14 字节时返回 ``None``。长度不足 18 字节时,
        Targeted Mode 的范围字段按 0 处理。
    """
    if opcode_of(buf) != OpCode.POLL or len(buf) < ARTPOLL_LEN:
        return None
    top = bottom = 0
    if len(buf) >= ARTPOLL_TARGETED_LEN:
        top = int.from_bytes(buf[14:16], "big")
        bottom = int.from_bytes(buf[16:18], "big")
    return ArtPoll(
        flags=buf[12],
        diag_priority=buf[13],
        protocol_version=int.from_bytes(buf[10:12], "big"),
        target_top=top,
        target_bottom=bottom,
    )
