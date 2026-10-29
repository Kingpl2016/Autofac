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

  it("色温能力：混色、冷暖白，或可由色温驱动的色温通道（与引擎规则一致）", () => {
    const ctc = (capabilities: FixtureProperty["capabilities"]) => ({ ...prop("colorTemp", 2), capabilities });
    const has = (props: FixtureProperty[]) => modelProfile(model(props)).caps.has("colorTemp");
    expect(has([prop("red", 1), prop("green", 2), prop("blue", 3)])).toBe(true);
    expect(has([prop("coolWhite", 1), prop("warmWhite", 2)])).toBe(true);
    // 调光 + 色温通道：没有区间（整段暖→冷）或区间标注了 K
    expect(has([prop("dimmer", 1), ctc([])])).toBe(true);
    expect(has([prop("dimmer", 1), ctc([{ range: [0, 255], label: "CTC", physical: [2700, 6500], unit: "K" }])])).toBe(true);
    // 区间都没标色温：不知道怎么换算
    expect(has([prop("dimmer", 1), ctc([{ range: [0, 255], label: "CTC" }])])).toBe(false);
    // 只有调光 / 只有单色白：不能调色温
    expect(has([prop("dimmer", 1)])).toBe(false);
    expect(has([prop("white", 1)])).toBe(false);
    // 有带颜色槽位的色轮：色温意图交给色轮，色温通道不驱动
    const wheel = { ...prop("colorWheel", 3), capabilities: [{ range: [0, 255] as [number, number], label: "Red", color: [255, 0, 0] as [number, number, number] }] };
    expect(has([prop("dimmer", 1), ctc([]), wheel])).toBe(false);
  });

  it("类型列表覆盖全部类型且不重复", () => {
    expect(new Set(FIXTURE_TYPES).size).toBe(5);
  });
});
