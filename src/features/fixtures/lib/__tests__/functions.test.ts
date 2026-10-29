import { describe, expect, it } from "vitest";

import { defaultPrecedence, effectivePrecedence, groupOf, headCount, isEmitter, layoutOf } from "../functions";
import { CHANNEL_FUNCTIONS, type FixtureModel, type FixtureProperty } from "../types";

const prop = (overrides: Partial<FixtureProperty> = {}): FixtureProperty => ({
  name: "",
  code: "D",
  function: "dimmer",
  channel: 1,
  width: 1,
  bigEndian: false,
  defaultValue: 0,
  valueDesc: "",
  description: "",
  ...overrides,
});

describe("通道功能分类", () => {
  it("每个功能都有属性组", () => {
    for (const fn of CHANNEL_FUNCTIONS) expect(groupOf(fn)).toBeTruthy();
    expect(groupOf("amber")).toBe("color");
    expect(groupOf("zoom")).toBe("focus");
    expect(groupOf("shutter")).toBe("intensity");
    expect(groupOf("iris")).toBe("beam");
    // OFL 适配新增的功能，与 Rust `ChannelFunction::group` 一致
    expect(groupOf("indigo")).toBe("color");
    expect(groupOf("colorWheelRotate")).toBe("color");
    expect(groupOf("blade")).toBe("beam");
    expect(groupOf("rotation")).toBe("beam");
    expect(groupOf("fog")).toBe("control");
    expect(groupOf("maintenance")).toBe("control");
  });

  it("下拉菜单列出全部功能", () => {
    expect(new Set(CHANNEL_FUNCTIONS).size).toBe(CHANNEL_FUNCTIONS.length);
    expect(CHANNEL_FUNCTIONS).toContain("indigo");
    expect(CHANNEL_FUNCTIONS).toContain("effectSpeed");
  });

  it("发光体与合成规则", () => {
    expect(isEmitter("lime")).toBe(true);
    expect(isEmitter("indigo")).toBe(true);
    expect(defaultPrecedence("indigo")).toBe("htp");
    expect(isEmitter("cyan")).toBe(false);
    expect(defaultPrecedence("dimmer")).toBe("htp");
    expect(defaultPrecedence("pan")).toBe("ltp");
    expect(effectivePrecedence({ function: "dimmer", precedence: "ltp" })).toBe("ltp");
  });

  it("按模式取布局与像素数", () => {
    const m: Pick<FixtureModel, "properties" | "modes" | "matrix"> = {
      properties: [prop()],
      modes: [{ id: "4ch", name: "4ch", properties: [prop(), prop({ channel: 2, function: "red" })] }],
      matrix: { cols: 4, rows: 2 },
    };
    expect(layoutOf(m)).toHaveLength(1);
    expect(layoutOf(m, "4ch")).toHaveLength(2);
    expect(layoutOf(m, "nope")).toBeNull();
    expect(headCount(m)).toBe(8);
    expect(headCount({})).toBe(0);
  });
});
