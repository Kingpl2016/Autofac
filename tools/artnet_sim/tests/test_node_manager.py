import socket
import time

import pytest

from artnet_sim.net.interfaces import NetInterface
from artnet_sim.net.scheduler import Scheduler
from artnet_sim.net.sockets import create_recv_socket
from artnet_sim.node.config import NodeConfig, PortConfig
from artnet_sim.node.manager import NodeManager
from artnet_sim.protocol import artnet, artnet_ext, sacn
from artnet_sim.sender.engine import SendEngine
from artnet_sim.sender.source import SourceConfig


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def wait_for(predicate, timeout=3.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return False


class Controller:
    """模拟控制器:发 ArtPoll、收 ArtPollReply。"""

    def __init__(self, reply_port: int):
        self.rx = create_recv_socket(reply_port, "127.0.0.1", timeout=0.3)
        self.tx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.tx.bind(("127.0.0.1", 0))

    def send(self, data: bytes, ip: str, port: int) -> None:
        self.tx.sendto(data, (ip, port))

    def replies(self, expected: int, timeout: float = 2.0) -> list[artnet_ext.ArtPollReply]:
        out = []
        deadline = time.monotonic() + timeout
        while len(out) < expected and time.monotonic() < deadline:
            try:
                data, _ = self.rx.recvfrom(2048)
            except (TimeoutError, ConnectionResetError):
                continue
            parsed = artnet_ext.parse_poll_reply(data)
            if parsed is not None:
                out.append(parsed)
        return out

    def close(self):
        self.rx.close()
        self.tx.close()


@pytest.fixture
def env():
    artnet_port, sacn_port, reply_port = free_port(), free_port(), free_port()
    manager = NodeManager(
        artnet_port=artnet_port,
        sacn_port=sacn_port,
        reply_port=reply_port,
        tick_interval=0.05,
        local_ips={"127.0.0.1"},
    )
    manager.start()
    controller = Controller(reply_port)
    yield manager, controller, artnet_port, sacn_port
    controller.close()
    manager.stop()


def node_config(node_id="n1", ip="127.0.0.2", **kwargs):
    ports = kwargs.pop("ports", [PortConfig("output", 0x0101)])
    return NodeConfig(id=node_id, ip=ip, ports=ports, short_name=node_id, **kwargs)


def test_unicast_poll_to_node_gets_a_reply(env):
    manager, controller, port, _ = env
    manager.add_node(node_config())
    controller.send(artnet.build_poll(), "127.0.0.2", port)
    (reply,) = controller.replies(1)
    assert reply.ip == "127.0.0.2" and reply.short_name == "n1" and reply.bind_index == 1
    assert [(p.direction, p.universe) for p in reply.expand_ports()] == [("output", 0x0101)]


def test_poll_to_wildcard_makes_every_node_reply(env):
    manager, controller, port, _ = env
    manager.add_node(node_config("a", "127.0.0.2"))
    manager.add_node(node_config("b", "127.0.0.3", ports=[PortConfig("output", 0x0201)]))
    controller.send(artnet.build_poll(), "127.0.0.1", port)
    replies = controller.replies(2)
    assert sorted(r.ip for r in replies) == ["127.0.0.2", "127.0.0.3"]
    assert sorted(r.net_switch for r in replies) == [1, 2]


def test_offline_node_does_not_reply_and_comes_back(env):
    manager, controller, port, _ = env
    node, _ = manager.add_node(node_config())
    node.set_online(False)
    controller.send(artnet.build_poll(), "127.0.0.1", port)
    assert controller.replies(1, timeout=0.6) == []
    node.set_online(True)
    controller.send(artnet.build_poll(), "127.0.0.1", port)
    assert len(controller.replies(1)) == 1


def test_artdmx_from_send_engine_reaches_node_port(env):
    manager, _controller, port, _ = env
    node, _ = manager.add_node(node_config())
    engine = SendEngine(Scheduler(boost_priority=False), resolver=lambda spec: None)
    engine.start()
    try:
        source = engine.add_source(
            SourceConfig(
                id="s",
                universes=[0x0101],
                generator="fixed",
                generator_params={"value": 77},
                rate=100,
                channels=16,
                target="127.0.0.2",
                port=port,
            )
        )
        assert wait_for(lambda: node.port_output(0) == bytes([77]) * 16)
        assert wait_for(lambda: source.stats.frames >= 5)
    finally:
        engine.stop()
    snap = manager.snapshot()["nodes"][0]["ports"][0]
    assert snap["packets"] >= 5 and snap["sources"][0]["ip"] == "127.0.0.1"


def test_two_sources_merge_at_the_node(env):
    manager, _controller, port, _ = env
    node, _ = manager.add_node(node_config())
    ours = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    ours.bind(("127.0.0.1", 0))
    other = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    other.bind(("127.0.0.1", 0))
    try:
        # 同一个 IP,Physical 不同 → 视为两个源
        a = bytearray(artnet.build_dmx(0x0101, 1, b"\x10\x00"))
        b = bytearray(artnet.build_dmx(0x0101, 1, b"\x00\x20"))
        b[13] = 1
        ours.sendto(bytes(a), ("127.0.0.2", port))
        other.sendto(bytes(b), ("127.0.0.2", port))
        assert wait_for(lambda: node.port_output(0) == b"\x10\x20")
    finally:
        ours.close()
        other.close()
    assert manager.snapshot()["nodes"][0]["ports"][0]["merging"]


def test_artaddress_reprograms_node_and_returns_reply(env):
    manager, controller, port, _ = env
    node, _ = manager.add_node(node_config())
    cmd = artnet_ext.ArtAddress(sw_out=(0x85, 0, 0, 0), port_name="改过名")
    controller.send(cmd.build(), "127.0.0.2", port)
    (reply,) = controller.replies(1)
    assert reply.short_name == "改过名" and reply.sw_out[0] == 5
    assert node.subscribed_addresses() == [0x0105]


def test_state_change_is_pushed_to_subscribers(env):
    manager, controller, port, _ = env
    node, _ = manager.add_node(node_config())
    controller.send(artnet.build_poll(flags=0x02), "127.0.0.2", port)
    assert len(controller.replies(1)) == 1
    time.sleep(0.2)  # 等维护线程建立基线
    controller.send(artnet.build_dmx(0x0101, 1, b"\x01\x02"), "127.0.0.2", port)
    (pushed,) = controller.replies(1, timeout=2.0)
    assert pushed.good_output_a[0] & artnet_ext.GOOD_DATA_ACTIVE
    assert node.port_output(0) == b"\x01\x02"


def test_sacn_unicast_reaches_sacn_mode_port(env):
    manager, controller, _artnet_port, sacn_port = env
    node, _ = manager.add_node(node_config(ports=[PortConfig("output", 0x0000, protocol="sacn")]))
    cid = sacn.new_cid()
    controller.send(sacn.build_data(1, b"\x09\x08", cid, "台"), "127.0.0.1", sacn_port)
    assert wait_for(lambda: node.port_output(0) == b"\x09\x08")
    assert manager.snapshot()["nodes"][0]["ports"][0]["protocol"] == "sacn"


def test_add_node_validation(env):
    manager, *_ = env
    with pytest.raises(ValueError, match="不是本机地址"):
        manager.add_node(node_config(ip="203.0.113.7"))
    manager.add_node(node_config("a", "127.0.0.2"))
    with pytest.raises(ValueError, match="已存在"):
        manager.add_node(node_config("a", "127.0.0.3"))
    assert manager.remove_node("a") is True
    assert manager.remove_node("a") is False
    manager.add_node(node_config("a", "127.0.0.2"))  # 端口已释放,可以重新添加
    assert [n.config.id for n in manager.nodes()] == ["a"]
    assert manager.get("a") is not None and manager.get("zz") is None


def test_reply_destination_policy():
    iface = NetInterface(
        "WLAN", "192.168.1.10", "255.255.255.0", "192.168.1.255", True, False, False, False, None
    )
    manager = NodeManager(
        interface=iface, local_ips={"192.168.1.10"}, artnet_port=6454, reply_mode="auto"
    )
    assert manager._reply_destination("192.168.1.77") == ("192.168.1.77", 6454)
    assert manager._reply_destination("192.168.1.10") == ("192.168.1.255", 6454)  # 请求者是本机
    assert manager._reply_destination("127.0.0.1") == ("127.0.0.1", 6454)
    assert manager._reply_destination("8.8.8.8") is None  # 公网请求者不回复
    manager.reply_mode = "broadcast"
    assert manager._reply_destination("192.168.1.77") == ("192.168.1.255", 6454)
    manager.reply_mode = "unicast"
    assert manager._reply_destination("192.168.1.10") == ("192.168.1.10", 6454)
    with pytest.raises(ValueError):
        NodeManager(reply_mode="weird")


def test_dedupe_window_for_multi_path_broadcasts():
    manager = NodeManager(local_ips=set())
    addr = ("10.0.0.1", 1234)
    assert not manager._is_duplicate("n", addr, b"poll", 0)
    assert manager._is_duplicate("n", addr, b"poll", 1_000_000)  # 1ms 后的同一份
    assert not manager._is_duplicate("n", addr, b"poll", 30_000_000)  # 30ms 后算新的一次
    assert not manager._is_duplicate("other", addr, b"poll", 30_000_000)  # 不同节点互不影响


def test_start_failure_cleans_up_and_stop_is_idempotent():
    port = free_port()
    holder = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    holder.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
    holder.bind(("0.0.0.0", port))
    try:
        manager = NodeManager(artnet_port=port, sacn_port=free_port(), local_ips=set())
        with pytest.raises(OSError):
            manager.start()
        manager.stop()
        manager.stop()
    finally:
        holder.close()


def test_manager_snapshot_and_poll_artnet_frames_through_dedupe_do_not_double_reply(env):
    manager, controller, port, _ = env
    manager.add_node(node_config())
    poll = artnet.build_poll()
    controller.send(poll, "127.0.0.2", port)
    assert len(controller.replies(1)) == 1
    assert controller.replies(1, timeout=0.5) == []  # 没有多余的第二份
    snap = manager.snapshot()
    assert snap["nodes"][0]["counters"]["polls"] == 1
