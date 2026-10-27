"""虚拟节点的协议逻辑。

本模块**不做任何网络 IO**:输入是收到的报文、来源地址和时刻,输出是需要回复的报文
(:class:`Reply`)。Socket 的收发由 :mod:`artnet_sim.node.manager` 负责,这样节点行为可以
用假时间做确定性测试。
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Any

from artnet_sim.node.config import NodeConfig, PortConfig, group_binds
from artnet_sim.node.merge import ArtnetMerger, SacnMerger
from artnet_sim.protocol import artnet, artnet_ext, sacn
from artnet_sim.protocol.artnet import OpCode

#: 订阅了"状态变化时主动回复"的控制器,多久没再 ArtPoll 就不再通知(秒)。
SUBSCRIBER_TTL_S = 60.0

#: 节点在同步模式下,超过这么久没收到 ArtSync 就回到异步模式(秒)。
SYNC_TIMEOUT_S = 4.0

# Status1 的指示灯状态(位 7-6)。
_INDICATOR = {"normal": 0b11, "locate": 0b01, "mute": 0b10}

# Status3 的 failsafe 状态(位 7-6)。
_FAILSAFE = {"hold": 0b00, "zero": 0b01, "full": 0b10, "scene": 0b11}


@dataclass(frozen=True, slots=True)
class Reply:
    """节点要发出的一个 ArtPollReply。

    Attributes:
        payload: 报文内容。
        to_ip: 请求者(或订阅者)的 IP,由管理器决定是单播还是广播回去。
    """

    payload: bytes
    to_ip: str


class _Bind:
    """一组共享 Net/SubNet 的端口,对应一个 BindIndex。"""

    def __init__(self, index: int, net: int, sub: int) -> None:
        self.index = index
        self.default_net = net
        self.default_sub = sub
        self.net = net
        self.sub = sub
        self.ports: list[_Port] = []


class _Port:
    """端口的运行时状态。"""

    def __init__(self, index: int, slot: int, cfg: PortConfig, bind: _Bind, hold_s: float) -> None:
        self.index = index
        self.slot = slot
        self.cfg = cfg
        self.bind = bind
        self.direction = cfg.direction
        self.default_nibble = cfg.address & 0x0F
        self.nibble_in = self.default_nibble
        self.nibble_out = self.default_nibble
        self.sacn_mode = cfg.protocol == "sacn"
        self.merge_mode = cfg.merge_mode
        self.art = ArtnetMerger(cfg.merge_mode, hold_s)
        self.sac = SacnMerger()
        self.output = b""
        self.last_data_ns: int | None = None
        self.packets = 0
        self.last_ip = ""
        self.last_sequence = 0
        self.pending: tuple[str, int, bytes, int] | None = None

    @property
    def is_output(self) -> bool:
        """端口是否可输出(接收网络数据)。"""
        return self.direction in ("output", "both")

    @property
    def is_input(self) -> bool:
        """端口是否可输入(向网络发送数据)。"""
        return self.direction in ("input", "both")

    @property
    def out_address(self) -> int:
        """输出方向的有效 15 位 Port-Address。"""
        return (self.bind.net << 8) | (self.bind.sub << 4) | self.nibble_out

    @property
    def in_address(self) -> int:
        """输入方向的有效 15 位 Port-Address。"""
        return (self.bind.net << 8) | (self.bind.sub << 4) | self.nibble_in

    def active(self, t_ns: int, timeout_s: float) -> bool:
        """最近 ``timeout_s`` 秒内是否收到过数据。"""
        return self.last_data_ns is not None and (t_ns - self.last_data_ns) <= timeout_s * 1e9

    @property
    def merging(self) -> bool:
        """是否正在合并多个源。"""
        return self.sac.merging if self.sacn_mode else self.art.merging


class VirtualNode:
    """一个虚拟 Art-Net 节点。

    Args:
        config: 节点配置,会被校验。
    """

    def __init__(self, config: NodeConfig) -> None:
        config.validate()
        self.config = config
        self.online = config.online
        self.short_name = config.short_name
        self.long_name = config.long_name
        self.acn_priority = config.acn_priority
        self.led_mode = "normal"
        self.failsafe = "hold"
        self.failsafe_scene: dict[int, bytes] = {}
        self.analysis = False
        self.programmed_by_network = False
        self.timecode: artnet_ext.ArtTimeCode | None = None
        self.sync_active = False
        self.counters = {"polls": 0, "replies": 0, "dmx": 0, "sacn": 0, "syncs": 0, "addresses": 0}
        self._lock = threading.RLock()
        self._reply_counter = 0
        self._subscribers: dict[str, int] = {}
        self._last_sync_ns = 0
        self._clock_ns = 0
        self._last_dmx_ip = ""
        self._signature: tuple[Any, ...] | None = None

        self.binds: list[_Bind] = []
        self.ports: list[_Port] = []
        for member_indices in group_binds(config.ports):
            first = config.ports[member_indices[0]].address
            bind = _Bind(len(self.binds) + 1, first >> 8, (first >> 4) & 0x0F)
            self.binds.append(bind)
            for slot, index in enumerate(member_indices):
                port = _Port(index, slot, config.ports[index], bind, config.merge_hold_s)
                bind.ports.append(port)
                self.ports.append(port)
        self.ports.sort(key=lambda p: p.index)

    # ------------------------------------------------------------------ 订阅信息
    @property
    def ip(self) -> str:
        """节点的 IPv4。"""
        return self.config.ip

    def subscribed_addresses(self) -> list[int]:
        """节点当前订阅(输入或输出)的全部 Port-Address,升序去重。"""
        with self._lock:
            addresses = set()
            for p in self.ports:
                if p.is_output:
                    addresses.add(p.out_address)
                if p.is_input:
                    addresses.add(p.in_address)
            return sorted(addresses)

    def sacn_universes(self) -> set[int]:
        """sACN 模式的输出口需要监听的 sACN Universe 集合(超出 1~63999 的忽略)。"""
        with self._lock:
            offset = self.config.sacn_universe_offset
            universes = {p.out_address + offset for p in self.ports if p.is_output and p.sacn_mode}
            return {u for u in universes if 1 <= u <= 63999}

    def set_online(self, online: bool) -> None:
        """切换在线状态。离线时既不回复 ArtPoll,也不处理收到的数据。

        Args:
            online: 目标状态。
        """
        with self._lock:
            self.online = online

    # ------------------------------------------------------------------ ArtPollReply
    def build_replies(self) -> list[bytes]:
        """为每个 Bind 生成一个 ArtPollReply。

        Returns:
            报文列表,BindIndex 从 1 起。
        """
        with self._lock:
            self._reply_counter += 1
            counter = self._reply_counter
            self.counters["replies"] += len(self.binds)
            return [self._reply_for(bind, counter).build() for bind in self.binds]

    def _reply_for(self, bind: _Bind, counter: int) -> artnet_ext.ArtPollReply:
        """构造一个 Bind 的 ArtPollReply 对象。"""
        port_types = [0, 0, 0, 0]
        good_in = [0, 0, 0, 0]
        good_out_a = [0, 0, 0, 0]
        sw_in = [0, 0, 0, 0]
        sw_out = [0, 0, 0, 0]
        now = self._clock_ns
        for port in bind.ports:
            s = port.slot
            if port.is_output:
                port_types[s] |= artnet_ext.PORT_TYPE_OUTPUT
                sw_out[s] = port.nibble_out
                if port.active(now, self.config.active_timeout_s):
                    good_out_a[s] |= artnet_ext.GOOD_DATA_ACTIVE
                if port.merging:
                    good_out_a[s] |= artnet_ext.GOOD_OUTPUT_MERGING
                if port.merge_mode == "ltp":
                    good_out_a[s] |= artnet_ext.GOOD_OUTPUT_LTP
                if port.sacn_mode:
                    good_out_a[s] |= artnet_ext.GOOD_OUTPUT_SACN
            if port.is_input:
                port_types[s] |= artnet_ext.PORT_TYPE_INPUT
                sw_in[s] = port.nibble_in
        status1 = (_INDICATOR[self.led_mode] << 6) | (
            (0b10 if self.programmed_by_network else 0b01) << 4
        )
        status2 = artnet_ext.STATUS2_PORT_ADDRESS_15BIT | artnet_ext.STATUS2_ARTNET_SACN_SWITCHABLE
        status3 = (_FAILSAFE[self.failsafe] << 6) | 0x08  # 位 3:支持切换端口方向
        cfg = self.config
        return artnet_ext.ArtPollReply(
            ip=cfg.ip,
            version=cfg.version,
            net_switch=bind.net,
            sub_switch=bind.sub,
            oem=cfg.oem,
            status1=status1,
            esta_man=cfg.esta_man,
            short_name=self.short_name,
            long_name=self.long_name,
            node_report=artnet_ext.format_node_report(
                artnet_ext.NodeReportCode.POWER_OK, counter, "OK"
            ),
            num_ports=len(bind.ports),
            port_types=tuple(port_types),  # type: ignore[arg-type]
            good_input=tuple(good_in),  # type: ignore[arg-type]
            good_output_a=tuple(good_out_a),  # type: ignore[arg-type]
            sw_in=tuple(sw_in),  # type: ignore[arg-type]
            sw_out=tuple(sw_out),  # type: ignore[arg-type]
            acn_priority=self.acn_priority,
            style=cfg.style,
            mac=cfg.mac_bytes(),
            bind_ip=cfg.ip,
            bind_index=bind.index,
            status2=status2,
            good_output_b=(0xC0, 0xC0, 0xC0, 0xC0),
            status3=status3,
            refresh_rate=44,
        )

    # ------------------------------------------------------------------ Art-Net 入口
    def handle_artnet(self, data: bytes, addr: tuple[str, int], t_ns: int) -> list[Reply]:
        """处理一个发给本节点的 Art-Net 报文。

        Args:
            data: UDP 载荷。
            addr: 来源 ``(IP, 端口)``。
            t_ns: 到达时刻(纳秒)。

        Returns:
            需要回复的 ArtPollReply 列表;多数报文没有回复。
        """
        opcode = artnet.opcode_of(data)
        if opcode is None:
            return []
        with self._lock:
            self._clock_ns = t_ns
            if not self.online:
                return []
            if opcode == OpCode.POLL:
                return self._on_poll(data, addr, t_ns)
            if opcode == OpCode.DMX:
                self._on_dmx(data, addr, t_ns)
            elif opcode == OpCode.ADDRESS:
                return self._on_address(data, addr, t_ns)
            elif opcode == OpCode.SYNC:
                self._on_sync(addr, t_ns)
            elif opcode == OpCode.TIME_CODE:
                parsed = artnet_ext.parse_time_code(data)
                if parsed is not None:
                    self.timecode = parsed
            return []

    def _on_poll(self, data: bytes, addr: tuple[str, int], t_ns: int) -> list[Reply]:
        """处理 ArtPoll。"""
        poll = artnet.parse_poll(data)
        if poll is None:
            return []
        self.counters["polls"] += 1
        if poll.reply_on_change:
            self._subscribers[addr[0]] = t_ns
        else:
            self._subscribers.pop(addr[0], None)
        if not poll.wants(self.subscribed_addresses()):
            return []
        return [Reply(p, addr[0]) for p in self.build_replies()]

    def _on_dmx(self, data: bytes, addr: tuple[str, int], t_ns: int) -> None:
        """处理 ArtDmx。"""
        dmx = artnet.parse_dmx(data)
        if dmx is None:
            return
        self._expire_sync(t_ns)
        self._last_dmx_ip = addr[0]
        for port in self.ports:
            if not port.is_output or port.sacn_mode or port.out_address != dmx.port_address:
                continue
            if self.sync_active and not port.art.merging:
                port.pending = (addr[0], dmx.physical, dmx.data, dmx.sequence)
                continue
            self._apply_art(port, addr[0], dmx.physical, dmx.data, dmx.sequence, t_ns)

    def _apply_art(
        self, port: _Port, ip: str, physical: int, data: bytes, sequence: int, t_ns: int
    ) -> None:
        """把一帧 ArtDmx 送进端口的合并器并更新输出。"""
        if port.art.feed(ip, physical, data, t_ns):
            port.output = port.art.output
            port.last_data_ns = t_ns
            port.packets += 1
            port.last_ip = ip
            port.last_sequence = sequence
            self.counters["dmx"] += 1

    def _expire_sync(self, t_ns: int) -> None:
        """同步模式下超过 4 秒没有 ArtSync 就回到异步模式。"""
        if self.sync_active and t_ns - self._last_sync_ns > SYNC_TIMEOUT_S * 1e9:
            self.sync_active = False
            for port in self.ports:
                port.pending = None

    def _on_sync(self, addr: tuple[str, int], t_ns: int) -> None:
        """处理 ArtSync:进入同步模式,并把缓冲的数据一起输出。"""
        # 规范:ArtSync 的来源 IP 必须与最近一帧 ArtDmx 的来源 IP 一致,否则忽略。
        if self._last_dmx_ip and addr[0] != self._last_dmx_ip:
            return
        self.counters["syncs"] += 1
        self.sync_active = True
        self._last_sync_ns = t_ns
        for port in self.ports:
            if port.pending is None or port.art.merging:
                port.pending = None
                continue
            ip, physical, data, sequence = port.pending
            port.pending = None
            self._apply_art(port, ip, physical, data, sequence, t_ns)

    # ------------------------------------------------------------------ ArtAddress
    def _on_address(self, data: bytes, addr: tuple[str, int], t_ns: int) -> list[Reply]:
        """处理 ArtAddress:改名、改地址、执行命令,然后回复 ArtPollReply。"""
        cmd = artnet_ext.parse_address(data)
        if cmd is None:
            return []
        bind = next((b for b in self.binds if b.index == max(1, cmd.bind_index)), None)
        if bind is None:
            return []
        self.counters["addresses"] += 1
        self.programmed_by_network = True
        if cmd.port_name:
            self.short_name = cmd.port_name
        if cmd.long_name:
            self.long_name = cmd.long_name

        action, value = artnet_ext.decode_switch(cmd.net_switch)
        if action == "program":
            bind.net = value or 0
        elif action == "reset":
            bind.net = bind.default_net
        action, value = artnet_ext.decode_switch(cmd.sub_switch)
        if action == "program":
            bind.sub = (value or 0) & 0x0F
        elif action == "reset":
            bind.sub = bind.default_sub
        for port in bind.ports:
            for attr, raw in (
                ("nibble_in", cmd.sw_in[port.slot]),
                ("nibble_out", cmd.sw_out[port.slot]),
            ):
                action, value = artnet_ext.decode_switch(raw)
                if action == "program":
                    setattr(port, attr, (value or 0) & 0x0F)
                elif action == "reset":
                    setattr(port, attr, port.default_nibble)
        if cmd.acn_priority != artnet_ext.ACN_PRIORITY_NO_CHANGE and cmd.acn_priority <= 200:
            self.acn_priority = cmd.acn_priority
        self._run_command(bind, cmd.command)
        return [Reply(p, addr[0]) for p in self.build_replies()]

    def _run_command(self, bind: _Bind, command: int) -> None:
        """执行 ArtAddress 的 Command。"""
        C = artnet_ext.AddressCommand
        if command == C.CANCEL_MERGE:
            for port in bind.ports:
                port.art.cancel_merge()
        elif command == C.LED_NORMAL:
            self.led_mode = "normal"
        elif command == C.LED_MUTE:
            self.led_mode = "mute"
        elif command == C.LED_LOCATE:
            self.led_mode = "locate"
        elif command == C.ANALYSIS_ON:
            self.analysis = True
        elif command == C.ANALYSIS_OFF:
            self.analysis = False
        elif command == C.FAIL_HOLD:
            self.failsafe = "hold"
        elif command == C.FAIL_ZERO:
            self.failsafe = "zero"
        elif command == C.FAIL_FULL:
            self.failsafe = "full"
        elif command == C.FAIL_SCENE:
            self.failsafe = "scene"
        elif command == C.FAIL_RECORD:
            self.failsafe_scene = {p.index: p.output for p in self.ports if p.is_output}
        elif C.MERGE_LTP_0 <= command <= C.MERGE_LTP_3:
            self._port_in_bind(bind, command - C.MERGE_LTP_0, merge_mode="ltp")
        elif C.MERGE_HTP_0 <= command <= C.MERGE_HTP_3:
            self._port_in_bind(bind, command - C.MERGE_HTP_0, merge_mode="htp")
        elif C.DIRECTION_TX_0 <= command <= C.DIRECTION_TX_3:
            self._port_in_bind(bind, command - C.DIRECTION_TX_0, direction="output")
        elif C.DIRECTION_RX_0 <= command <= C.DIRECTION_RX_3:
            self._port_in_bind(bind, command - C.DIRECTION_RX_0, direction="input")
        elif C.ARTNET_SEL_0 <= command <= C.ARTNET_SEL_3:
            self._port_in_bind(bind, command - C.ARTNET_SEL_0, sacn_mode=False)
        elif C.ACN_SEL_0 <= command <= C.ACN_SEL_3:
            self._port_in_bind(bind, command - C.ACN_SEL_0, sacn_mode=True)
        elif C.CLEAR_OP_0 <= command <= C.CLEAR_OP_3:
            self._port_in_bind(bind, command - C.CLEAR_OP_0, clear=True)

    def _port_in_bind(
        self,
        bind: _Bind,
        slot: int,
        *,
        merge_mode: str | None = None,
        direction: str | None = None,
        sacn_mode: bool | None = None,
        clear: bool = False,
    ) -> None:
        """修改 Bind 中某个槽位端口的属性;槽位上没有端口则忽略。"""
        port = next((p for p in bind.ports if p.slot == slot), None)
        if port is None:
            return
        if merge_mode is not None:
            port.merge_mode = merge_mode
            port.art.mode = merge_mode
        if direction is not None:
            port.direction = direction
        if sacn_mode is not None:
            port.sacn_mode = sacn_mode
        if clear:
            port.output = bytes(len(port.output))

    # ------------------------------------------------------------------ sACN 入口
    def handle_sacn(self, data: bytes, addr: tuple[str, int], t_ns: int) -> None:
        """处理一个 sACN 数据包(只有 sACN 模式的输出口会使用)。

        Args:
            data: UDP 载荷。
            addr: 来源 ``(IP, 端口)``。
            t_ns: 到达时刻(纳秒)。
        """
        parsed = sacn.parse_data(data)
        if parsed is None or parsed.start_code != 0:
            return
        with self._lock:
            self._clock_ns = t_ns
            if not self.online:
                return
            offset = self.config.sacn_universe_offset
            for port in self.ports:
                if not (port.is_output and port.sacn_mode):
                    continue
                if port.out_address + offset != parsed.universe:
                    continue
                accepted = port.sac.feed(
                    parsed.cid.hex(),
                    addr[0],
                    parsed.source_name,
                    parsed.priority,
                    parsed.data,
                    t_ns,
                    parsed.terminated,
                )
                if accepted:
                    # 终止包也会让优先级仲裁的结果改变(例如低优先级源接管)。
                    port.output = port.sac.output or port.output
                if accepted and not parsed.terminated:
                    port.last_data_ns = t_ns
                    port.packets += 1
                    port.last_ip = addr[0]
                    port.last_sequence = parsed.sequence
                    self.counters["sacn"] += 1

    # ------------------------------------------------------------------ 维护
    def tick(self, t_ns: int) -> list[Reply]:
        """周期性维护:清理过期源、结束同步模式,并向订阅者通知状态变化。

        Args:
            t_ns: 当前时刻(纳秒)。

        Returns:
            需要主动发给订阅者的 ArtPollReply。
        """
        with self._lock:
            self._clock_ns = t_ns
            if not self.online:
                return []
            self._expire_sync(t_ns)
            for port in self.ports:
                if port.sacn_mode:
                    port.sac.expire(t_ns)
                    port.output = port.sac.output or port.output
                else:
                    port.art.expire(t_ns)
                    port.output = port.art.output or port.output
            signature = self._make_signature(t_ns)
            changed = self._signature is not None and signature != self._signature
            self._signature = signature
            if not changed:
                return []
            cutoff = t_ns - int(SUBSCRIBER_TTL_S * 1e9)
            self._subscribers = {ip: t for ip, t in self._subscribers.items() if t >= cutoff}
            replies = []
            for ip in self._subscribers:
                replies.extend(Reply(p, ip) for p in self.build_replies())
            return replies

    def _make_signature(self, t_ns: int) -> tuple[Any, ...]:
        """汇总会体现在 ArtPollReply 里的状态,用于检测变化。"""
        timeout = self.config.active_timeout_s
        return (
            self.led_mode,
            self.short_name,
            self.long_name,
            tuple(
                (
                    p.direction,
                    p.out_address,
                    p.in_address,
                    p.sacn_mode,
                    p.merge_mode,
                    p.merging,
                    p.active(t_ns, timeout),
                )
                for p in self.ports
            ),
        )

    # ------------------------------------------------------------------ 状态导出
    def port_output(self, index: int) -> bytes:
        """取某个端口当前输出的通道数据。

        Args:
            index: 端口在配置里的序号。

        Returns:
            通道数据;端口不存在或还没有数据时为空。
        """
        with self._lock:
            for port in self.ports:
                if port.index == index:
                    return port.output
        return b""

    def snapshot(self, t_ns: int) -> dict[str, Any]:
        """导出节点状态,供界面使用。

        Args:
            t_ns: 当前时刻(纳秒)。

        Returns:
            可 JSON 序列化的字典。
        """
        with self._lock:
            timeout = self.config.active_timeout_s
            ports = []
            for p in self.ports:
                sources = p.sac.sources(t_ns) if p.sacn_mode else p.art.sources(t_ns)
                ports.append(
                    {
                        "index": p.index,
                        "bind": p.bind.index,
                        "slot": p.slot,
                        "direction": p.direction,
                        "out_address": p.out_address,
                        "in_address": p.in_address,
                        "protocol": "sacn" if p.sacn_mode else "artnet",
                        "merge_mode": p.merge_mode,
                        "active": p.active(t_ns, timeout),
                        "merging": p.merging,
                        "packets": p.packets,
                        "last_ip": p.last_ip,
                        "last_sequence": p.last_sequence,
                        "channels": len(p.output),
                        "sources": sources,
                    }
                )
            return {
                "id": self.config.id,
                "ip": self.config.ip,
                "online": self.online,
                "short_name": self.short_name,
                "long_name": self.long_name,
                "led_mode": self.led_mode,
                "failsafe": self.failsafe,
                "acn_priority": self.acn_priority,
                "sync_active": self.sync_active,
                "binds": len(self.binds),
                "timecode": (
                    None
                    if self.timecode is None
                    else (
                        f"{self.timecode.hours:02d}:{self.timecode.minutes:02d}:"
                        f"{self.timecode.seconds:02d}:{self.timecode.frames:02d}"
                    )
                ),
                "counters": dict(self.counters),
                "ports": ports,
            }
