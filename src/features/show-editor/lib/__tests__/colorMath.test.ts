import { beforeAll, describe, expect, it } from "vitest";

import type { FixtureModel } from "@/features/fixtures";
import type { Engine } from "../../engine/engine";
import { loadTestEngine } from "../../engine/__tests__/testEngine";
import { hexToRgb, hslToRgb, hsToWheel, hsvToRgb, rgbToHex, rgbToHsl, rgbToHsv, wheelToHs } from "../colorMath";
import { mixPreview } from "../mixPreview";
import { RGBW } from "./testkit";

let engine: Engine;
beforeAll(() => {
  engine = loadTestEngine();
});

describe("色盘换算", () => {
  it("RGB ↔ HSV 往返", () => {
    expect(rgbToHsv([255, 0, 0])).toEqual({ h: 0, s: 1, v: 1 });
    expect(rgbToHsv([0, 0, 0])).toEqual({ h: 0, s: 0, v: 0 });
    for (const rgb of [
      [255, 128, 0],
      [12, 200, 99],
      [90, 0, 255],
      [255, 255, 255],
    ] as const) {
      expect(hsvToRgb(rgbToHsv([...rgb]))).toEqual([...rgb]);
    }
  });

  it("十六进制解析与格式化", () => {
    expect(rgbToHex([255, 8, 0])).toBe("#ff0800");
    expect(hexToRgb("#ff0800")).toEqual([255, 8, 0]);
    expect(hexToRgb("0f0")).toEqual([0, 255, 0]);
    expect(hexToRgb("#zzz")).toBeNull();
  });

  it("色轮坐标：0 度在正上方、顺时针；与反函数一致", () => {
    expect(wheelToHs(0, -1)).toEqual({ h: 0, s: 1 });
    expect(wheelToHs(1, 0).h).toBeCloseTo(90);
    expect(wheelToHs(0, 0.5)).toEqual({ h: 180, s: 0.5 });
    expect(wheelToHs(3, 0).s).toBe(1);
    const p = hsToWheel(225, 0.7);
    const back = wheelToHs(p.x, p.y);
    expect(back.h).toBeCloseTo(225);
    expect(back.s).toBeCloseTo(0.7);
  });
});

describe("实际输出（引擎混色）", () => {
  it("RGBW 灯保色模式：白色由白光通道给出，RGB 归零", () => {
    const out = mixPreview(engine, RGBW, undefined, { kind: "rgb", rgb: [255, 255, 255] }, 1);
    expect(out?.emitters.map((e) => [e.fn, Math.round(e.level * 100)])).toEqual([
      ["red", 0],
      ["green", 0],
      ["blue", 0],
      ["white", 100],
    ]);
    expect(out?.rgb).toEqual([255, 255, 255]);
  });

  it("不用白光时 RGB 全亮、白光不亮；纯色不动白光", () => {
    const off = mixPreview(engine, RGBW, undefined, { kind: "rgb", rgb: [255, 255, 255], white: "off" }, 1);
    expect(off?.emitters.map((e) => Math.round(e.level * 100))).toEqual([100, 100, 100, 0]);
    const red = mixPreview(engine, RGBW, undefined, { kind: "rgb", rgb: [255, 0, 0] }, 1);
    expect(red?.emitters.map((e) => Math.round(e.level * 100))).toEqual([100, 0, 0, 0]);
  });

  it("冷暖白灯按色温分配；引擎未就绪时为 null", () => {
    const cct: FixtureModel = {
      ...RGBW,
      id: "cct",
      properties: [
        { ...RGBW.properties[0], name: "CW", code: "CW", function: "coolWhite", channel: 1 },
        { ...RGBW.properties[0], name: "WW", code: "WW", function: "warmWhite", channel: 2 },
      ],
    };
    const warm = mixPreview(engine, cct, undefined, { kind: "kelvin", kelvin: 3000 }, 1);
    const cool = mixPreview(engine, cct, undefined, { kind: "kelvin", kelvin: 6500 }, 1);
    expect(warm && warm.emitters[1].level > warm.emitters[0].level).toBe(true);
    expect(cool && cool.emitters[0].level > cool.emitters[1].level).toBe(true);
    expect(mixPreview(null, RGBW, undefined, { kind: "rgb", rgb: [1, 2, 3] }, 1)).toBeNull();
  });
});

describe("HSL 换算", () => {
  it("基本色与灰色；往返误差不超过 1", () => {
    expect(rgbToHsl([255, 0, 0])).toEqual({ h: 0, s: 1, l: 0.5 });
    expect(rgbToHsl([128, 128, 128])).toMatchObject({ h: 0, s: 0 });
    expect(hslToRgb({ h: 240, s: 1, l: 0.5 })).toEqual([0, 0, 255]);
    expect(hslToRgb({ h: 120, s: 1, l: 0.25 })).toEqual([0, 128, 0]);
    expect(hslToRgb({ h: -120, s: 2, l: 1.5 })).toEqual([255, 255, 255]);
    for (const rgb of [[12, 200, 77], [250, 128, 3], [90, 0, 255], [1, 2, 3]] as const) {
      const back = hslToRgb(rgbToHsl([...rgb]));
      back.forEach((v, i) => expect(Math.abs(v - rgb[i])).toBeLessThanOrEqual(1));
    }
  });
});