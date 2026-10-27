"""IPv4 网卡枚举与选择。

多网卡环境(WSL、Hyper-V、VMware、VPN)里最容易选错出口网卡,因此这里给每块网卡
打上 ``is_virtual`` 标记,默认选择时跳过虚拟网卡与链路本地地址,并允许用户按名称
或 IP 显式指定。
"""

from __future__ import annotations

import ipaddress
import socket
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import psutil

#: 网卡名称中出现这些关键字时视为虚拟网卡(不区分大小写)。
_VIRTUAL_KEYWORDS = (
    "vmware",
    "vmnet",
    "virtualbox",
    "vboxnet",
    "vethernet",
    "hyper-v",
    "wsl",
    "docker",
    "veth",
    "br-",
    "virbr",
    "tap",
    "tun",
    "loopback",
    "bluetooth",
    "tailscale",
    "zerotier",
)


@dataclass(frozen=True, slots=True)
class NetInterface:
    """一块网卡上的一个 IPv4 地址。

    Attributes:
        name: 网卡名称。
        ip: IPv4 地址。
        netmask: 子网掩码。
        broadcast: 该子网的定向广播地址。
        is_up: 网卡是否已启用。
        is_loopback: 是否为环回地址。
        is_link_local: 是否为链路本地地址(169.254.0.0/16),通常表示未获得有效地址。
        is_virtual: 名称是否像虚拟网卡。
        mac: MAC 地址,取不到时为 ``None``。
    """

    name: str
    ip: str
    netmask: str
    broadcast: str
    is_up: bool
    is_loopback: bool
    is_link_local: bool
    is_virtual: bool
    mac: str | None

    @property
    def usable(self) -> bool:
        """是否适合作为默认出口:已启用、非环回、非链路本地。"""
        return self.is_up and not self.is_loopback and not self.is_link_local

    def label(self) -> str:
        """人类可读的单行描述。"""
        flags = []
        if self.is_virtual:
            flags.append("虚拟")
        if self.is_loopback:
            flags.append("环回")
        if self.is_link_local:
            flags.append("链路本地")
        if not self.is_up:
            flags.append("未启用")
        suffix = f"  [{', '.join(flags)}]" if flags else ""
        return f"{self.name}  {self.ip}/{self.netmask}  广播 {self.broadcast}{suffix}"


def _looks_virtual(name: str) -> bool:
    """按名称关键字判断是否为虚拟网卡。"""
    lowered = name.lower()
    return any(k in lowered for k in _VIRTUAL_KEYWORDS)


def build_interfaces(
    addrs: Mapping[str, Sequence[Any]],
    stats: Mapping[str, Any],
) -> list[NetInterface]:
    """由 psutil 风格的数据构造网卡列表(纯函数,便于测试)。

    Args:
        addrs: ``psutil.net_if_addrs()`` 的结果。
        stats: ``psutil.net_if_stats()`` 的结果。

    Returns:
        每个 IPv4 地址一项,按网卡名与 IP 排序。
    """
    result: list[NetInterface] = []
    for name, entries in addrs.items():
        mac = next(
            (
                e.address.replace("-", ":").lower()
                for e in entries
                if getattr(e, "family", None) == psutil.AF_LINK and e.address
            ),
            None,
        )
        stat = stats.get(name)
        is_up = bool(getattr(stat, "isup", False))
        for entry in entries:
            if getattr(entry, "family", None) != socket.AF_INET or not entry.address:
                continue
            netmask = entry.netmask or "255.255.255.255"
            try:
                network = ipaddress.IPv4Interface(f"{entry.address}/{netmask}").network
                ip = ipaddress.IPv4Address(entry.address)
            except ValueError:
                continue
            result.append(
                NetInterface(
                    name=name,
                    ip=str(ip),
                    netmask=netmask,
                    broadcast=str(network.broadcast_address),
                    is_up=is_up,
                    is_loopback=ip.is_loopback,
                    is_link_local=ip.is_link_local,
                    is_virtual=_looks_virtual(name) and not ip.is_loopback,
                    mac=mac,
                )
            )
    result.sort(key=lambda i: (i.name.lower(), i.ip))
    return result


def list_interfaces() -> list[NetInterface]:
    """枚举本机全部 IPv4 网卡地址。

    Returns:
        网卡列表。
    """
    return build_interfaces(psutil.net_if_addrs(), psutil.net_if_stats())


def default_interface(interfaces: Sequence[NetInterface] | None = None) -> NetInterface | None:
    """挑选默认出口网卡:优先真实网卡,其次虚拟网卡,最后环回。

    Args:
        interfaces: 候选列表;为 ``None`` 时现场枚举。

    Returns:
        选中的网卡;没有任何可用网卡时返回 ``None``。
    """
    items = list(interfaces) if interfaces is not None else list_interfaces()
    for pred in (
        lambda i: i.usable and not i.is_virtual,
        lambda i: i.usable,
        lambda i: i.is_up and i.is_loopback,
    ):
        for item in items:
            if pred(item):
                return item
    return None


def find_interface(
    spec: str,
    interfaces: Sequence[NetInterface] | None = None,
) -> NetInterface:
    """按 IP 或名称(子串,不区分大小写)查找网卡。

    先精确匹配 IP,再精确匹配名称,最后按名称子串匹配;子串匹配必须唯一。

    Args:
        spec: IP 地址或网卡名称(片段)。
        interfaces: 候选列表;为 ``None`` 时现场枚举。

    Returns:
        匹配到的网卡。

    Raises:
        LookupError: 没有匹配,或名称片段匹配到多块网卡。
    """
    items = list(interfaces) if interfaces is not None else list_interfaces()
    for item in items:
        if item.ip == spec:
            return item
    lowered = spec.lower()
    exact = [i for i in items if i.name.lower() == lowered]
    if len(exact) == 1:
        return exact[0]
    matches = exact or [i for i in items if lowered in i.name.lower()]
    if not matches:
        raise LookupError(f"找不到网卡: {spec}")
    if len(matches) > 1:
        names = ", ".join(f"{m.name}({m.ip})" for m in matches)
        raise LookupError(f"网卡名称 {spec!r} 不唯一,请改用 IP: {names}")
    return matches[0]
