import { describe, expect, it } from "vitest";

import { flashRateHz } from "../attrEffects";
import { colorCycleGradient } from "../clipVisual";
import {
  clampPeriod,
  cyclePeriodMs,
  formatSteps,
  parseSteps,
  periodModeOf,
  randomSeed,
  sanitizeCurve,
  withPeriodMode,
} from "../curveTiming";
import { heldValueAt, keysOf, setValueAt, toggleKeyAt } from "../keyframes";
import { paramHead } from "../looks";
import type { ColorParam, ValueCurve } from "../project";

const tempo = { bpm: 120, offsetMs: 0, beatsPerBar: 4 };
const sine = (over: Partial<ValueCurve> = {}): ValueCurve => ({ shape: "sine", from: 0, to: 100, cycles: 4, phase: 0, ...over });

describe("周期方式切换", () => {
  it("当前方式与一个周期的毫秒数", () => {
    expect(periodModeOf(sine())).toBe("cycles");
    expect(periodModeOf(sine({ period: { kind: "beats", beats: 2 } }))).toBe("beats");
    expect(cyclePeriodMs(sine(), 8000, null)).toBe(2000);
    expect(cyclePeriodMs(sine({ period: { kind: "beats", beats: 2 } }), 8000, tempo)).toBe(1000);
  });

  it("切换时保持速度：次数 ↔ 毫秒 ↔ 拍", () => {
    const ctx = { lengthMs: 8000, tempo };
    expect(withPeriodMode(sine(), "ms", ctx)).toEqual({ period: { kind: "ms", ms: 2000 }, cycles: 4 });
    expect(withPeriodMode(sine(), "beats", ctx)).toEqual({ period: { kind: "beats", beats: 4 }, cycles: 4 });
    expect(withPeriodMode(sine({ period: { kind: "ms", ms: 500 } }), "cycles", ctx)).toEqual({ period: undefined, cycles: 16 });
    // 夹在允许范围内
    expect(withPeriodMode(sine({ cycles: 1000 }), "ms", { lengthMs: 1000, tempo })).toEqual({ period: { kind: "ms", ms: 20 }, cycles: 1000 });
  });

  it("规整周期", () => {
    expect(clampPeriod({ kind: "ms", ms: 5 })).toEqual({ kind: "ms", ms: 20 });
    expect(clampPeriod({ kind: "beats", beats: 1.234 })).toEqual({ kind: "beats", beats: 1.23 });
    expect(clampPeriod({ kind: "beats", beats: 999 })).toEqual({ kind: "beats", beats: 128 });
  });
});

describe("步进值", () => {
  it("解析逗号 / 空格分隔的百分比，夹在 0~100", () => {
    expect(parseSteps("100, 0, 0, 100")).toEqual([1, 0, 0, 1]);
    expect(parseSteps("50%，25 120")).toEqual([0.5, 0.25, 1]);
    expect(parseSteps("")).toBeNull();
    expect(parseSteps("1, x")).toBeNull();
    expect(parseSteps(Array.from({ length: 65 }, () => "1").join(","))).toBeNull();
  });

  it("格式化为百分比", () => {
    expect(formatSteps([1, 0, 0.125])).toBe("100, 0, 12.5");
  });
});

describe("规整曲线", () => {
  it("夹取高级参数并删掉未设置的字段", () => {
    const c = sanitizeCurve({ ...sine(), transition: 1.5, duty: -1, steps: [2, -1], seed: -3.7, period: { kind: "ms", ms: 1 }, ease: undefined });
    expect(c).toEqual({ ...sine(), transition: 1, duty: 0, steps: [1, 0], seed: 3, period: { kind: "ms", ms: 20 } });
    expect("ease" in c).toBe(false);
  });

  it("随机种子是 32 位无符号整数", () => {
    expect(randomSeed(() => 0)).toBe(0);
    const s = randomSeed(() => 0.999999);
    expect(Number.isInteger(s) && s >= 0 && s <= 0xffff_ffff).toBe(true);
  });
});

describe("频闪提示按真实周期计", () => {
  it("按时间计的周期、步进的亮暗次数", () => {
    const look = (c: ValueCurve) => ({ intensity: { kind: "curve" as const, curve: c } });
    expect(flashRateHz(look(sine()), 8000)).toBe(0.5);
    // 每拍一个周期，120 BPM → 2 Hz
    expect(flashRateHz(look(sine({ period: { kind: "beats", beats: 1 } })), 8000, tempo)).toBe(2);
    // 一个周期里亮暗两次
    expect(flashRateHz(look(sine({ shape: "steps", steps: [1, 0, 1, 0], period: { kind: "ms", ms: 1000 } })), 8000)).toBe(2);
    expect(flashRateHz(look(sine({ shape: "ramp" })), 8000)).toBe(0);
  });
});

describe("颜色序列在界面上的处理", () => {
  const cycle: ColorParam = {
    kind: "cycle",
    cycle: { colors: [{ kind: "rgb", rgb: [255, 0, 0] }, { kind: "rgb", rgb: [0, 0, 255] }], blend: "step", cycles: 2, phase: 0 },
  };

  it("代表值是第一个颜色，没有关键帧；改值 / 打帧时换成固定值 / 关键帧", () => {
    expect(paramHead(cycle)).toEqual({ kind: "rgb", rgb: [255, 0, 0] });
    expect(heldValueAt(cycle, 500)).toEqual({ kind: "rgb", rgb: [255, 0, 0] });
    expect(keysOf(cycle)).toEqual([]);
    expect(setValueAt(cycle, 0, { kind: "rgb", rgb: [0, 255, 0] })).toEqual({ kind: "value", value: { kind: "rgb", rgb: [0, 255, 0] } });
    expect(toggleKeyAt(cycle, 100, { kind: "rgb", rgb: [0, 255, 0] }).kind).toBe("keys");
  });

  it("时间线色块：按周期重复的渐变（跳变为硬边）", () => {
    if (cycle.kind !== "cycle") return;
    const g = colorCycleGradient(cycle.cycle, 4000, null, 2.2);
    expect(g).toBe("repeating-linear-gradient(90deg, rgb(255 0 0) 0%, rgb(255 0 0) 25%, rgb(0 0 255) 25%, rgb(0 0 255) 50%)");
    const smooth = colorCycleGradient({ ...cycle.cycle, blend: "smooth", period: { kind: "ms", ms: 1000 } }, 4000, null, 2.2);
    expect(smooth).toBe("repeating-linear-gradient(90deg, rgb(255 0 0) 0%, rgb(0 0 255) 12.5%, rgb(255 0 0) 25%)");
    expect(colorCycleGradient({ ...cycle.cycle, colors: [] }, 4000, null, 2.2)).toBe("transparent");
  });
});
