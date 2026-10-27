import { describe, expect, it } from "vitest";

import type { FixtureModel, FixtureProperty } from "../types";
import { channelCount, endChannel, validateModel } from "../validate";

function prop(overrides: Partial<FixtureProperty> = {}): FixtureProperty {
  return {
    name: "亮度",
    code: "Bright",
    function: "dimmer",
    channel: 1,
    width: 1,
    bigEndian: false,
    defaultValue: 0,
    valueDesc: "",
    description: "",
    ...overrides,
  };
}

function model(properties: FixtureProperty[], overrides: Partial<FixtureModel> = {}): FixtureModel {
  return {
    id: "2.1.1.2",
    name: "测试灯",
    system: "",
    productType: "",
    builtin: false,
    properties,
    ...overrides,
  };
}

describe("validateModel", () => {
  it("合法模型通过，通道数取最大结束通道", () => {
    const m = model([prop({ code: "Pan", function: "pan", channel: 1, width: 2 }), prop({ channel: 6 })]);
    expect(validateModel(m)).toBeNull();
    expect(channelCount(m)).toBe(6);
    expect(endChannel({ channel: 3, width: 2 })).toBe(4);
  });

  it("编号 / 名称 / 属性数量", () => {
    expect(validateModel(model([prop()], { id: "  " }))?.code).toBe("emptyId");
    expect(validateModel(model([prop()], { id: "x".repeat(65) }))?.code).toBe("idTooLong");
    expect(validateModel(model([prop()], { name: "" }))?.code).toBe("emptyName");
    expect(validateModel(model([]))?.code).toBe("noProperties");
    expect(validateModel(model(Array.from({ length: 65 }, (_, i) => prop({ channel: i + 1, function: "other", code: `C${i}` }))))?.code).toBe(
      "tooManyProperties",
    );
  });

  it("通道越界与默认值超范围", () => {
    expect(validateModel(model([prop({ channel: 0 })]))?.code).toBe("channelOutOfRange");
    expect(validateModel(model([prop({ channel: 512, width: 2 })]))?.code).toBe("channelOutOfRange");
    expect(validateModel(model([prop({ defaultValue: 256 })]))?.code).toBe("defaultOutOfRange");
    expect(validateModel(model([prop({ width: 2, defaultValue: 65535 })]))).toBeNull();
  });

  it("通道重叠给出两个属性的代码", () => {
    const issue = validateModel(
      model([
        prop({ code: "Pan", function: "pan", channel: 1, width: 2 }),
        prop({ code: "Tilt", function: "tilt", channel: 2, width: 2 }),
      ]),
    );
    expect(issue).toEqual({ code: "overlap", params: { a: "Pan", b: "Tilt" } });
  });

  it("颜色类功能不能重复，其他功能可以", () => {
    expect(
      validateModel(model([prop({ function: "red", code: "R1" }), prop({ function: "red", code: "R2", channel: 2 })]))?.code,
    ).toBe("duplicateFunction");
    expect(
      validateModel(model([prop({ function: "macro", code: "M1" }), prop({ function: "macro", code: "M2", channel: 2 })])),
    ).toBeNull();
  });
});
