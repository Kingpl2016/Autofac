import colorsys
import math
import time

import pytest

from artnet_sim.generators import GENERATORS, describe_generators, make_generator


def test_registry_and_descriptions():
    assert set(GENERATORS) == {
        "fixed",
        "ramp",
        "sine",
        "rainbow",
        "chase",
        "strobe",
        "random",
        "artrec",
    }
    described = {d["name"]: d for d in describe_generators()}
    assert described["rainbow"]["params"]["speed"]["kind"] == "float"
    assert described["ramp"]["params"]["mode"]["choices"] == ["up", "down", "triangle"]
    assert all(d["label"] for d in described.values())


def test_every_generator_returns_exact_length():
    for name in GENERATORS:
        if name == "artrec":
            continue  # 需要文件,见 test_artrec.py
        gen = make_generator(name)
        for length in (1, 3, 100, 512):
            for t in (0.0, 0.37, 12.5):
                for index in (0, 1, 7):
                    assert len(gen.render(t, index, length)) == length, (name, length)


def test_fixed():
    gen = make_generator("fixed", {"value": 77})
    assert gen.render(5.0, 0, 4) == bytes([77] * 4)
    assert make_generator("fixed").render(0, 0, 2) == b"\xff\xff"


def test_ramp_modes():
    up = make_generator("ramp", {"period": 4.0, "mode": "up"})
    assert up.render(0.0, 0, 1) == b"\x00"
    assert up.render(2.0, 0, 1)[0] in (127, 128)
    down = make_generator("ramp", {"period": 4.0, "mode": "down"})
    assert down.render(0.0, 0, 1) == b"\xff"
    tri = make_generator("ramp", {"period": 4.0, "mode": "triangle"})
    assert tri.render(0.0, 0, 1) == b"\x00"
    assert tri.render(2.0, 0, 1) == b"\xff"
    assert tri.render(4.0, 0, 1) == b"\x00"
    bounded = make_generator("ramp", {"period": 2.0, "mode": "up", "low": 10, "high": 20})
    assert 10 <= bounded.render(1.0, 0, 1)[0] <= 20


def test_sine_uniform():
    gen = make_generator("sine", {"period": 4.0, "wavelength": 0})
    assert gen.render(0.0, 0, 3)[0] in (127, 128)
    assert gen.render(1.0, 0, 1) == b"\xff"  # 四分之一周期到达峰值
    assert gen.render(3.0, 0, 1) == b"\x00"


def test_sine_traveling_wave_is_continuous_across_universes():
    w = 50
    gen = make_generator("sine", {"period": 2.0, "wavelength": w})
    pattern = [round(255 * (0.5 + 0.5 * math.sin(2 * math.pi * c / w))) for c in range(w)]
    t = 0.0
    frame0 = gen.render(t, 0, 512)
    assert list(frame0[:w]) == pattern
    t = 0.2  # shift = int(0.2 / 2.0 * 50) = 5
    shift = 5
    joined = gen.render(t, 0, 512) + gen.render(t, 1, 512)
    for g in range(1024):
        assert joined[g] == pattern[(g - shift) % w], g


def test_rainbow_colors_and_motion():
    gen = make_generator("rainbow", {"speed": 0.5, "pixels_per_cycle": 60})
    frame = gen.render(0.0, 0, 510)
    assert frame[0:3] == b"\xff\x00\x00"  # 像素 0 是红色
    r, g, b = colorsys.hsv_to_rgb(20 / 60, 1, 1)
    assert tuple(frame[60:63]) == (round(r * 255), round(g * 255), round(b * 255))
    # 速度 0.5 圈/秒、一圈 60 像素 → 1 秒移动 30 个像素
    moved = gen.render(1.0, 0, 510)
    assert moved[30 * 3 : 30 * 3 + 3] == frame[0:3]


def test_rainbow_is_continuous_across_universes():
    gen = make_generator("rainbow", {"speed": 0.0, "pixels_per_cycle": 100})
    length = 510  # 170 个像素
    joined = gen.render(0.0, 0, length) + gen.render(0.0, 1, length)
    # 第二个 universe 的第 0 个像素 = 全局像素 170 → 色相 (170 % 100) / 100
    first_pixel_of_second = joined[length : length + 3]
    r, g, b = colorsys.hsv_to_rgb(0.7, 1, 1)
    assert tuple(first_pixel_of_second) == (round(r * 255), round(g * 255), round(b * 255))


