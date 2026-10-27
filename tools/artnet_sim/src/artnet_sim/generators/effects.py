"""内置效果生成器:fixed、ramp、sine、rainbow、chase、strobe、random。

所有空间型效果(sine、rainbow、chase)都用"预先算好一个周期的图案,按时间平移后切片"
的方式实现,每帧只有一次 ``bytes`` 切片,不需要逐通道的 Python 循环。
"""

from __future__ import annotations

import colorsys
import math
import random
from typing import Any, ClassVar

from artnet_sim.generators.artrec_player import ArtRecPlayer
from artnet_sim.generators.base import Generator, Param


def _byte(value: float) -> int:
    """把浮点数四舍五入并限制到 0~255。"""
    return max(0, min(255, round(value)))


class Fixed(Generator):
    """所有通道固定为同一个值。"""

    name = "fixed"
    label = "固定值"
    PARAMS: ClassVar = {"value": Param(255, "int", "数值", 0, 255)}

    def render(self, t: float, index: int, length: int) -> bytes:
        """返回全部填充为 ``value`` 的一帧。"""
        return bytes((self.params["value"],)) * length


class Ramp(Generator):
    """所有通道同步地做线性渐变(锯齿或三角)。"""

    name = "ramp"
    label = "渐变"
    PARAMS: ClassVar = {
        "period": Param(4.0, "float", "周期(秒)", 0, None, exclusive_minimum=True),
        "mode": Param("triangle", "choice", "形状", choices=("up", "down", "triangle")),
        "low": Param(0, "int", "最小值", 0, 255),
        "high": Param(255, "int", "最大值", 0, 255),
    }

    def render(self, t: float, index: int, length: int) -> bytes:
        """返回时刻 ``t`` 的渐变值填充的一帧。"""
        p = self.params
        phase = (t / p["period"]) % 1.0
        if p["mode"] == "up":
            x = phase
        elif p["mode"] == "down":
            x = 1.0 - phase
        else:
            x = 2.0 * phase if phase < 0.5 else 2.0 * (1.0 - phase)
        return bytes((_byte(p["low"] + (p["high"] - p["low"]) * x),)) * length


