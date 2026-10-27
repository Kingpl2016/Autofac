"""生成 Art-Net Studio 的应用图标（写入 src-tauri/icons）。

图标是一个"信号枢纽"：中间的控台节点向三个灯具节点发出信号线，
三个节点的颜色取自 DMX 电平刻度的冷 → 暖（蓝、青、琥珀），底色是深蓝的圆角方块。
同一组几何参数也写在 `src/shared/components/AppLogo.tsx` 里（关于页使用），改动时两处一起改。

用法（需要 Pillow 与 numpy）::

    python scripts/generate_icons.py

输出：icon.png（512）、32x32.png、128x128.png、128x128@2x.png（256）、icon.ico（16~256 多尺寸）。
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "src-tauri" / "icons"

# ---- 几何（512 x 512 设计空间，与 AppLogo.tsx 保持一致） ----
SIZE = 512
SCALE = 4  # 内部超采样倍数，最后缩小抗锯齿
RADIUS = 112  # 底板圆角
HUB = (256, 272)
HUB_R = 62  # 枢纽外圈半径
HUB_STROKE = 16
HUB_DOT = 24
NODE_R = 40
NODE_RING_R = 58
NODE_RING_W = 8
SPOKE_W = 20
RING_R = 200
RING_W = 6

# (坐标, 颜色)：冷 → 暖
NODES = [
    ((128, 152), (0x5B, 0x8C, 0xFF)),  # 蓝
    ((384, 152), (0x2D, 0xD4, 0xE0)),  # 青
    ((256, 432), (0xFF, 0xB5, 0x47)),  # 琥珀
]
HUB_COLOR = (0xEA, 0xF0, 0xFF)
HUB_FILL = (0x0E, 0x13, 0x30)
BG_TOP = (0x22, 0x2D, 0x6B)
BG_BOTTOM = (0x09, 0x0C, 0x1F)
GLOW = (0x4A, 0x6D, 0xFF)


def s(v: float) -> float:
    """设计空间 → 画布坐标。"""
    return v * SCALE


def circle(draw: ImageDraw.ImageDraw, c: tuple[float, float], r: float, **kw) -> None:
    """按设计空间画圆。"""
    x, y = s(c[0]), s(c[1])
    draw.ellipse((x - s(r), y - s(r), x + s(r), y + s(r)), **kw)


def lerp(a: tuple[int, int, int], b: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    """颜色线性插值。"""
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))  # type: ignore[return-value]


def background(n: int) -> Image.Image:
    """竖向渐变底色 + 枢纽处的柔和光晕。"""
    t = np.linspace(0.0, 1.0, n, dtype=np.float32)[:, None, None]
    top = np.array(BG_TOP, dtype=np.float32)
    bottom = np.array(BG_BOTTOM, dtype=np.float32)
    arr = np.broadcast_to(top + (bottom - top) * t, (n, n, 3)).astype(np.uint8)
    img = Image.fromarray(arr, "RGB").convert("RGBA")

    glow = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    circle(gd, HUB, 170, fill=(*GLOW, 120))
    glow = glow.filter(ImageFilter.GaussianBlur(s(70)))
    return Image.alpha_composite(img, glow)


def foreground(n: int) -> Image.Image:
    """信号线、节点与枢纽（透明底）。"""
    layer = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    # 背景里的同心细环，增加层次
    circle(d, HUB, RING_R, outline=(255, 255, 255, 22), width=round(s(RING_W)))

    # 信号线：从枢纽色渐变到节点色，用一串圆点拼出圆头线条
    steps = 80
    for pos, color in NODES:
        for i in range(steps + 1):
            t = i / steps
            x = HUB[0] + (pos[0] - HUB[0]) * t
            y = HUB[1] + (pos[1] - HUB[1]) * t
            circle(d, (x, y), SPOKE_W / 2, fill=(*lerp(HUB_COLOR, color, t ** 0.8), 255))

    # 节点：外圈淡环 + 实心圆
    for pos, color in NODES:
        circle(d, pos, NODE_RING_R, outline=(*color, 90), width=round(s(NODE_RING_W)))
        circle(d, pos, NODE_R, fill=(*color, 255))

    # 枢纽：深色底 + 亮环 + 中心点
    circle(d, HUB, HUB_R, fill=(*HUB_FILL, 255), outline=(*HUB_COLOR, 255), width=round(s(HUB_STROKE)))
    circle(d, HUB, HUB_DOT, fill=(*HUB_COLOR, 255))
    return layer


def node_glow(n: int) -> Image.Image:
    """节点的彩色发光，垫在前景下面。"""
    layer = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for pos, color in NODES:
        circle(d, pos, NODE_R + 14, fill=(*color, 170))
    return layer.filter(ImageFilter.GaussianBlur(s(26)))


def render() -> Image.Image:
    """渲染 4 倍大小的完整图标（带圆角透明边）。"""
    n = SIZE * SCALE
    img = background(n)
    img = Image.alpha_composite(img, node_glow(n))
    img = Image.alpha_composite(img, foreground(n))

    mask = Image.new("L", (n, n), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, n - 1, n - 1), radius=round(s(RADIUS)), fill=255)
    img.putalpha(mask)
    return img


def main() -> None:
    """生成全部尺寸并写盘。"""
    big = render()

    def at(px: int) -> Image.Image:
        return big.resize((px, px), Image.Resampling.LANCZOS)

    OUT.mkdir(parents=True, exist_ok=True)
    at(512).save(OUT / "icon.png")
    at(32).save(OUT / "32x32.png")
    at(128).save(OUT / "128x128.png")
    at(256).save(OUT / "128x128@2x.png")
    sizes = [16, 24, 32, 48, 64, 128, 256]
    at(256).save(OUT / "icon.ico", format="ICO", sizes=[(p, p) for p in sizes])
    print("写入", OUT)


if __name__ == "__main__":
    main()
