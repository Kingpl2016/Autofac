import socket
import threading
import time

import pytest

from artnet_sim.cli import main
from artnet_sim.net.interfaces import default_interface
from artnet_sim.net.receiver import UdpReceiver
from artnet_sim.net.sockets import (
    create_recv_socket,
    create_send_socket,
    join_sacn_universes,
)
from artnet_sim.protocol import artnet, sacn
from artnet_sim.protocol.common import sacn_multicast_addr


def free_udp_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def run_listener(args: list[str]) -> threading.Thread:
    thread = threading.Thread(target=main, args=(args,), daemon=True)
    thread.start()
    time.sleep(0.4)  # 等待监听就绪
    return thread


def test_cli_send_artnet_to_loopback_is_received_by_listen(capsys):
    port = free_udp_port()
    listener = run_listener(
        [
            "listen",
            "--protocol",
            "artnet",
            "--artnet-port",
            str(port),
            "--count",
            "3",
            "--timeout",
            "5",
        ]
    )
    code = main(
        [
            "send",
            "--protocol",
            "artnet",
            "--universe",
            "1-3",
            "--value",
            "7",
            "--target",
            "127.0.0.1",
            "--port",
            str(port),
            "--count",
            "1",
        ]
    )
    listener.join(6)
    out = capsys.readouterr().out
    assert code == 0
    assert not listener.is_alive()
    for universe in (1, 2, 3):
        assert f"ArtDmx  PA={universe} seq=1 ch=512" in out


def test_cli_send_sacn_unicast_and_terminated_burst(capsys):
    port = free_udp_port()
    listener = run_listener(
        ["listen", "--protocol", "sacn", "--sacn-port", str(port), "--count", "4", "--timeout", "5"]
    )
    code = main(
        [
            "send",
            "--protocol",
            "sacn",
            "--universe",
            "5",
            "--target",
            "127.0.0.1",
            "--port",
            str(port),
            "--priority",
            "120",
            "--count",
            "1",
        ]
    )
    listener.join(6)
    out = capsys.readouterr().out
    assert code == 0
    assert "sACN    U=5 prio=120 seq=0 ch=512" in out  # sACN 序号从 0 起
    assert out.count("TERMINATED") == 3  # 停止时连发 3 次 Stream_Terminated


@pytest.mark.parametrize(
    "argv",
    [
        ["send", "--universe", "x"],
        ["send", "--universe", "40000"],
        ["send", "--protocol", "sacn", "--universe", "0"],
        ["send", "--value", "300", "--target", "127.0.0.1"],
        ["send", "--channels", "0", "--target", "127.0.0.1"],
        ["send", "--rate", "0", "--target", "127.0.0.1"],
        ["send", "--target", "8.8.8.8"],
        ["send", "--protocol", "artnet", "--target", "multicast"],
        ["listen", "--universe", "0"],
    ],
)
def test_cli_rejects_bad_arguments(argv, capsys):
    assert main(argv) == 2
    assert "参数错误" in capsys.readouterr().err


def test_cli_interfaces_lists_something(capsys):
    assert main(["interfaces"]) == 0
    assert "默认选择" in capsys.readouterr().out


def test_udp_receiver_delivers_and_stops():
    rx_sock = create_recv_socket(0, "127.0.0.1", timeout=0.1)
    got: list[bytes] = []
    done = threading.Event()

    def handler(data, _addr, t_ns):
        assert t_ns > 0
        got.append(data)
        done.set()

    receiver = UdpReceiver(rx_sock, handler)
    port = receiver.local_port
    receiver.start()
    tx = create_send_socket(None)
    try:
        tx.sendto(artnet.build_dmx(1, 1, b"\x01\x02"), ("127.0.0.1", port))
        assert done.wait(2)
    finally:
        tx.close()
        receiver.stop()
    assert len(got) == 1
    assert receiver.packets == 1 and receiver.errors == 0


def test_udp_receiver_survives_handler_exception():
    rx_sock = create_recv_socket(0, "127.0.0.1", timeout=0.1)
    seen: list[int] = []

    def handler(data, _addr, _t):
        seen.append(len(data))
        if len(seen) == 1:
            raise RuntimeError("boom")

    receiver = UdpReceiver(rx_sock, handler)
    port = receiver.local_port
    receiver.start()
    tx = create_send_socket(None)
    try:
        tx.sendto(b"a", ("127.0.0.1", port))
        tx.sendto(b"bb", ("127.0.0.1", port))
        deadline = time.monotonic() + 2
        while len(seen) < 2 and time.monotonic() < deadline:
            time.sleep(0.01)
    finally:
        tx.close()
        receiver.stop()
    assert seen == [1, 2]
    assert receiver.errors == 1


def test_sacn_multicast_loopback_roundtrip():
    iface = default_interface()
    if iface is None or iface.is_loopback:
        pytest.skip("没有可用于组播的真实网卡")
    rx_sock = create_recv_socket(0, "0.0.0.0", timeout=1.0)
    port = rx_sock.getsockname()[1]
    report = join_sacn_universes(rx_sock, [iface.ip], [1])
    if report.joined != 1:
        rx_sock.close()
        pytest.skip(f"当前环境无法加入组播: {report.failed}")
    tx = create_send_socket(iface.ip, multicast_loop=True)
    cid = sacn.new_cid()
    try:
        tx.sendto(sacn.build_data(1, b"\x09", cid), (sacn_multicast_addr(1), port))
        try:
            data, _ = rx_sock.recvfrom(2048)
        except TimeoutError:
            pytest.skip("当前网络环境未回送本机发出的组播(防火墙或网卡驱动)")
        parsed = sacn.parse_data(data)
        assert parsed is not None and parsed.universe == 1 and parsed.cid == cid
    finally:
        tx.close()
        rx_sock.close()