class Sine(Generator):
    """正弦波。``wavelength`` 为 0 时所有通道同步起伏,否则是沿通道方向行进的波。"""

    name = "sine"
    label = "正弦波"
    PARAMS: ClassVar = {
        "period": Param(4.0, "float", "周期(秒)", 0, None, exclusive_minimum=True),
        "wavelength": Param(64, "int", "波长(通道数,0 为整体起伏)", 0, 512),
        "low": Param(0, "int", "最小值", 0, 255),
        "high": Param(255, "int", "最大值", 0, 255),
    }

    def setup(self) -> None:
        """预计算一个波长的图案并铺开成足够长的字节串。"""
        w = self.params["wavelength"]
        self._pattern = b""
        self._tiled = b""
        if w >= 1:
            lo, hi = self.params["low"], self.params["high"]
            self._pattern = bytes(
                _byte(lo + (hi - lo) * (0.5 + 0.5 * math.sin(2 * math.pi * c / w)))
                for c in range(w)
            )
            self._tiled = self._pattern * (512 // w + 3)

    def render(self, t: float, index: int, length: int) -> bytes:
        """返回时刻 ``t`` 的一帧。"""
        p = self.params
        w = p["wavelength"]
        if w == 0:
            lo, hi = p["low"], p["high"]
            x = 0.5 + 0.5 * math.sin(2 * math.pi * t / p["period"])
            return bytes((_byte(lo + (hi - lo) * x),)) * length
        shift = int(t / p["period"] * w)
        # 全局通道 g = index * length + c 处的值是 pattern[(g - shift) % w],
        # 这样相邻 Universe 的波形首尾相接。
        start = (index * length - shift) % w
        return self._tiled[start : start + length]


class Rainbow(Generator):
    """以 RGB 三通道为一个像素的彩虹,沿通道方向流动,相邻 Universe 首尾相接。"""

    name = "rainbow"
    label = "彩虹"
    PARAMS: ClassVar = {
        "speed": Param(0.25, "float", "速度(圈/秒,负数反向)"),
        "pixels_per_cycle": Param(60, "int", "一圈的像素数", 3, 512),
    }

    def setup(self) -> None:
        """预计算一圈的 RGB 像素并铺开。"""
        n = self.params["pixels_per_cycle"]
        pixels = bytearray()
        for k in range(n):
            r, g, b = colorsys.hsv_to_rgb(k / n, 1.0, 1.0)
            pixels += bytes((_byte(r * 255), _byte(g * 255), _byte(b * 255)))
        self._pixels = n
        self._tiled = bytes(pixels) * (512 // 3 // n + 4)

    def render(self, t: float, index: int, length: int) -> bytes:
        """返回时刻 ``t`` 的一帧。"""
        n = self._pixels
        shift = int(t * self.params["speed"] * n)
        # 全局像素 g = index * (length // 3) + j 处的色相是 pattern[(g - shift) % n]。
        start = ((index * (length // 3) - shift) % n) * 3
        return self._tiled[start : start + length]


class Chase(Generator):
    """一段高亮通道在背景上沿通道方向移动。"""

    name = "chase"
    label = "追逐"
    PARAMS: ClassVar = {
        "width": Param(8, "int", "亮段宽度(通道数)", 1, 512),
        "speed": Param(60.0, "float", "速度(通道/秒)", 0),
        "value": Param(255, "int", "亮段数值", 0, 255),
        "background": Param(0, "int", "背景数值", 0, 255),
        "stagger": Param(0, "int", "相邻 Universe 的错位(通道数)", 0, 512),
    }

    def setup(self) -> None:
        """准备按通道数缓存的图案表。"""
        self._cache: dict[int, bytes] = {}

    def render(self, t: float, index: int, length: int) -> bytes:
        """返回时刻 ``t`` 的一帧。"""
        p = self.params
        doubled = self._cache.get(length)
        if doubled is None:
            width = min(p["width"], length)
            block = bytes((p["value"],)) * width + bytes((p["background"],)) * (length - width)
            doubled = block + block
            self._cache[length] = doubled
        pos = (int(t * p["speed"]) + index * p["stagger"]) % length
        start = (-pos) % length
        return doubled[start : start + length]


class Strobe(Generator):
    """整体频闪。"""

    name = "strobe"
    label = "频闪"
    PARAMS: ClassVar = {
        "rate": Param(5.0, "float", "频率(Hz)", 0, None, exclusive_minimum=True),
        "duty": Param(0.5, "float", "亮的占比(0~1)", 0, 1, exclusive_minimum=True),
        "value": Param(255, "int", "亮时数值", 0, 255),
        "background": Param(0, "int", "灭时数值", 0, 255),
    }

    def render(self, t: float, index: int, length: int) -> bytes:
        """返回时刻 ``t`` 的一帧。"""
        p = self.params
        on = (t * p["rate"]) % 1.0 < p["duty"]
        return bytes((p["value"] if on else p["background"],)) * length


class RandomNoise(Generator):
    """随机噪声。给定 ``seed`` 时结果可复现。"""

    name = "random"
    label = "随机噪声"
    PARAMS: ClassVar = {
        "seed": Param(0, "int", "随机种子", 0, None),
        "change_hz": Param(0.0, "float", "变化频率(Hz,0 为每帧变化)", 0),
    }

    def setup(self) -> None:
        """创建随机数发生器与按 Universe 的缓存。"""
        self._rng = random.Random(self.params["seed"])
        self._last: dict[int, tuple[int, bytes]] = {}

    def render(self, t: float, index: int, length: int) -> bytes:
        """返回时刻 ``t`` 的一帧。"""
        hz = self.params["change_hz"]
        if hz <= 0:
            return self._rng.randbytes(length)
        step = int(t * hz)
        cached = self._last.get(index)
        if cached is not None and cached[0] == step and len(cached[1]) == length:
            return cached[1]
        data = self._rng.randbytes(length)
        self._last[index] = (step, data)
        return data


#: 生成器注册表:名字 → 类。
GENERATORS: dict[str, type[Generator]] = {
    cls.name: cls for cls in (Fixed, Ramp, Sine, Rainbow, Chase, Strobe, RandomNoise, ArtRecPlayer)
}


def make_generator(name: str, params: dict[str, Any] | None = None) -> Generator:
    """按名字创建生成器。

    Args:
        name: 生成器名,见 :data:`GENERATORS`。
        params: 生成器参数。

    Returns:
        生成器实例。

    Raises:
        ValueError: 名字未知,或参数不合法。
    """
    cls = GENERATORS.get(name)
    if cls is None:
        raise ValueError(f"未知生成器 {name!r};可用: {', '.join(GENERATORS)}")
    return cls(**(params or {}))


def describe_generators() -> list[dict[str, Any]]:
    """导出全部生成器及参数规格,供界面和 API 使用。

    Returns:
        每个生成器一项的字典列表。
    """
    result = []
    for cls in GENERATORS.values():
        result.append(
            {
                "name": cls.name,
                "label": cls.label,
                "params": {
                    key: {
                        "kind": spec.kind,
                        "label": spec.label,
                        "default": spec.default,
                        "minimum": spec.minimum,
                        "maximum": spec.maximum,
                        "choices": list(spec.choices),
                    }
                    for key, spec in cls.PARAMS.items()
                },
            }
        )
    return result
