"""信号源:一个生成器 + 一组 Universe + 协议 + 目标 + 故障注入,由调度器周期触发。"""

from __future__ import annotations

import random
import threading
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Protocol

from artnet_sim.generators import Generator, make_generator
from artnet_sim.protocol import artnet, sacn
from artnet_sim.protocol.common import (
    MAX_CHANNELS,
    MAX_PORT_ADDRESS,
    SACN_MAX_UNIVERSE,
    SACN_MIN_UNIVERSE,
)
from artnet_sim.sender.impairments import Impairments

STATE_RUNNING = "running"
STATE_PAUSED = "paused"
STATE_STOPPED = "stopped"

#: 收到 Stream_Terminated 的次数建议值(规范推荐连发 3 次)。
TERMINATE_REPEAT = 3

_ARTNET_DATA_OFFSET = artnet.ARTDMX_HEADER_LEN
_SACN_DATA_OFFSET = sacn.DATA_OFFSET
_SACN_PRIORITY_OFFSET = 108
_SACN_SEQUENCE_OFFSET = 111
_SACN_OPTIONS_OFFSET = 112


class Transport(Protocol):
    """信号源通过它发出数据报。"""

    def send(self, packet: bytes, dest: tuple[str, int]) -> bool:
        """发送一个数据报。

        Args:
            packet: 数据报内容。
            dest: 目标 ``(IP, 端口)``。

        Returns:
            发送成功返回 ``True``;失败返回 ``False`` 而不是抛异常,以免打断调度线程。
        """
        ...


@dataclass(slots=True)
class SourceConfig:
    """信号源配置。

    Attributes:
        id: 唯一标识。
        protocol: ``artnet`` 或 ``sacn``。
        universes: 发送的 Universe 列表。Art-Net 为 Port-Address(0~32767),
            sACN 为 1~63999。
        generator: 生成器名,见 :mod:`artnet_sim.generators`。
        generator_params: 生成器参数。
        rate: 每秒帧数(每帧给每个 Universe 各发一个包)。
        priority: sACN 优先级,0~200;Art-Net 忽略。
        channels: 每个包的通道数,1~512。
        target: ``broadcast`` / ``multicast``(仅 sACN) / 具体 IPv4。
        port: 目标端口,0 表示按协议默认。
        interface: 出口网卡名称或 IP;``None`` 表示自动选择。
        source_name: sACN 源名称。
        cid: sACN 的 CID(32 位十六进制),``None`` 表示随机生成。
        allow_public: 是否允许公网目标。
        physical: Art-Net ArtDmx 的 Physical 字段(0~255),用来区分同一个 IP 上的多个输入口;
            两个源的 IP 与 Physical 都相同才会被节点当作同一个源。
        impairments: 故障注入配置。
    """

    id: str
    protocol: str = "artnet"
    universes: list[int] = field(default_factory=lambda: [1])
    generator: str = "fixed"
    generator_params: dict[str, Any] = field(default_factory=dict)
    rate: float = 44.0
    priority: int = sacn.DEFAULT_PRIORITY
    channels: int = MAX_CHANNELS
    target: str = "broadcast"
    port: int = 0
    interface: str | None = None
    source_name: str = "artnet-sim"
    cid: str | None = None
    allow_public: bool = False
    physical: int = 0
    impairments: Impairments = field(default_factory=Impairments)

    def validate(self) -> None:
        """校验配置(不包含网络相关的检查)。

        Raises:
            ValueError: 任一字段不合法。
        """
        if not self.id:
            raise ValueError("信号源 id 不能为空")
        if self.protocol not in ("artnet", "sacn"):
            raise ValueError(f"protocol 必须是 artnet 或 sacn,实际 {self.protocol!r}")
        if not self.universes:
            raise ValueError("universes 不能为空")
        if len(set(self.universes)) != len(self.universes):
            raise ValueError("universes 含重复项")
        low, high = (
            (0, MAX_PORT_ADDRESS)
            if self.protocol == "artnet"
            else (SACN_MIN_UNIVERSE, SACN_MAX_UNIVERSE)
        )
        for u in self.universes:
            if not low <= u <= high:
                raise ValueError(f"{self.protocol} 的 Universe 必须在 {low}~{high},实际 {u}")
        if not 0.1 <= self.rate <= 1000.0:
            raise ValueError(f"rate 必须在 0.1~1000,实际 {self.rate}")
        if not 0 <= self.priority <= sacn.MAX_PRIORITY:
            raise ValueError(f"priority 必须在 0~{sacn.MAX_PRIORITY},实际 {self.priority}")
        if not 1 <= self.channels <= MAX_CHANNELS:
            raise ValueError(f"channels 必须在 1~{MAX_CHANNELS},实际 {self.channels}")
        if not 0 <= self.port <= 0xFFFF:
            raise ValueError(f"port 必须在 0~65535,实际 {self.port}")
        if not 0 <= self.physical <= 0xFF:
            raise ValueError(f"physical 必须在 0~255,实际 {self.physical}")
        if self.cid is not None:
            try:
                if len(bytes.fromhex(self.cid)) != 16:
                    raise ValueError
            except ValueError:
                raise ValueError("cid 必须是 32 位十六进制字符串") from None
        self.impairments.validate()