def test_rainbow_negative_speed_reverses():
    forward = make_generator("rainbow", {"speed": 0.1, "pixels_per_cycle": 30})
    backward = make_generator("rainbow", {"speed": -0.1, "pixels_per_cycle": 30})
    assert forward.render(1.0, 0, 90) != backward.render(1.0, 0, 90)


def test_chase_block_moves():
    gen = make_generator("chase", {"width": 4, "speed": 10.0, "value": 200, "background": 5})
    f0 = gen.render(0.0, 0, 20)
    assert f0 == bytes([200] * 4 + [5] * 16)
    f1 = gen.render(1.0, 0, 20)  # 速度 10 通道/秒
    assert f1 == bytes([5] * 10 + [200] * 4 + [5] * 6)
    wrapped = gen.render(1.8, 0, 20)  # 位置 18,方块绕回开头
    assert wrapped[18:] == bytes([200, 200]) and wrapped[:2] == bytes([200, 200])


def test_chase_stagger_and_wide_block():
    gen = make_generator("chase", {"width": 4, "speed": 0.0, "stagger": 3})
    assert gen.render(0.0, 1, 20)[3:7] == bytes([255] * 4)
    wide = make_generator("chase", {"width": 100})
    assert wide.render(0.0, 0, 10) == bytes([255] * 10)


def test_strobe():
    gen = make_generator("strobe", {"rate": 2.0, "duty": 0.5, "value": 200, "background": 3})
    assert gen.render(0.0, 0, 2) == bytes([200, 200])
    assert gen.render(0.3, 0, 2) == bytes([3, 3])  # 周期 0.5s,0.25 以后是灭
    assert gen.render(0.5, 0, 2) == bytes([200, 200])


def test_random_is_reproducible_with_seed():
    a = make_generator("random", {"seed": 42})
    b = make_generator("random", {"seed": 42})
    c = make_generator("random", {"seed": 43})
    seq_a = [a.render(0.0, 0, 16) for _ in range(3)]
    assert seq_a == [b.render(0.0, 0, 16) for _ in range(3)]
    assert seq_a[0] != c.render(0.0, 0, 16)
    assert seq_a[0] != seq_a[1]


def test_random_change_hz_holds_value_within_step():
    gen = make_generator("random", {"seed": 1, "change_hz": 2.0})
    first = gen.render(0.1, 0, 8)
    assert gen.render(0.4, 0, 8) == first  # 仍在第 0 个 0.5 秒内
    assert gen.render(0.6, 0, 8) != first
    assert gen.render(0.6, 1, 8) != gen.render(0.6, 0, 8)  # 不同 Universe 独立


@pytest.mark.parametrize(
    ("name", "params", "message"),
    [
        ("fixed", {"value": 256}, "不大于"),
        ("fixed", {"value": -1}, "不小于"),
        ("fixed", {"value": 1.5}, "整数"),
        ("fixed", {"value": True}, "数字"),
        ("fixed", {"value": "x"}, "数字"),
        ("fixed", {"colour": 1}, "不支持参数"),
        ("ramp", {"period": 0}, "大于"),
        ("ramp", {"mode": "zigzag"}, "之一"),
        ("strobe", {"duty": 0}, "大于"),
        ("strobe", {"duty": 1.5}, "不大于"),
        ("rainbow", {"pixels_per_cycle": 2}, "不小于"),
    ],
)
def test_parameter_validation(name, params, message):
    with pytest.raises(ValueError, match=message):
        make_generator(name, params)


def test_unknown_generator():
    with pytest.raises(ValueError, match="未知生成器"):
        make_generator("nope")


def test_rendering_is_fast_enough_for_many_universes():
    # 256 个 Universe × 44 Hz ≈ 11264 次渲染/秒;这里渲染一秒的量,应远小于 1 秒。
    for name in ("sine", "rainbow", "chase"):
        gen = make_generator(name)
        start = time.perf_counter()
        for i in range(11264):
            gen.render(i / 44.0, i % 256, 512)
        elapsed = time.perf_counter() - start
        assert elapsed < 0.5, (name, elapsed)
