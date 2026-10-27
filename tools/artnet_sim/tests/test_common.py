import pytest

from artnet_sim.protocol.common import (
    port_address,
    sacn_multicast_addr,
    split_port_address,
)


def test_port_address_roundtrip():
    for net, sub, uni in [(0, 0, 0), (1, 2, 3), (127, 15, 15)]:
        assert split_port_address(port_address(net, sub, uni)) == (net, sub, uni)


def test_port_address_known_value():
    assert port_address(1, 2, 3) == 0x0123
    assert port_address(127, 15, 15) == 0x7FFF


@pytest.mark.parametrize("args", [(128, 0, 0), (0, 16, 0), (0, 0, 16), (-1, 0, 0)])
def test_port_address_rejects_out_of_range(args):
    with pytest.raises(ValueError):
        port_address(*args)


def test_split_port_address_rejects_16_bit():
    with pytest.raises(ValueError):
        split_port_address(0x8000)


@pytest.mark.parametrize(
    ("universe", "expected"),
    [
        (1, "239.255.0.1"),
        (2, "239.255.0.2"),
        (15, "239.255.0.15"),
        (256, "239.255.1.0"),
        (512, "239.255.2.0"),
        (1024, "239.255.4.0"),
        (63999, "239.255.249.255"),
        (64214, "239.255.250.214"),
    ],
)
def test_sacn_multicast_addr(universe, expected):
    assert sacn_multicast_addr(universe) == expected


@pytest.mark.parametrize("universe", [0, 64000, 65535, -1])
def test_sacn_multicast_addr_rejects_invalid(universe):
    with pytest.raises(ValueError):
        sacn_multicast_addr(universe)