@dataclass(slots=True)
class SourceStats:
    """信号源的发送统计。

    Attributes:
        frames: 已触发的帧数。
        packets: 已发出的数据报数(含重复包与补发的乱序包)。
        dropped: 被故障注入丢弃的包数。
        duplicated: 被故障注入重复的包数。
        reordered: 被故障注入延后的包数。
        send_errors: 发送失败次数。
    """

    frames: int = 0
    packets: int = 0
    dropped: int = 0
    duplicated: int = 0
    reordered: int = 0
    send_errors: int = 0


class Source:
    """一个信号源,实现调度器的 ``ScheduledTask`` 接口。

    Args:
        config: 已校验的配置。
        transport: 发送通道。
        destinations: 每个 Universe 的目标 ``(IP, 端口)``。
        generator: 生成器;为 ``None`` 时按配置创建。
    """

    def __init__(
        self,
        config: SourceConfig,
        transport: Transport,
        destinations: Mapping[int, tuple[str, int]],
        generator: Generator | None = None,
    ) -> None:
        config.validate()
        missing = [u for u in config.universes if u not in destinations]
        if missing:
            raise ValueError(f"缺少这些 Universe 的目标地址: {missing}")
        self.config = config
        self._transport = transport
        self._dest = dict(destinations)
        self._generator = generator or make_generator(config.generator, config.generator_params)
        self._cid = bytes.fromhex(config.cid) if config.cid else sacn.new_cid()
        self._rng = random.Random(config.impairments.seed)
        self._lock = threading.RLock()
        self._templates: dict[int, bytearray] = {}
        self._seq: dict[int, int] = {}
        self._held: dict[int, bytes] = {}
        self._last_data: dict[int, bytes] = {}
        self._t0: float | None = None
        self.frozen = False
        self.state = STATE_RUNNING
        self.stats = SourceStats()

    @property
    def interval(self) -> float:
        """触发周期(秒)。"""
        return 1.0 / self.config.rate

    @property
    def cid(self) -> bytes:
        """sACN 使用的 CID。"""
        return self._cid

    def jitter(self) -> float:
        """下一次触发额外推迟的秒数。"""
        jitter_ms = self.config.impairments.jitter_ms
        if jitter_ms <= 0:
            return 0.0
        with self._lock:
            return self._rng.uniform(0.0, jitter_ms / 1000.0)

    # ------------------------------------------------------------------ 发送
    def fire(self, now: float) -> None:
        """渲染一帧并发送所有 Universe。

        Args:
            now: 触发时的时钟读数;首次触发时记为信号源的时间零点。
        """
        with self._lock:
            if self.state != STATE_RUNNING:
                return
            if self._t0 is None:
                self._t0 = now
            t = now - self._t0
            self.stats.frames += 1
            imp = self.config.impairments
            drop_frame = imp.drop_every > 0 and self.stats.frames % imp.drop_every == 0
            reset_seq = imp.seq_reset_every > 0 and self.stats.frames % imp.seq_reset_every == 0
            channels = self.config.channels
            for index, universe in enumerate(self.config.universes):
                if self.frozen and universe in self._last_data:
                    data = self._last_data[universe]
                else:
                    data = self._generator.render(t, index, channels)
                    if len(data) != channels:
                        data = data[:channels].ljust(channels, b"\x00")
                    self._last_data[universe] = data
                if reset_seq:
                    self._seq.pop(universe, None)
                packet = self._build(universe, data, self._next_seq(universe))
                self._dispatch(universe, packet, drop_frame)

    def _next_seq(self, universe: int) -> int:
        """计算并记录该 Universe 的下一个序号。"""
        mode = self.config.impairments.seq_mode
        if mode == "none":
            return 0
        current = self._seq.get(universe)
        if mode == "frozen" and current is not None:
            return current
        if self.config.protocol == "artnet":
            nxt = 1 if current is None else current % 255 + 1  # 1..255,避开 0
        else:
            nxt = 0 if current is None else (current + 1) & 0xFF
        self._seq[universe] = nxt
        return nxt

    def _template(self, universe: int) -> bytearray:
        """取得(必要时创建)该 Universe 的包模板。"""
        tpl = self._templates.get(universe)
        if tpl is None:
            blank = bytes(self.config.channels)
            if self.config.protocol == "artnet":
                tpl = bytearray(artnet.build_dmx(universe, 0, blank))
                tpl[13] = self.config.physical
            else:
                tpl = bytearray(
                    sacn.build_data(
                        universe,
                        blank,
                        self._cid,
                        self.config.source_name,
                        self.config.priority,
                        0,
                    )
                )
            self._templates[universe] = tpl
        return tpl

    def _build(self, universe: int, data: bytes, sequence: int, options: int = 0) -> bytes:
        """把数据填进模板并返回一份拷贝。"""
        tpl = self._template(universe)
        n = len(data)
        if self.config.protocol == "artnet":
            tpl[12] = sequence
            tpl[_ARTNET_DATA_OFFSET : _ARTNET_DATA_OFFSET + n] = data
        else:
            tpl[_SACN_PRIORITY_OFFSET] = self.config.priority
            tpl[_SACN_SEQUENCE_OFFSET] = sequence
            tpl[_SACN_OPTIONS_OFFSET] = options
            tpl[_SACN_DATA_OFFSET : _SACN_DATA_OFFSET + n] = data
        return bytes(tpl)

    def _send(self, packet: bytes, universe: int) -> None:
        """发送一个包并更新统计。"""
        if self._transport.send(packet, self._dest[universe]):
            self.stats.packets += 1
        else:
            self.stats.send_errors += 1

    def _dispatch(self, universe: int, packet: bytes, drop_frame: bool) -> None:
        """按故障注入配置决定一个包怎么发。"""
        imp = self.config.impairments
        held = self._held.pop(universe, None)
        if drop_frame or (imp.loss > 0 and self._rng.random() < imp.loss):
            self.stats.dropped += 1
        elif imp.reorder > 0 and held is None and self._rng.random() < imp.reorder:
            self._held[universe] = packet
            self.stats.reordered += 1
        else:
            self._send(packet, universe)
            if imp.duplicate > 0 and self._rng.random() < imp.duplicate:
                self._send(packet, universe)
                self.stats.duplicated += 1
        if held is not None:
            self._send(held, universe)

    # ------------------------------------------------------------------ 控制
    def pause(self) -> None:
        """静默停发:不再发包,也**不**发 Stream_Terminated,用于模拟源异常掉线。"""
        with self._lock:
            if self.state == STATE_RUNNING:
                self.state = STATE_PAUSED

    def resume(self) -> None:
        """从 :meth:`pause` 恢复发送。"""
        with self._lock:
            if self.state == STATE_PAUSED:
                self.state = STATE_RUNNING

    def stop(self, terminate: bool = True) -> None:
        """停止信号源。

        sACN 在 ``terminate`` 为真时,对每个 Universe 连发 3 次带 Stream_Terminated 的包,
        让接收端立刻知道该源已结束,不必等 2.5 秒的数据丢失超时。

        Args:
            terminate: 是否发送 Stream_Terminated(仅 sACN 有效)。
        """
        with self._lock:
            if self.state == STATE_STOPPED:
                return
            was_running = self.state == STATE_RUNNING
            self.state = STATE_STOPPED
            if terminate and self.config.protocol == "sacn" and (was_running or self._seq):
                for universe in self.config.universes:
                    data = self._last_data.get(universe, bytes(self.config.channels))
                    for _ in range(TERMINATE_REPEAT):
                        seq = self._next_seq(universe)
                        packet = self._build(universe, data, seq, sacn.OPT_STREAM_TERMINATED)
                        self._send(packet, universe)

    # ------------------------------------------------------------------ 运行时修改
    def update(self, changes: Mapping[str, Any]) -> None:
        """运行中修改配置。

        可修改:``rate``、``priority``、``channels``、``source_name``、``generator``、
        ``generator_params``、``impairments``(字典)。修改 ``universes``、``protocol``
        等会改变目标地址的字段需要重建信号源。

        Args:
            changes: 字段名到新值的映射。

        Raises:
            ValueError: 含不支持修改的字段,或新值不合法。此时配置保持原样。
        """
        allowed = {
            "rate",
            "priority",
            "channels",
            "source_name",
            "generator",
            "generator_params",
            "impairments",
        }
        unknown = set(changes) - allowed
        if unknown:
            raise ValueError(f"不支持运行中修改: {', '.join(sorted(unknown))}")
        with self._lock:
            cfg = self.config
            new_imp = (
                Impairments.from_dict(dict(changes["impairments"]))
                if "impairments" in changes
                else cfg.impairments
            )
            candidate = SourceConfig(
                id=cfg.id,
                protocol=cfg.protocol,
                universes=list(cfg.universes),
                generator=changes.get("generator", cfg.generator),
                generator_params=dict(changes.get("generator_params", cfg.generator_params)),
                rate=changes.get("rate", cfg.rate),
                priority=changes.get("priority", cfg.priority),
                channels=changes.get("channels", cfg.channels),
                target=cfg.target,
                port=cfg.port,
                interface=cfg.interface,
                source_name=changes.get("source_name", cfg.source_name),
                cid=cfg.cid,
                allow_public=cfg.allow_public,
                physical=cfg.physical,
                impairments=new_imp,
            )
            candidate.validate()
            new_generator = self._generator
            if "generator" in changes or "generator_params" in changes:
                new_generator = make_generator(candidate.generator, candidate.generator_params)
            if candidate.channels != cfg.channels or candidate.source_name != cfg.source_name:
                self._templates.clear()
                self._last_data.clear()
                self._held.clear()
            if new_imp.seed != cfg.impairments.seed:
                self._rng = random.Random(new_imp.seed)
            self.config = candidate
            self._generator = new_generator

    def status(self) -> dict[str, Any]:
        """返回当前状态快照,供 API 使用。

        Returns:
            含状态、配置摘要与统计的字典。
        """
        with self._lock:
            s = self.stats
            return {
                "id": self.config.id,
                "state": self.state,
                "frozen": self.frozen,
                "protocol": self.config.protocol,
                "universes": list(self.config.universes),
                "generator": self.config.generator,
                "rate": self.config.rate,
                "frames": s.frames,
                "packets": s.packets,
                "dropped": s.dropped,
                "duplicated": s.duplicated,
                "reordered": s.reordered,
                "send_errors": s.send_errors,
            }
