"""把抓到的 Art-Net / sACN 数据保存成 ``.artrec`` 节目文件。

采用规范推荐的**变更触发**模式:任一通道变化才产生新帧,画面静止时不产生数据。
为了不让一组几乎同时到达的多个 Universe 各自产生一帧,变化会在 ``coalesce_ms`` 毫秒的
窗口内合并成一帧,帧的时间戳取窗口内第一次变化的时刻。

安全与限制:

- 先写 ``<目标>.part``,正常结束后原子地改名,所以半截文件永远不会冒充合法的 ``.artrec``。
- Universe 集合在开始时固定。编号大于 2047 的 Universe 无法写入 ``.artrec``,会被**跳过**并在
  :class:`RecordReport` 里逐个列出收到的包数,不会悄悄丢掉。
- 接收线程只做过滤和入队;压缩与写盘在独立的写入线程里完成。
"""

from __future__ import annotations

import logging
import os
import queue
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

from artnet_sim.capture.hub import Hub, IngestEvent
from artnet_sim.protocol.artrec import (
    FLAG_DIFF_FRAME,
    MAX_FULL_PAYLOAD,
    MAX_UNIVERSE,
    ArtRecError,
    ArtRecWriter,
    Compress,
    DiffChange,
    UniDesc,
)

logger = logging.getLogger(__name__)

_STOP = object()

#: 每路固定按 512 通道存储;更短的包补零,更长的截断。
_DMX_LEN = 512


@dataclass(slots=True)
class RecorderOptions:
    """录制选项。

    Attributes:
        universes: 要录制的 Universe。大于 2047 的会被跳过并报告。
        protocols: 接受哪些协议的包。
        src_ips: 只接受这些来源 IP 的包;``None`` 表示不限。
        compress: 压缩算法。
        level: Zstd 等级。
        use_diff: 是否在变化很少时写差分帧(文件头会置位 ALLOW_DIFF_FRAME)。
        keyframe_interval_s: 使用差分帧时,最多隔多久写一次全量帧,保证可以快速定位。
        coalesce_ms: 变化合并窗口(毫秒)。
        queue_size: 接收线程到写入线程的队列容量,满了就丢包并计数。
    """

    universes: list[int]
    protocols: frozenset[str] = frozenset({"artnet", "sacn"})
    src_ips: frozenset[str] | None = None
    compress: Compress = Compress.ZSTD
    level: int = 3
    use_diff: bool = False
    keyframe_interval_s: float = 5.0
    coalesce_ms: float = 5.0
    queue_size: int = 200_000


@dataclass(slots=True)
class RecordReport:
    """录制结果。

    Attributes:
        path: 最终文件路径;出错时为 ``None``。
        frames: 写入的帧数。
        duration_us: 节目总时长(微秒)。
        bytes_written: 文件字节数。
        recorded_universes: 实际录制的 Universe(文件里的顺序)。
        skipped_over_limit: 编号超过 2047 而被跳过的 Universe → 收到的包数。
        queue_drops: 因队列满而丢弃的包数。
        error: 写入线程遇到的错误信息;没有错误为 ``None``。
    """

    path: str | None = None
    frames: int = 0
    duration_us: int = 0
    bytes_written: int = 0
    recorded_universes: list[int] = field(default_factory=list)
    skipped_over_limit: dict[int, int] = field(default_factory=dict)
    queue_drops: int = 0
    error: str | None = None


