import { describe, expect, it } from "vitest";

import { FIXTURE_TYPES, modelProfile, modelType } from "../profile";
import type { FixtureModel, FixtureProperty } from "../types";

function prop(fn: FixtureProperty["function"], channel: number): FixtureProperty {
  return { name: fn, code: fn, function: fn, channel, width: 1, bigEndian: false, defaultValue: 0, valueDesc: "", description: "" };
}

function model(properties: FixtureProperty[], modes: FixtureModel["modes"] = undefined): FixtureModel {
  return { id: "9.9.9.9", name: "测试", system: "照明", productType: "测试", builtin: false, properties, modes };
}

describe("灯具能力画像", () => {
  it("按通道功能推断类型", () => {
    expect(modelProfile(model([prop("dimmer", 1)])).type).toBe("dimmer");
    expect(modelProfile(model([prop("coolWhite", 1), prop("warmWhite", 2)])).type).toBe("white");
    expect(modelProfile(model([prop("red", 1), prop("green", 2), prop("blue", 3)])).type).toBe("mixing");
    expect(modelProfile(model([prop("pan", 1), prop("tilt", 2), prop("gobo", 3)]))).toEqual({
      type: "mover",
      caps: new Set(["position", "beam"]),
    });
    expect(modelProfile(undefined)).toEqual({ type: "other", caps: new Set() });
  });

  it("模型类型取能力最强的模式", () => {
    const m = model([prop("dimmer", 1)], [{ id: "ext", name: "扩展", properties: [prop("pan", 1), prop("tilt", 2)] }]);
    expect(modelProfile(m).type).toBe("dimmer");
    expect(modelType(m)).toBe("mover");
  });

  it("类型列表覆盖全部类型且不重复", () => {
    expect(new Set(FIXTURE_TYPES).size).toBe(5);
  });
});
