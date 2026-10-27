"""``.artrec`` 回放生成器:把录制好的节目作为信号源。"""

from __future__ import annotations

from typing import Any, ClassVar

from artnet_sim.generators.base import Generator, Param
from artnet_sim.protocol.artrec import CHUNK_FULL, ArtRecReader, apply_diff, decode_diff
from artnet_sim.protocol.common import SACN_MIN_UNIVERSE

#: 向前追赶超过这么多帧时,改为从最近的全量帧重建,而不是逐帧应用。
_MAX_CATCH_UP_FRAMES = 200


class ArtRecPlayer(Generator):
    """按节目文件的时间轴输出画面。

    信号源的 Universe 列表必须与文件里的 Universe 顺序一一对应,可以用
    :func:`source_config_from_artrec` 自动生成。

    回放时间 = ``start + t × speed``。``loop`` 为真时对节目时长取模循环;否则播完后停在最后一帧。
    早于首帧的时间输出全 0。
    """

    name = "artrec"
    label = "节目回放(.artrec)"
    PARAMS: ClassVar = {
        "path": Param("", "str", ".artrec 文件路径"),
        "loop": Param(True, "bool", "循环播放"),
        "speed": Param(1.0, "float", "倍速", 0, None, exclusive_minimum=True),
        "start": Param(0.0, "float", "起始位置(秒)", 0),
    }

    def setup(self) -> None:
        """读入节目文件并建立回放状态。"""
        path = self.params["path"]
        if not path:
            raise ValueError("artrec 生成器必须提供 path 参数")
        self.reader = ArtRecReader.open(path)
        self._current = -1
        self._buffers = [bytearray(u.dmx_len) for u in self.reader.unis]

    def _goto(self, target: int) -> None:
        """把内部画面推进(或重建)到第 ``target`` 帧。"""
        if target == self._current:
            return
        if target < 0:
            self._buffers = [bytearray(u.dmx_len) for u in self.reader.unis]
        elif self._current >= 0 and 0 < target - self._current <= _MAX_CATCH_UP_FRAMES:
            for i in range(self._current + 1, target + 1):
                hdr, raw = self.reader.read_chunk(i)
                if hdr.chunk_type == CHUNK_FULL:
                    self._buffers = self.reader.split_full(raw)
                else:
                    apply_diff(self._buffers, decode_diff(raw))
        else:
            self._buffers = self.reader.buffers_at(target)
        self._current = target

    def position_us(self, t: float) -> int:
        """把信号源时间换算成节目内的播放位置。

        Args:
            t: 信号源启动后经过的秒数。

        Returns:
            节目内的位置(微秒),已按 ``loop`` 取模或夹到末尾。
        """
        p = self.params
        position = int((p["start"] + t * p["speed"]) * 1e6)
        duration = self.reader.duration_us
        if duration <= 0:
            return 0
        return position % duration if p["loop"] else min(position, duration)

    def render(self, t: float, index: int, length: int) -> bytes:
        """返回时刻 ``t`` 第 ``index`` 路的画面。"""
        self._goto(self.reader.frame_at_time(self.position_us(t)))
        if index >= len(self._buffers):
            return bytes(length)
        return bytes(self._buffers[index][:length]).ljust(length, b"\x00")


def source_config_from_artrec(
    path: str,
    *,
    source_id: str = "artrec",
    protocol: str = "artnet",
    universe_offset: int = 0,
    **options: Any,
) -> Any:
    """由节目文件生成对应的信号源配置:Universe 列表取自文件,生成器设为 ``artrec``。

    Args:
        path: ``.artrec`` 文件路径。
        source_id: 信号源 id。
        protocol: ``artnet`` 或 ``sacn``。
        universe_offset: 给文件里的 Universe 编号统一加上的偏移(例如 sACN 不能用 Universe 0,
            可以加 1)。
        **options: 传给 :class:`~artnet_sim.sender.source.SourceConfig` 的其他字段;
            其中 ``generator_params`` 会与 ``path`` 合并,可放 ``loop`` / ``speed`` / ``start``。

    Returns:
        尚未校验网络目标的 ``SourceConfig``。

    Raises:
        ValueError: 偏移后的 Universe 超出协议允许的范围。
        ArtRecError: 文件不合法。
        OSError: 文件无法读取。
    """
    from artnet_sim.sender.source import SourceConfig

    reader = ArtRecReader.open(path)
    universes = [u + universe_offset for u in reader.universes]
    if protocol == "sacn" and any(u < SACN_MIN_UNIVERSE for u in universes):
        raise ValueError("sACN 的 Universe 从 1 开始;文件里有 Universe 0,请设置 universe_offset=1")
    params = {"path": path, **options.pop("generator_params", {})}
    config = SourceConfig(
        id=source_id,
        protocol=protocol,
        universes=universes,
        generator="artrec",
        generator_params=params,
        **options,
    )
    config.validate()
    return config
