import socket
from types import SimpleNamespace

import psutil
import pytest

from artnet_sim.net import interfaces as ifs
from artnet_sim.net.policy import is_allowed_target
from artnet_sim.net.sockets import (
    create_recv_socket,
    create_send_socket,
    port_in_use,
)
from artnet_sim.net.targets import default_port, resolve_target
from artnet_sim.util import parse_ranges


def addr(family, address, netmask=None):
    return SimpleNamespace(family=family, address=address, netmask=netmask)


FAKE_ADDRS = {
    "Loopback Pseudo-Interface 1": [addr(socket.AF_INET, "127.0.0.1", "255.0.0.0")],
    "WLAN": [
        addr(psutil.AF_LINK, "AA-BB-CC-DD-EE-01"),
        addr(socket.AF_INET, "192.168.31.102", "255.255.255.0"),
        addr(socket.AF_INET6, "fe80::1"),
    ],
    "vEthernet (WSL)": [addr(socket.AF_INET, "172.20.80.1", "255.255.240.0")],
    "以太网": [addr(socket.AF_INET, "169.254.1.2", "255.255.0.0")],
    "Wi-Fi 2": [addr(socket.AF_INET, "10.0.0.5", "255.0.0.0")],
}
FAKE_STATS = {
    "Loopback Pseudo-Interface 1": SimpleNamespace(isup=True),
    "WLAN": SimpleNamespace(isup=True),
    "vEthernet (WSL)": SimpleNamespace(isup=True),
    "以太网": SimpleNamespace(isup=False),
    "Wi-Fi 2": SimpleNamespace(isup=True),
}


@pytest.fixture
def fake_ifaces():
    return ifs.build_interfaces(FAKE_ADDRS, FAKE_STATS)


def test_build_interfaces_computes_fields(fake_ifaces):
    by_name = {i.name: i for i in fake_ifaces}
    wlan = by_name["WLAN"]
    assert wlan.broadcast == "192.168.31.255"
    assert wlan.mac == "aa:bb:cc:dd:ee:01"
    assert wlan.usable and not wlan.is_virtual
    assert by_name["vEthernet (WSL)"].is_virtual
    assert by_name["以太网"].is_link_local and not by_name["以太网"].usable
    assert by_name["Loopback Pseudo-Interface 1"].is_loopback
    assert not by_name["Loopback Pseudo-Interface 1"].is_virtual
    assert len(fake_ifaces) == 5  # IPv6 与 MAC 条目不产生网卡项


def test_default_interface_prefers_real_nic(fake_ifaces):
    chosen = ifs.default_interface(fake_ifaces)
    assert chosen is not None
    assert chosen.name in ("WLAN", "Wi-Fi 2")
    assert not chosen.is_virtual


def test_default_interface_falls_back_to_virtual_then_loopback(fake_ifaces):
    only_virtual = [i for i in fake_ifaces if i.is_virtual]
    assert ifs.default_interface(only_virtual).name == "vEthernet (WSL)"
    only_loop = [i for i in fake_ifaces if i.is_loopback]
    assert ifs.default_interface(only_loop).is_loopback
    assert ifs.default_interface([]) is None


def test_find_interface_by_ip_name_and_fragment(fake_ifaces):
    assert ifs.find_interface("192.168.31.102", fake_ifaces).name == "WLAN"
    assert ifs.find_interface("wlan", fake_ifaces).name == "WLAN"
    assert ifs.find_interface("wsl", fake_ifaces).ip == "172.20.80.1"


def test_find_interface_errors(fake_ifaces):
    with pytest.raises(LookupError, match="找不到"):
        ifs.find_interface("nonexistent", fake_ifaces)
    with pytest.raises(LookupError, match="不唯一"):
        ifs.find_interface("i", fake_ifaces)  # 多块网卡名称都含 i


@pytest.mark.parametrize(
    ("address", "expected"),
    [
        ("127.0.0.1", True),
        ("192.168.1.10", True),
        ("172.16.0.1", True),
        ("10.1.2.3", True),
        ("2.255.255.255", True),  # Art-Net 的 2.x 主地址段
        ("169.254.1.1", True),
        ("239.255.0.1", True),
        ("255.255.255.255", True),
        ("8.8.8.8", False),
        ("1.2.3.4", False),
        ("not-an-ip", False),
    ],
)
def test_is_allowed_target(address, expected):
    assert is_allowed_target(address) is expected


def test_allow_public_flag():
    assert is_allowed_target("8.8.8.8", allow_public=True)
    assert not is_allowed_target("8.8.8.8")


def test_resolve_target_keywords(fake_ifaces):
    wlan = ifs.find_interface("WLAN", fake_ifaces)
    assert resolve_target("artnet", 1, "broadcast", wlan) == "192.168.31.255"
    assert resolve_target("sacn", 258, "multicast") == "239.255.1.2"
    assert resolve_target("artnet", 1, " 192.168.1.9 ") == "192.168.1.9"


@pytest.mark.parametrize(
    ("protocol", "target", "iface_needed"),
    [
        ("artnet", "multicast", False),
        ("artnet", "broadcast", False),  # 缺少网卡
        ("artnet", "8.8.8.8", False),
        ("artnet", "garbage", False),
        ("other", "127.0.0.1", False),
    ],
)
def test_resolve_target_rejects(protocol, target, iface_needed):
    with pytest.raises(ValueError):
        resolve_target(protocol, 1, target, None)


def test_resolve_target_public_allowed_explicitly():
    assert resolve_target("artnet", 1, "8.8.8.8", allow_public=True) == "8.8.8.8"


def test_default_port():
    assert default_port("artnet") == 6454
    assert default_port("sacn") == 5568
    with pytest.raises(ValueError):
        default_port("x")


def test_parse_ranges():
    assert parse_ranges("1-4,8, 10-11,2") == [1, 2, 3, 4, 8, 10, 11]
    assert parse_ranges("5") == [5]
    for bad in ["", "a", "4-1", "1-", "-3", "70000"]:
        with pytest.raises(ValueError):
            parse_ranges(bad)
    with pytest.raises(ValueError):
        parse_ranges("0", minimum=1)


def test_loopback_send_and_recv_roundtrip():
    rx = create_recv_socket(0, "127.0.0.1", timeout=2.0)
    port = rx.getsockname()[1]
    tx = create_send_socket(None)
    try:
        tx.sendto(b"hello", ("127.0.0.1", port))
        data, _ = rx.recvfrom(2048)
        assert data == b"hello"
    finally:
        tx.close()
        rx.close()


def test_recv_socket_requests_large_buffer():
    rx = create_recv_socket(0, "127.0.0.1")
    try:
        actual = rx.getsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF)
        assert actual >= 64 * 1024
    finally:
        rx.close()


def test_port_in_use_detects_reuseaddr_holder():
    holder = create_recv_socket(0, "0.0.0.0")  # 与 Studio 一样设置了 SO_REUSEADDR
    port = holder.getsockname()[1]
    try:
        assert port_in_use(port) is True
    finally:
        holder.close()
    assert port_in_use(port) is False
