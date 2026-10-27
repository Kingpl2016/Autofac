"""发送目标解析:把 ``broadcast`` / ``multicast`` / 具体 IP 统一成 IPv4 地址。"""

from __future__ import annotations

import ipaddress

from artnet_sim.net.interfaces import NetInterface
from artnet_sim.net.policy import is_allowed_target
from artnet_sim.protocol.common import ARTNET_PORT, SACN_PORT, sacn_multicast_addr

#: 目标关键字:所选网卡所在子网的定向广播。
TARGET_BROADCAST = "broadcast"

#: 目标关键字:sACN 按 Universe 计算的组播地址(仅 sACN 可用)。
TARGET_MULTICAST = "multicast"


def default_port(protocol: str) -> int:
    """返回协议的默认 UDP 端口。

    Args:
        protocol: ``artnet`` 或 ``sacn``。

    Returns:
        默认端口号。

    Raises:
        ValueError: 协议名未知。
    """
    if protocol == "artnet":
        return ARTNET_PORT
    if protocol == "sacn":
        return SACN_PORT
    raise ValueError(f"未知协议: {protocol!r}")


def resolve_target(
    protocol: str,
    universe: int,
    target: str,
    interface: NetInterface | None = None,
    *,
    allow_public: bool = False,
) -> str:
    """把目标描述解析为具体的 IPv4 地址,并按策略检查。

    Args:
        protocol: ``artnet`` 或 ``sacn``。
        universe: 本次发送的 Universe(组播地址由它决定)。
        target: ``broadcast``、``multicast`` 或点分十进制 IPv4。
        interface: 出口网卡;``broadcast`` 需要它提供广播地址。
        allow_public: 是否允许公网目标。

    Returns:
        解析后的 IPv4 地址字符串。

    Raises:
        ValueError: 目标无法解析、``multicast`` 用于 Art-Net、``broadcast`` 缺少网卡,
            或目标被策略拒绝(公网地址且未放行)。
    """
    if protocol not in ("artnet", "sacn"):
        raise ValueError(f"未知协议: {protocol!r}")
    keyword = target.strip().lower()
    if keyword == TARGET_BROADCAST:
        if interface is None:
            raise ValueError("使用 broadcast 目标时必须指定网卡")
        address = interface.broadcast
    elif keyword == TARGET_MULTICAST:
        if protocol != "sacn":
            raise ValueError("multicast 目标只适用于 sACN")
        address = sacn_multicast_addr(universe)
    else:
        try:
            address = str(ipaddress.IPv4Address(target.strip()))
        except ValueError:
            raise ValueError(f"无法解析目标地址: {target!r}") from None
    if not is_allowed_target(address, allow_public=allow_public):
        raise ValueError(f"目标 {address} 是公网地址,默认被拒绝;确认无误后请显式允许公网目标")
    return address
