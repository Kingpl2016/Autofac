import socket
import threading
import time

from artnet_sim.cli import main
from artnet_sim.net.sockets import create_recv_socket
from artnet_sim.protocol import artnet, artnet_ext


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def test_cli_node_answers_poll_and_shows_received_data(capsys):
    artnet_port, sacn_port, reply_port = free_port(), free_port(), free_port()
    controller_rx = create_recv_socket(reply_port, "127.0.0.1", timeout=0.3)
    argv = [
        "node",
        "--ip",
        "127.0.0.2",
        "--interface",
        "Loopback",
        "--name",
        "命令行节点",
        "--output",
        "1-2",
        "--input",
        "5",
        "--artnet-port",
        str(artnet_port),
        "--sacn-port",
        str(sacn_port),
        "--reply-port",
        str(reply_port),
        "--duration",
        "2.2",
        "--interval",
        "0.5",
    ]
    thread = threading.Thread(target=main, args=(argv,), daemon=True)
    thread.start()
    time.sleep(0.6)

    tx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        tx.sendto(artnet.build_poll(), ("127.0.0.2", artnet_port))
        reply = None
        deadline = time.monotonic() + 2
        while reply is None and time.monotonic() < deadline:
            try:
                data, _ = controller_rx.recvfrom(2048)
            except (TimeoutError, ConnectionResetError):
                continue
            reply = artnet_ext.parse_poll_reply(data)
        assert reply is not None and reply.short_name == "命令行节点"
        assert [(p.direction, p.universe) for p in reply.expand_ports()] == [
            ("output", 1),
            ("output", 2),
            ("input", 5),
        ]
        tx.sendto(artnet.build_dmx(1, 1, b"\x01\x02"), ("127.0.0.2", artnet_port))
        tx.sendto(artnet.build_dmx(2, 1, b"\x03\x04"), ("127.0.0.2", artnet_port))
    finally:
        tx.close()
        controller_rx.close()
    thread.join(6)
    captured = capsys.readouterr()
    assert not thread.is_alive()
    assert "节点 cli-node  127.0.0.2  命令行节点  [在线]" in captured.out
    rows = [line for line in captured.out.splitlines() if line.strip().startswith(("1 ", "2 "))]
    assert rows and any(" Y " in row for row in rows)
    assert "虚拟节点已启动" in captured.err


def test_cli_node_argument_errors(capsys):
    assert main(["node"]) == 2  # 没有任何端口
    assert "至少需要一个端口" in capsys.readouterr().err
    assert main(["node", "--output", "1", "--ip", "203.0.113.9"]) == 2
    assert "不是本机地址" in capsys.readouterr().err
    assert main(["node", "--output", "99999"]) == 2
    assert main(["node", "--output", "1", "--interface", "no-such-nic"]) == 2
