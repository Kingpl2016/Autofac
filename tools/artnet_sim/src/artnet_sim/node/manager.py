"""虚拟节点管理器:负责 socket 收发、定时维护与 sACN 组播订阅。

接收路径(节点逻辑本身见 :mod:`artnet_sim.node.virtual_node`):

- **通配 socket**(``0.0.0.0:6454``)只负责广播类报文:ArtPoll、ArtSync、ArtTimeCode,
  它们会分发给全部在线节点。
- **每个节点一个专属 socket**(绑定 ``节点IP:6454``)接收发给该节点的单播:ArtDmx、
  ArtAddress 等。Windows 上专属 socket 也会收到广播,所以 ArtPoll/ArtSync/ArtTimeCode
  在两条路径上可能各收到一份,管理器用一个很短的去重窗口把重复的挡掉。
- **sACN 通配 socket**(``0.0.0.0:5568``)分发给全部节点,由节点按 Universe 过滤。

回复策略(``reply_mode``):``unicast`` 单播回请求者;``broadcast`` 回定向广播;
``auto``(默认)在请求者就是本机时用广播。后者是同机运行的关键:发往本机网卡 IP 的单播
只会被先绑定 6454 的那个进程收到,广播则每个绑定者都能收到(见 ``net/sockets.py``)。
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from artnet_sim.net.interfaces import NetInterface, list_interfaces
from artnet_sim.net.multicast import SacnSubscriptions
from artnet_sim.net.policy import is_allowed_target
from artnet_sim.net.receiver import UdpReceiver
from artnet_sim.net.sockets import create_recv_socket, create_send_socket, port_in_use
from artnet_sim.node.config import NodeConfig
from artnet_sim.node.virtual_node import Reply, VirtualNode
from artnet_sim.protocol import artnet
from artnet_sim.protocol.artnet import OpCode
from artnet_sim.protocol.common import ARTNET_PORT, SACN_PORT

logger = logging.getLogger(__name__)

#: 在通配 socket 与专属 socket 上可能各收到一份的报文,需要去重。
_MULTI_PATH_OPCODES = frozenset({OpCode.POLL, OpCode.SYNC, OpCode.TIME_CODE})

#: 去重窗口(纳秒)。两条路径上的同一份广播几乎同时到达;控制器的 ArtSync 最快约 22ms 一次。
_DEDUPE_NS = 5_000_000

REPLY_MODES = ("auto", "unicast", "broadcast")

#: 同机运行时节点默认使用的环回别名。
SAME_HOST_IP = "127.0.0.2"


def auto_node_ip(artnet_port: int, interface: NetInterface | None) -> str:
    """为虚拟节点自动挑选 IP。

    Art-Net 端口已被其他进程占用(多半是同机的 Art-Net Studio)时,用环回别名
    ``127.0.0.2``,避免抢走发往本机网卡 IP 的单播;否则使用所选网卡的 IP。

    Args:
        artnet_port: Art-Net 监听端口。
        interface: 所选网卡;``None`` 时回退到环回别名。

    Returns:
        IPv4 地址字符串。
    """
    if interface is None or port_in_use(artnet_port):
        return SAME_HOST_IP
    return interface.ip


@dataclass(slots=True)
class ManagerStart:
    """:meth:`NodeManager.start` 的结果。

    Attributes:
        artnet_port_shared: Art-Net 端口在绑定前已被其他进程占用。
        sacn_port_shared: sACN 端口在绑定前已被其他进程占用。
        warnings: 需要提示用户的文字。
    """

    artnet_port_shared: bool = False
    sacn_port_shared: bool = False
    warnings: list[str] = field(default_factory=list)


@dataclass(slots=True)
class _Entry:
    """一个节点及其专属接收器。"""

    node: VirtualNode
    receiver: UdpReceiver


class NodeManager:
    """虚拟节点管理器。

    Args:
        interface: 出口网卡,决定广播地址与 sACN 组播所用的网卡;``None`` 时回复用受限广播,
            不订阅 sACN 组播。
        artnet_port: Art-Net 监听端口。
        sacn_port: sACN 监听端口。
        reply_port: 回复的目标端口,默认等于 ``artnet_port``(标准为 6454);测试时可改成别的。
        reply_mode: ``auto`` / ``unicast`` / ``broadcast``。
        tick_interval: 定时维护周期(秒)。
        local_ips: 本机 IP 集合,用来判断请求者是不是本机;默认现场枚举。
        clock_ns: 单调时钟(纳秒),测试可替换。
    """

    def __init__(
        self,
        *,
        interface: NetInterface | None = None,
        artnet_port: int = ARTNET_PORT,
        sacn_port: int = SACN_PORT,
        reply_port: int | None = None,
        reply_mode: str = "auto",
        tick_interval: float = 0.25,
        local_ips: set[str] | None = None,
        clock_ns: Callable[[], int] = time.perf_counter_ns,
    ) -> None:
        if reply_mode not in REPLY_MODES:
            raise ValueError(f"reply_mode 必须是 {', '.join(REPLY_MODES)} 之一,实际 {reply_mode!r}")
        self._iface = interface
        self._artnet_port = artnet_port
        self._sacn_port = sacn_port
        self._reply_port = reply_port or artnet_port
        self.reply_mode = reply_mode
        self._tick_interval = tick_interval
        self._local_ips = local_ips if local_ips is not None else {i.ip for i in list_interfaces()}
        self._clock = clock_ns
        self._lock = threading.RLock()
        self._entries: dict[str, _Entry] = {}
        self._seen: dict[tuple[str, tuple[str, int], bytes], int] = {}
        self._wildcard: UdpReceiver | None = None
        self._sacn_rx: UdpReceiver | None = None
        self._subscriptions: SacnSubscriptions | None = None
        self._send_sock: Any = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self.warnings: list[str] = []
        self.reply_errors = 0
        self._external_artnet_shared = False

    @property
    def artnet_port(self) -> int:
        """Art-Net 监听端口(信号源发给节点时使用的目标端口)。"""
        return self._artnet_port

    # ------------------------------------------------------------------ 生命周期
    def start(self) -> ManagerStart:
        """绑定通配 socket、创建发送 socket 并启动维护线程。

        Returns:
            启动结果,含端口是否与其他进程共用及需要提示的警告。

        Raises:
            OSError: 绑定失败。已创建的资源会被清理。
        """
        result = ManagerStart()
        try:
            result.artnet_port_shared = port_in_use(self._artnet_port)
            self._external_artnet_shared = result.artnet_port_shared
            self._wildcard = UdpReceiver(
                create_recv_socket(self._artnet_port, timeout=0.1), self._on_wildcard, "node-artnet"
            )
            result.sacn_port_shared = port_in_use(self._sacn_port)
            sacn_sock = create_recv_socket(self._sacn_port, timeout=0.1)
            ifaces = [self._iface.ip] if self._iface is not None else []
            self._subscriptions = SacnSubscriptions(sacn_sock, ifaces)
            self._sacn_rx = UdpReceiver(sacn_sock, self._on_sacn, "node-sacn")
            bind_ip = self._iface.ip if self._iface and not self._iface.is_loopback else None
            self._send_sock = create_send_socket(bind_ip)
        except OSError:
            self.stop()
            raise
        if result.artnet_port_shared:
            result.warnings.append(
                f"UDP {self._artnet_port} 已被其他进程占用(通常是同机的 Art-Net Studio):"
                "本程序只负责接收广播;请给虚拟节点使用 127.0.0.x 环回别名作为 IP,"
                "并先启动对方,避免发往本机 IP 的单播被本程序抢走。"
            )
        self.warnings = list(result.warnings)
        self._wildcard.start()
        self._sacn_rx.start()
        self._stop.clear()
        self._thread = threading.Thread(target=self._tick_loop, name="node-tick", daemon=True)
        self._thread.start()
        return result

    def stop(self) -> None:
        """停止维护线程,关闭全部 socket。"""
        self._stop.set()
        if self._thread is not None:
            self._thread.join(2.0)
            self._thread = None
        with self._lock:
            entries = list(self._entries.values())
            self._entries.clear()
        receivers = [e.receiver for e in entries]
        receivers += [rx for rx in (self._wildcard, self._sacn_rx) if rx is not None]
        for rx in receivers:
            rx.request_stop()
        for rx in receivers:
            rx.stop()
        self._wildcard = self._sacn_rx = None
        if self._subscriptions is not None:
            self._subscriptions.clear()
        self._subscriptions = None
        if self._send_sock is not None:
            self._send_sock.close()
            self._send_sock = None

    # ------------------------------------------------------------------ 节点管理
    def add_node(self, config: NodeConfig) -> tuple[VirtualNode, list[str]]:
        """创建节点并绑定它的专属接收 socket。

        Args:
            config: 节点配置。

        Returns:
            ``(节点, 警告列表)``。

        Raises:
            ValueError: 配置不合法、id 重复,或 IP 不是本机地址。
            OSError: 绑定失败(例如该地址的 6454 端口被独占占用)。
        """
        config.validate()
        warnings: list[str] = []
        if not config.ip.startswith("127.") and config.ip not in self._local_ips:
            raise ValueError(
                f"节点 IP {config.ip} 不是本机地址;请使用本机网卡 IP、辅助 IP,或 127.0.0.x 环回别名"
            )
        with self._lock:
            if config.id in self._entries:
                raise ValueError(f"节点 id 已存在: {config.id}")
        if not config.ip.startswith("127.") and self._external_artnet_shared:
            warnings.append(
                f"节点 IP {config.ip} 是真实网卡地址,且端口 {self._artnet_port} "
                "启动前已被其他进程使用;绑定后发往该 IP 的单播会被本节点收走,"
                "同机运行请改用 127.0.0.x 别名"
            )
        node = VirtualNode(config)
        try:
            sock = create_recv_socket(self._artnet_port, config.ip, timeout=0.1)
        except OSError as exc:
            raise OSError(f"无法绑定 {config.ip}:{self._artnet_port}: {exc}") from exc
        receiver = UdpReceiver(
            sock,
            lambda data, addr, t_ns, n=node: self._deliver(n, data, addr, t_ns),
            f"node-{config.id}",
        )
        with self._lock:
            self._entries[config.id] = _Entry(node, receiver)
        receiver.start()
        self._sync_subscriptions()
        return node, warnings

    def remove_node(self, node_id: str) -> bool:
        """移除并关闭一个节点。

        Args:
            node_id: 节点 id。

        Returns:
            节点存在并已移除返回 ``True``。
        """
        with self._lock:
            entry = self._entries.pop(node_id, None)
        if entry is None:
            return False
        entry.receiver.stop()
        self._sync_subscriptions()
        return True

    def get(self, node_id: str) -> VirtualNode | None:
        """按 id 取节点。

        Args:
            node_id: 节点 id。

        Returns:
            节点;不存在返回 ``None``。
        """
        with self._lock:
            entry = self._entries.get(node_id)
        return entry.node if entry else None

    def nodes(self) -> list[VirtualNode]:
        """返回全部节点的快照列表。"""
        with self._lock:
            return [e.node for e in self._entries.values()]

    def snapshot(self) -> dict[str, Any]:
        """导出全部节点状态。

        Returns:
            含 ``nodes``、当前订阅的 sACN Universe 与警告的字典。
        """
        now = self._clock()
        return {
            "nodes": [n.snapshot(now) for n in self.nodes()],
            "sacn_universes": self._subscriptions.universes if self._subscriptions else [],
            "warnings": list(self.warnings),
            "reply_errors": self.reply_errors,
        }

    # ------------------------------------------------------------------ 接收
    def _is_duplicate(self, node_id: str, addr: tuple[str, int], data: bytes, t_ns: int) -> bool:
        """同一份广播经通配与专属两条路径到达时,只放行第一份。"""
        key = (node_id, addr, data)
        with self._lock:
            previous = self._seen.get(key)
            self._seen[key] = t_ns
            if len(self._seen) > 512:
                limit = t_ns - 1_000_000_000
                self._seen = {k: t for k, t in self._seen.items() if t >= limit}
        return previous is not None and t_ns - previous < _DEDUPE_NS

    def _deliver(self, node: VirtualNode, data: bytes, addr: tuple[str, int], t_ns: int) -> None:
        """把一个 Art-Net 报文交给节点并发送它产生的回复。"""
        opcode = artnet.opcode_of(data)
        if opcode is None:
            return
        if opcode in _MULTI_PATH_OPCODES and self._is_duplicate(node.config.id, addr, data, t_ns):
            return
        self._send_replies(node.handle_artnet(data, addr, t_ns))

    def _on_wildcard(self, data: bytes, addr: tuple[str, int], t_ns: int) -> None:
        """通配 socket:只处理广播类报文,分发给全部节点。"""
        if artnet.opcode_of(data) not in _MULTI_PATH_OPCODES:
            return
        for node in self.nodes():
            self._deliver(node, data, addr, t_ns)

    def _on_sacn(self, data: bytes, addr: tuple[str, int], t_ns: int) -> None:
        """sACN socket:分发给全部节点,节点按自己监听的 Universe 过滤。"""
        for node in self.nodes():
            node.handle_sacn(data, addr, t_ns)

    # ------------------------------------------------------------------ 回复
    def _reply_destination(self, to_ip: str) -> tuple[str, int] | None:
        """决定一个回复发往哪里;被策略拒绝时返回 ``None``。"""
        if not is_allowed_target(to_ip):
            return None  # 不向公网地址回复,避免被用作反射放大
        mode = self.reply_mode
        if mode == "auto":
            same_host = to_ip in self._local_ips and not to_ip.startswith("127.")
            mode = "broadcast" if same_host else "unicast"
        if mode == "broadcast":
            ip = self._iface.broadcast if self._iface is not None else "255.255.255.255"
            return ip, self._reply_port
        return to_ip, self._reply_port

    def _send_replies(self, replies: list[Reply]) -> None:
        """发送节点产生的 ArtPollReply。"""
        sock = self._send_sock
        if sock is None:
            return
        for reply in replies:
            dest = self._reply_destination(reply.to_ip)
            if dest is None:
                continue
            try:
                sock.sendto(reply.payload, dest)
            except OSError as exc:
                self.reply_errors += 1
                logger.debug("发送 ArtPollReply 失败 %s: %s", dest, exc)

    # ------------------------------------------------------------------ 维护
    def _sync_subscriptions(self) -> None:
        """让 sACN 组播订阅与全部在线节点需要的 Universe 保持一致。"""
        if self._subscriptions is None:
            return
        wanted: set[int] = set()
        for node in self.nodes():
            if node.online:
                wanted |= node.sacn_universes()
        report = self._subscriptions.set(wanted)
        for failure in report.failed:
            logger.warning("sACN 组播加入失败: %s", failure)

    def _tick_loop(self) -> None:
        """维护线程:清理过期源、通知订阅者、同步组播订阅。"""
        while not self._stop.wait(self._tick_interval):
            now = self._clock()
            for node in self.nodes():
                try:
                    self._send_replies(node.tick(now))
                except Exception:
                    logger.exception("节点 %s 维护出错", node.config.id)
            try:
                self._sync_subscriptions()
            except Exception:
                logger.exception("同步 sACN 订阅出错")
