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
  });

  it("发光体与合成规则", () => {
    expect(isEmitter("lime")).toBe(true);
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
