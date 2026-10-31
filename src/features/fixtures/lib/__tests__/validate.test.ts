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
    expect(validateModel(model(Array.from({ length: 257 }, (_, i) => prop({ channel: i + 1, function: "other", code: `C${i}` }))))?.code).toBe(
      "tooManyProperties",
    );
  });

  it("能力区间必须升序、在位宽内且互不重叠", () => {
    const cap = (lo: number, hi: number) => ({ range: [lo, hi] as [number, number], label: "" });
    expect(validateModel(model([prop({ capabilities: [cap(0, 20), cap(21, 255)] })]))).toBeNull();
    expect(validateModel(model([prop({ capabilities: [cap(0, 20), cap(20, 255)] })]))?.code).toBe("badCapability");
    expect(validateModel(model([prop({ capabilities: [cap(30, 10)] })]))?.code).toBe("badCapability");
    expect(validateModel(model([prop({ capabilities: [cap(0, 256)] })]))?.code).toBe("badCapability");
  });

  it("像素头：同一功能可出现在不同像素，像素须在排布之内", () => {
    const props = [
      prop({ function: "dimmer" }),
      prop({ function: "red", code: "R1", channel: 2, head: 1 }),
      prop({ function: "red", code: "R2", channel: 3, head: 2 }),
    ];
    expect(validateModel(model(props))?.code).toBe("headOutOfRange");
    expect(validateModel(model(props, { matrix: { cols: 2, rows: 1 } }))).toBeNull();
    expect(validateModel(model(props, { matrix: { cols: 0, rows: 1 } }))?.code).toBe("badMatrix");
  });

  it("物理参数与外观：数值为正，图标是图片、3D 模型是 GLB", () => {
    const hash = "a".repeat(64);
    const ok = model([prop()], {
      physical: { dimensionsMm: [300, 450, 250], weightKg: 12, lensName: "PC", focusType: "head" },
      appearance: { shape: "movingHead", origin: "ai", icon: { hash, format: "svg", name: "a.svg" }, model3d: { hash, format: "glb", name: "a.glb" } },
    });
    expect(validateModel(ok)).toBeNull();
    expect(validateModel({ ...ok, physical: { dimensionsMm: [0, 1, 1] } })?.code).toBe("badPhysical");
    expect(validateModel({ ...ok, appearance: { shape: "par", origin: "user", model3d: { hash, format: "png", name: "" } } })?.code).toBe(
      "badAppearance",
    );
    expect(validateModel({ ...ok, appearance: { shape: "par", origin: "user", icon: { hash: "ABC", format: "svg", name: "" } } })?.code).toBe(
      "badAppearance",
    );
  });

  it("附加模式：编号非空且唯一，布局各自校验", () => {
    const mode = { id: "5ch", name: "5ch", properties: [prop()] };
    expect(validateModel(model([prop()], { modes: [mode] }))).toBeNull();
    expect(validateModel(model([prop()], { modes: [mode, mode] }))?.code).toBe("badMode");
    expect(validateModel(model([prop()], { modes: [{ ...mode, id: " " }] }))?.code).toBe("badMode");
    expect(validateModel(model([prop()], { modes: [{ ...mode, properties: [] }] }))?.code).toBe("noProperties");
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
