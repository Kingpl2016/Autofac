"""发送目标地址策略:默认只允许向局域网、环回和组播地址发包。

模拟工具能向网络持续发 UDP,误配到公网地址会造成骚扰甚至被运营商限制,所以
默认拒绝公网目标,需要时必须显式放行。
"""

from __future__ import annotations

import ipaddress

#: Art-Net 早期规定的主地址段(2.x.x.x 与 10.x.x.x)。2.0.0.0/8 在通用分类里属于公网,
#: 但在 Art-Net 里是合法的本地网段,因此单独放行。
_ARTNET_NETWORKS = (
    ipaddress.ip_network("2.0.0.0/8"),
    ipaddress.ip_network("10.0.0.0/8"),
)


def is_allowed_target(address: str, *, allow_public: bool = False) -> bool:
    """判断一个发送目标是否允许。

    允许:环回、私有网段(RFC 1918)、链路本地、Art-Net 的 2.x/10.x 网段、
    组播地址、受限广播 ``255.255.255.255``。其余视为公网目标。

    Args:
        address: IPv4 地址字符串。
        allow_public: 为 ``True`` 时放行公网目标。

    Returns:
        允许发送返回 ``True``;地址无法解析返回 ``False``。
    """
    try:
        ip = ipaddress.IPv4Address(address)
    except ValueError:
        return False
    if allow_public:
        return True
    return (
        ip.is_loopback
        or ip.is_private
        or ip.is_link_local
        or ip.is_multicast
        or ip == ipaddress.IPv4Address("255.255.255.255")
        or any(ip in net for net in _ARTNET_NETWORKS)
    )
