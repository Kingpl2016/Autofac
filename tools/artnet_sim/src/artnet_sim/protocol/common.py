"""两种协议共用的常量与地址换算。"""

from __future__ import annotations

import ipaddress

#: 单个 DMX Universe 的最大通道数。
MAX_CHANNELS = 512

#: Art-Net 默认 UDP 端口(0x1936)。
ARTNET_PORT = 6454

#: sACN 默认 UDP 端口。
SACN_PORT = 5568

#: Art-Net 15 位 Port-Address 的上限。
MAX_PORT_ADDRESS = 0x7FFF

#: sACN 数据 Universe 的有效范围。
SACN_MIN_UNIVERSE = 1
SACN_MAX_UNIVERSE = 63999

#: sACN Universe Discovery 使用的保留 Universe。
SACN_DISCOVERY_UNIVERSE = 64214


def port_address(net: int, subnet: int, universe: int) -> int:
    """由 Net(7 位)、SubNet(4 位)、Universe(4 位)合成 15 位 Port-Address。

    Args:
        net: Art-Net Net,0~127。
        subnet: Art-Net SubNet,0~15。
        universe: 低 4 位 Universe,0~15。

    Returns:
        15 位 Port-Address。

    Raises:
        ValueError: 任一分量超出范围。
    """
    if not 0 <= net <= 0x7F:
        raise ValueError(f"net 超出范围 0~127: {net}")
    if not 0 <= subnet <= 0x0F:
        raise ValueError(f"subnet 超出范围 0~15: {subnet}")
    if not 0 <= universe <= 0x0F:
        raise ValueError(f"universe 超出范围 0~15: {universe}")
    return (net << 8) | (subnet << 4) | universe


def split_port_address(value: int) -> tuple[int, int, int]:
    """把 15 位 Port-Address 拆成 (net, subnet, universe)。

    Args:
        value: 15 位 Port-Address。

    Returns:
        ``(net, subnet, universe)`` 三元组。

    Raises:
        ValueError: ``value`` 超出 15 位范围。
    """
    if not 0 <= value <= MAX_PORT_ADDRESS:
        raise ValueError(f"Port-Address 超出范围 0~{MAX_PORT_ADDRESS}: {value}")
    return (value >> 8) & 0x7F, (value >> 4) & 0x0F, value & 0x0F


def sacn_multicast_addr(universe: int) -> str:
    """计算 sACN Universe 对应的 IPv4 组播地址 ``239.255.<hi>.<lo>``。

    Args:
        universe: Universe 编号,1~63999,或保留的 Discovery Universe 64214。

    Returns:
        点分十进制组播地址字符串。

    Raises:
        ValueError: Universe 不在允许范围内。
    """
    if not (
        SACN_MIN_UNIVERSE <= universe <= SACN_MAX_UNIVERSE or universe == SACN_DISCOVERY_UNIVERSE
    ):
        raise ValueError(f"sACN Universe 超出范围 1~{SACN_MAX_UNIVERSE}: {universe}")
    return str(ipaddress.IPv4Address((239 << 24) | (255 << 16) | universe))
