"""抓包中枢:解析收到的报文,维护每条数据流的统计与每个 Universe 的最新数据。

接收线程调用 :meth:`Hub.ingest`;界面/CLI 从别的线程调用 :meth:`Hub.snapshot` 等只读方法。
内部用一把锁保护状态,监听器(例如录制器)在锁外被调用,避免互相死锁。
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from artnet_sim.capture.packet_log import PacketLog
from artnet_sim.capture.stats import (
    EVENT_DUPLICATE,
    EVENT_LATE,
    IntervalStats,
    RateMeter,
    SeqEvent,
    SequenceTracker,
)
from artnet_sim.protocol import artnet, sacn

logger = logging.getLogger(__name__)

#: 超过这个时间没收到包,数据流视为不活跃(秒)。sACN 规范的数据丢失超时为 2.5 秒。
ACTIVE_TIMEOUT_S = sacn.NETWORK_DATA_LOSS_TIMEOUT_S

#: 最多同时跟踪多少条数据流,防止恶意或异常的发送方撑爆内存。
MAX_STREAMS = 4096

StreamKey = tuple[str, str, int]


class StreamStats:
    """一条数据流(协议 + 来源 + Universe)的统计。

    Args:
        protocol: ``artnet`` 或 ``sacn``。
        source_id: 来源标识,Art-Net 为来源 IP,sACN 为 CID 的十六进制。
        universe: Universe 编号。
        src_ip: 最近一次的来源 IP。
        t_ns: 首个包的到达时刻(纳秒)。
    """

    def __init__(
        self, protocol: str, source_id: str, universe: int, src_ip: str, t_ns: int
    ) -> None:
        self.protocol = protocol
        self.source_id = source_id
        self.universe = universe
        self.src_ip = src_ip
        self.src_port = 0
        self.source_name = ""
        self.cid = ""
        self.priority: int | None = None
        self.first_ns = t_ns
        self.last_ns = t_ns
        self.packets = 0
        self.bytes = 0
        self.terminated = False
        self.preview = False
        self.last_data = b""
        self.seq = SequenceTracker(protocol)
        self.intervals = IntervalStats()
        self._rate = RateMeter(1.0)

    def observe(
        self,
        t_ns: int,
        size: int,
        sequence: int,
        data: bytes,
        src_ip: str,
        src_port: int,
    ) -> SeqEvent:
        """记录一个到达的数据包。

        Args:
            t_ns: 到达时刻(纳秒)。
            size: UDP 载荷字节数。
            sequence: 包里的序号。
            data: 通道数据。
            src_ip: 来源 IP。
            src_port: 来源端口。

        Returns:
            序号判定结果。
        """
        if self.packets > 0:
            self.intervals.add((t_ns - self.last_ns) / 1e9)
        self.last_ns = t_ns
        self.packets += 1
        self.bytes += size
        self.src_ip = src_ip
        self.src_port = src_port
        self._rate.add(t_ns, size)
        event = self.seq.observe(sequence)
        # 重复包与迟到的旧包不应覆盖更新的数据。
        if event.kind not in (EVENT_DUPLICATE, EVENT_LATE):
            self.last_data = data
        return event

    def active(self, now_ns: int) -> bool:
        """数据流当前是否活跃:未被终止,且最近 :data:`ACTIVE_TIMEOUT_S` 秒内有包。"""
        return not self.terminated and (now_ns - self.last_ns) / 1e9 <= ACTIVE_TIMEOUT_S

    def snapshot(self, now_ns: int) -> dict[str, Any]:
        """导出统计快照。

        Args:
            now_ns: 当前时刻(纳秒,单调时钟)。

        Returns:
            可直接 JSON 序列化的字典;时间类字段单位为毫秒。
        """
        pps, bps = self._rate.rates(now_ns)
        iv = self.intervals
        return {
            "protocol": self.protocol,
            "source_id": self.source_id,
            "universe": self.universe,
            "src_ip": self.src_ip,
            "src_port": self.src_port,
            "source_name": self.source_name,
            "cid": self.cid,
            "priority": self.priority,
            "active": self.active(now_ns),
            "terminated": self.terminated,
            "preview": self.preview,
            "packets": self.packets,
            "bytes": self.bytes,
            "pps": round(pps, 2),
            "bytes_per_second": round(bps, 1),
            "lost": self.seq.lost,
            "out_of_order": self.seq.out_of_order,
            "duplicates": self.seq.duplicates,
            "resets": self.seq.resets,
            "untracked": self.seq.untracked,
            "interval_mean_ms": round(iv.mean * 1e3, 3),
            "interval_stddev_ms": round(iv.stddev * 1e3, 3),
            "interval_min_ms": round(iv.minimum * 1e3, 3) if iv.count else 0.0,
            "interval_p99_ms": round(iv.percentile(0.99) * 1e3, 3),
            "interval_max_ms": round(iv.maximum * 1e3, 3),
            "age_ms": round((now_ns - self.last_ns) / 1e6, 1),
            "channels": len(self.last_data),
        }


@dataclass(frozen=True, slots=True)
class IngestEvent:
    """:meth:`Hub.ingest` 处理完一个报文后通知监听器的事件。

    Attributes:
        t_ns: 到达时刻(纳秒,单调时钟)。
        addr: 来源 ``(IP, 端口)``。
        protocol: ``artnet`` / ``sacn`` / ``unknown``。
        kind: 报文种类,如 ``dmx``、``poll``、``data``、``sync``;无法识别为 ``other``。
        universe: 数据包的 Universe;非数据包为 ``None``。
        sequence: 数据包序号;非数据包为 ``None``。
        data: 数据包的通道数据;非数据包为空。
        raw: 完整 UDP 载荷。
        stream: 所属数据流的统计对象;非数据包为 ``None``。
        seq_event: 序号判定结果;非数据包为 ``None``。
    """

    t_ns: int
    addr: tuple[str, int]
    protocol: str
    kind: str
    universe: int | None
    sequence: int | None
    data: bytes
    raw: bytes
    stream: StreamStats | None = field(default=None, compare=False)
    seq_event: SeqEvent | None = None


Listener = Callable[[IngestEvent], None]


class Hub:
    """抓包中枢。

    Args:
        log_capacity: 包日志容量。
        max_streams: 最多跟踪的数据流条数。
    """

    def __init__(self, log_capacity: int = 5000, max_streams: int = MAX_STREAMS) -> None:
        self._lock = threading.RLock()
        self._streams: dict[StreamKey, StreamStats] = {}
        self._max_streams = max_streams
        self._listeners: list[Listener] = []
        self._kinds: dict[str, int] = {}
        self._started_ns = time.perf_counter_ns()
        self._dropped_streams = 0
        self._unknown = 0
        self.log = PacketLog(log_capacity)

    @property
    def started_ns(self) -> int:
        """统计开始(或最近一次清空)的时刻,``perf_counter_ns`` 时间轴。"""
        return self._started_ns

    # ------------------------------------------------------------------ 监听
    def add_listener(self, listener: Listener) -> None:
        """注册监听器,每个报文处理完后在接收线程里被调用。

        监听器必须快速返回;抛出的异常会被记录并忽略。

        Args:
            listener: 回调函数。
        """
        with self._lock:
            self._listeners.append(listener)

    def remove_listener(self, listener: Listener) -> None:
        """注销监听器。

        Args:
            listener: 之前注册的回调。
        """
        with self._lock:
            if listener in self._listeners:
                self._listeners.remove(listener)

    # ------------------------------------------------------------------ 摄入
    def ingest(self, data: bytes, addr: tuple[str, int], t_ns: int) -> IngestEvent:
        """处理一个收到的 UDP 报文。可从任意接收线程调用。

        Args:
            data: UDP 载荷。
            addr: 来源 ``(IP, 端口)``。
            t_ns: 到达时刻(``time.perf_counter_ns()``)。

        Returns:
            处理结果事件。
        """
        event = self._classify(data, addr, t_ns)
        self.log.add(t_ns, addr, event.protocol, event.universe, data)
        with self._lock:
            listeners = list(self._listeners)
        for listener in listeners:
            try:
                listener(event)
            except Exception:
                logger.exception("Hub 监听器异常,已忽略")
        return event

    def _count_kind(self, label: str) -> None:
        """累加报文种类计数(调用方须持锁)。"""
        self._kinds[label] = self._kinds.get(label, 0) + 1

    def _classify(self, data: bytes, addr: tuple[str, int], t_ns: int) -> IngestEvent:
        """解析报文并更新统计。"""
        opcode = artnet.opcode_of(data)
        if opcode is not None:
            if opcode == artnet.OpCode.DMX:
                dmx = artnet.parse_dmx(data)
                if dmx is not None:
                    return self._observe(
                        "artnet",
                        addr[0],
                        "",
                        dmx.port_address,
                        dmx.sequence,
                        dmx.data,
                        data,
                        addr,
                        t_ns,
                        None,
                    )
            try:
                label = f"artnet.{artnet.OpCode(opcode).name.lower()}"
            except ValueError:
                label = "artnet.other"
            with self._lock:
                self._count_kind(label)
            return IngestEvent(t_ns, addr, "artnet", label.split(".", 1)[1], None, None, b"", data)
        if sacn.is_sacn(data):
            kind = sacn.packet_kind(data)
            if kind == "data":
                parsed = sacn.parse_data(data)
                if parsed is not None:
                    return self._observe(
                        "sacn",
                        parsed.cid.hex(),
                        parsed.cid.hex(),
                        parsed.universe,
                        parsed.sequence,
                        parsed.data,
                        data,
                        addr,
                        t_ns,
                        parsed,
                    )
            label = f"sacn.{kind or 'other'}"
            with self._lock:
                self._count_kind(label)
            return IngestEvent(t_ns, addr, "sacn", kind or "other", None, None, b"", data)
        with self._lock:
            self._unknown += 1
        return IngestEvent(t_ns, addr, "unknown", "other", None, None, b"", data)

    def _observe(
        self,
        protocol: str,
        source_id: str,
        cid: str,
        universe: int,
        sequence: int,
        channels: bytes,
        raw: bytes,
        addr: tuple[str, int],
        t_ns: int,
        sacn_packet: sacn.SacnData | None,
    ) -> IngestEvent:
        """把一个数据包记入对应的数据流。"""
        key: StreamKey = (protocol, source_id, universe)
        with self._lock:
            stream = self._streams.get(key)
            if stream is None:
                if len(self._streams) >= self._max_streams:
                    self._dropped_streams += 1
                    return IngestEvent(
                        t_ns, addr, protocol, "data", universe, sequence, channels, raw
                    )
                stream = StreamStats(protocol, source_id, universe, addr[0], t_ns)
                self._streams[key] = stream
            event = stream.observe(t_ns, len(raw), sequence, channels, addr[0], addr[1])
            if sacn_packet is not None:
                stream.cid = cid
                stream.source_name = sacn_packet.source_name
                stream.priority = sacn_packet.priority
                stream.preview = sacn_packet.preview
                stream.terminated = sacn_packet.terminated
            self._count_kind(f"{protocol}.data")
            return IngestEvent(
                t_ns, addr, protocol, "data", universe, sequence, channels, raw, stream, event
            )

    # ------------------------------------------------------------------ 查询
    def latest(self, protocol: str, universe: int) -> tuple[bytes, int, str] | None:
        """取某 Universe 最近到达的一帧数据。

        Args:
            protocol: ``artnet`` 或 ``sacn``。
            universe: Universe 编号。

        Returns:
            ``(通道数据, 到达时刻 ns, 来源标识)``;从未收到过则为 ``None``。
        """
        with self._lock:
            best: StreamStats | None = None
            for (proto, _src, uni), stream in self._streams.items():
                if (
                    proto == protocol
                    and uni == universe
                    and (best is None or stream.last_ns > best.last_ns)
                ):
                    best = stream
            if best is None:
                return None
            return best.last_data, best.last_ns, best.source_id

    def streams(self) -> list[StreamStats]:
        """返回全部数据流对象的快照列表(对象本身仍会被接收线程更新)。"""
        with self._lock:
            return list(self._streams.values())

    def snapshot(self, now_ns: int | None = None) -> dict[str, Any]:
        """导出整体统计快照。

        Args:
            now_ns: 当前时刻;默认取 ``time.perf_counter_ns()``。

        Returns:
            含 ``streams``(按协议、Universe、来源排序)与 ``totals`` 的字典。
        """
        now = time.perf_counter_ns() if now_ns is None else now_ns
        with self._lock:
            streams = sorted(
                self._streams.values(), key=lambda s: (s.protocol, s.universe, s.source_id)
            )
            return {
                "uptime_s": round((now - self._started_ns) / 1e9, 2),
                "streams": [s.snapshot(now) for s in streams],
                "totals": {
                    "kinds": dict(sorted(self._kinds.items())),
                    "unknown": self._unknown,
                    "dropped_streams": self._dropped_streams,
                    "logged": self.log.total,
                },
            }

    def clear(self) -> None:
        """清空全部统计与包日志。"""
        with self._lock:
            self._streams.clear()
            self._kinds.clear()
            self._unknown = 0
            self._dropped_streams = 0
            self._started_ns = time.perf_counter_ns()
        self.log.clear()
