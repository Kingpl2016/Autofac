import { describe, expect, it } from "vitest";

import { applyEmitterPreset, TYPICAL_LED } from "../emitterPresets";
import { inferShape, modelShape } from "../shape";
import type { FixtureModel, FixtureProperty } from "../types";

const prop = (fn: FixtureProperty["function"], channel: number, extra: Partial<FixtureProperty> = {}): FixtureProperty => ({
  name: fn,
  code: fn,
  function: fn,
  channel,
  width: 1,
  bigEndian: true,
  defaultValue: 0,
  valueDesc: "",
  description: "",
  ...extra,
});

const model = (props: FixtureProperty[], extra: Partial<FixtureModel> = {}): FixtureModel => ({
  id: "x",
  name: "x",
  system: "",
  productType: "",
  builtin: false,
  properties: props,
  ...extra,
});

describe("inferShape / modelShape", () => {
  it("按通道推断外形，有外观时用外观", () => {
    expect(inferShape(model([prop("pan", 1), prop("tilt", 2), prop("dimmer", 3)]))).toBe("movingHead");
    expect(inferShape(model([prop("red", 1, { head: 1 }), prop("red", 2, { head: 2 })], { matrix: { cols: 2, rows: 1 } }))).toBe("bar");
    expect(inferShape(model([prop("red", 1, { head: 1 })], { matrix: { cols: 2, rows: 2 } }))).toBe("pixelPanel");
    expect(inferShape(model([prop("fog", 1)]))).toBe("fogger");
    expect(inferShape(model([prop("red", 1), prop("green", 2), prop("blue", 3)]))).toBe("par");
    expect(inferShape(model([prop("other", 1)]))).toBe("generic");
    expect(modelShape(model([prop("red", 1)], { appearance: { shape: "wash", origin: "user" } }))).toBe("wash");
  });
});

describe("applyEmitterPreset", () => {
  it("只写模型有的发光体，保留相对亮度与预设之外的校准", () => {
    const out = applyEmitterPreset(["red", "white", "uv"], [
      { function: "red", rgb: [1, 2, 3], intensity: 0.4 },
      { function: "uv", rgb: [80, 0, 255] },
    ]);
    expect(out).toEqual([
      { function: "red", ...TYPICAL_LED.red, intensity: 0.4 },
      { function: "white", kelvin: 6000 },
      { function: "uv", rgb: [80, 0, 255] },
    ]);
    expect(applyEmitterPreset([], undefined)).toBeUndefined();
  });
});