class ArtRecRecorder:
    """录制器。

    Args:
        hub: 抓包中枢,录制器作为它的监听器接收数据。
        path: 目标文件路径(``.artrec``)。
        options: 录制选项。

    Raises:
        ArtRecError: 没有可录制的 Universe,或数量超过单帧上限。
    """

    def __init__(self, hub: Hub, path: str | os.PathLike[str], options: RecorderOptions) -> None:
        self._hub = hub
        self._path = Path(path)
        self._options = options
        self._recordable: list[int] = []
        self._over_limit: dict[int, int] = {}
        for universe in dict.fromkeys(options.universes):
            if 0 <= universe <= MAX_UNIVERSE:
                self._recordable.append(universe)
            else:
                self._over_limit[universe] = 0
        if not self._recordable:
            raise ArtRecError("没有可录制的 Universe(.artrec 只能保存编号 0~2047)")
        if len(self._recordable) * _DMX_LEN > MAX_FULL_PAYLOAD:
            raise ArtRecError(
                f"Universe 太多:{len(self._recordable)} 路 × {_DMX_LEN} 通道超过单帧上限 "
                f"{MAX_FULL_PAYLOAD} 字节(最多 {MAX_FULL_PAYLOAD // _DMX_LEN} 路)"
            )
        self._position = {u: i for i, u in enumerate(self._recordable)}
        self._queue: queue.Queue[object] = queue.Queue(maxsize=options.queue_size)
        self._thread: threading.Thread | None = None
        self._started = False
        self._stopped = False
        self._lock = threading.Lock()
        self._queue_drops = 0
        self._frames = 0
        self._error: str | None = None
        self._report: RecordReport | None = None
        self._result: RecordReport | None = None

    @property
    def recordable_universes(self) -> list[int]:
        """会被录制的 Universe(升序去重后按给定顺序)。"""
        return list(self._recordable)

    @property
    def frames(self) -> int:
        """已写入的帧数(写入线程更新)。"""
        return self._frames

    @property
    def error(self) -> str | None:
        """写入线程遇到的错误;没有为 ``None``。"""
        return self._error

    def start(self) -> None:
        """开始录制。

        Raises:
            ArtRecError: 已经启动过。
            OSError: 无法创建临时文件。
        """
        if self._started:
            raise ArtRecError("录制器已经启动过")
        self._started = True
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._thread = threading.Thread(target=self._run, name="artrec-writer", daemon=True)
        self._thread.start()
        self._hub.add_listener(self._on_event)

    def _on_event(self, event: IngestEvent) -> None:
        """Hub 监听器:过滤并入队(在接收线程里运行,必须很快)。"""
        if event.universe is None or event.protocol not in self._options.protocols:
            return
        if self._error is not None:
            return  # 写入线程已经失败,不再入队
        universe = event.universe
        if universe > MAX_UNIVERSE:
            with self._lock:
                if universe in self._over_limit or len(self._over_limit) < 4096:
                    self._over_limit[universe] = self._over_limit.get(universe, 0) + 1
            return
        position = self._position.get(universe)
        if position is None:
            return
        if self._options.src_ips is not None and event.addr[0] not in self._options.src_ips:
            return
        try:
            self._queue.put_nowait((event.t_ns, position, event.data))
        except queue.Full:
            with self._lock:
                self._queue_drops += 1

    def stop(self) -> RecordReport:
        """停止录制、写出索引并把临时文件改名为最终文件。

        Returns:
            录制结果。重复调用返回同一份结果。
        """
        if self._report is not None:
            return self._report
        self._hub.remove_listener(self._on_event)
        stop_ns = time.perf_counter_ns()
        self._queue.put((_STOP, stop_ns))
        if self._thread is not None:
            self._thread.join(30)
        with self._lock:
            skipped = dict(sorted(self._over_limit.items()))
            drops = self._queue_drops
        report = self._result or RecordReport()
        report.skipped_over_limit = skipped
        report.queue_drops = drops
        report.recorded_universes = list(self._recordable)
        report.error = self._error
        self._report = report
        return report

    # ------------------------------------------------------------------ 写入线程
    def _run(self) -> None:
        """写入线程:合并变化、压缩、写盘,结束时收尾。"""
        options = self._options
        tmp_path = self._path.with_name(self._path.name + ".part")
        count = len(self._recordable)
        shadow = [bytearray(_DMX_LEN) for _ in range(count)]
        emitted = [bytearray(_DMX_LEN) for _ in range(count)]
        flags = FLAG_DIFF_FRAME if options.use_diff else 0
        unis = [UniDesc.from_universe(u, _DMX_LEN) for u in self._recordable]
        coalesce_ns = int(options.coalesce_ms * 1e6)
        keyframe_ns = int(options.keyframe_interval_s * 1e9)
        t0_ns: int | None = None
        pending_since: int | None = None
        last_key_ns = 0
        rec_start_us = time.time_ns() // 1000
        writer: ArtRecWriter | None = None
        fp = None
        stop_ns: int | None = None
        try:
            fp = open(tmp_path, "w+b")  # noqa: SIM115 - 生命周期跨越整个线程
            writer = ArtRecWriter(
                fp,
                unis,
                compress=options.compress,
                level=options.level,
                flags=flags,
                rec_start_us=rec_start_us,
            )

            def emit(at_ns: int) -> None:
                nonlocal last_key_ns
                assert writer is not None and t0_ns is not None
                time_us = max(0, (at_ns - t0_ns) // 1000)
                last = writer.last_time_us
                if last is not None:
                    time_us = max(time_us, last)
                changes: list[DiffChange] | None = None
                if (
                    options.use_diff
                    and writer.frame_count > 0
                    and at_ns - last_key_ns < keyframe_ns
                ):
                    changes = []
                    for ui in range(count):
                        if shadow[ui] != emitted[ui]:
                            changes.extend(
                                DiffChange(ui, ci, new)
                                for ci, (old, new) in enumerate(
                                    zip(emitted[ui], shadow[ui], strict=True)
                                )
                                if old != new
                            )
                    if len(changes) * 5 + 2 >= count * _DMX_LEN:
                        changes = None  # 变化太多,全量帧更划算
                if changes is None:
                    writer.add_full_frame(time_us, shadow)
                    last_key_ns = at_ns
                else:
                    writer.add_diff_frame(time_us, changes)
                for ui in range(count):
                    emitted[ui][:] = shadow[ui]
                self._frames = writer.frame_count

            while True:
                timeout = 0.1
                if pending_since is not None:
                    timeout = max(0.0, (pending_since + coalesce_ns - time.perf_counter_ns()) / 1e9)
                try:
                    item = self._queue.get(timeout=timeout)
                except queue.Empty:
                    item = None
                if isinstance(item, tuple) and item and item[0] is _STOP:
                    stop_ns = item[1]
                    break
                if item is not None:
                    t_ns, position, data = item  # type: ignore[misc]
                    if t0_ns is None:
                        t0_ns = t_ns
                    padded = bytes(data[:_DMX_LEN]).ljust(_DMX_LEN, b"\x00")
                    first_frame = writer.frame_count == 0 and pending_since is None
                    if shadow[position] != padded or first_frame:
                        shadow[position][:] = padded
                        if pending_since is None:
                            pending_since = t_ns
                if (
                    pending_since is not None
                    and time.perf_counter_ns() >= pending_since + coalesce_ns
                ):
                    emit(pending_since)
                    pending_since = None
            # 收尾:清空队列里剩余的数据
            while True:
                try:
                    item = self._queue.get_nowait()
                except queue.Empty:
                    break
                if isinstance(item, tuple) and item and item[0] is not _STOP:
                    t_ns, position, data = item  # type: ignore[misc]
                    if t0_ns is None:
                        t0_ns = t_ns
                    padded = bytes(data[:_DMX_LEN]).ljust(_DMX_LEN, b"\x00")
                    if shadow[position] != padded:
                        shadow[position][:] = padded
                        if pending_since is None:
                            pending_since = t_ns
            if pending_since is not None:
                emit(pending_since)
            duration_us = 0
            if writer.frame_count and t0_ns is not None and stop_ns is not None:
                duration_us = max(writer.last_time_us or 0, (stop_ns - t0_ns) // 1000)
                if duration_us > (writer.last_time_us or 0):
                    # 规范要求最后一帧的时间戳等于总时长:补一帧相同画面,保留尾部的静止时间
                    writer.add_full_frame(duration_us, shadow)
                    self._frames = writer.frame_count
            writer.finish(duration_us if writer.frame_count else 0)
            fp.close()
            fp = None
            os.replace(tmp_path, self._path)
            self._result = RecordReport(
                path=str(self._path),
                frames=writer.frame_count,
                duration_us=duration_us,
                bytes_written=self._path.stat().st_size,
            )
        except (ArtRecError, OSError) as exc:
            logger.exception("录制写入失败")
            self._error = str(exc)
            self._result = RecordReport(frames=self._frames)
            if fp is not None:
                fp.close()
        finally:
            if fp is not None and not fp.closed:
                fp.close()
