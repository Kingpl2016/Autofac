import { describe, expect, it } from "vitest";

import {
  DEFAULT_MODE_KEY,
  addMode,
  emitterFunctions,
  layoutForKey,
  nextCapability,
  removeMode,
  splitCapabilities,
  withLayout,
} from "../draft";
import type { FixtureModel, FixtureProperty } from "../types";

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

const base: FixtureModel = {
  id: "2.1.1.2",
  name: "灯",
  system: "",
  productType: "",
  builtin: false,
  properties: [prop(), prop({ function: "red", code: "R", channel: 2 })],
};

describe("通道模式草稿", () => {
  it("复制当前模式为新模式，编辑互不影响", () => {
    const { model, key } = addMode(base, DEFAULT_MODE_KEY, "9ch");
    expect(key).toBe("mode1");
    expect(layoutForKey(model, key)).toHaveLength(2);
    const edited = withLayout(model, key, [prop()]);
    expect(layoutForKey(edited, key)).toHaveLength(1);
    expect(layoutForKey(edited, DEFAULT_MODE_KEY)).toHaveLength(2);
    expect(base.modes).toBeUndefined();
  });

  it("删除最后一个附加模式时去掉 modes 字段", () => {
    const { model, key } = addMode(base, DEFAULT_MODE_KEY, "x");
    const removed = removeMode(model, key);
    expect("modes" in removed).toBe(false);
    expect(layoutForKey(removed, key)).toEqual([]);
  });

  it("列出所有模式里出现过的发光体", () => {
    const { model, key } = addMode(base, DEFAULT_MODE_KEY, "x");
    const withAmber = withLayout(model, key, [prop({ function: "amber", code: "A" })]);
    expect(emitterFunctions(withAmber)).toEqual(["red", "amber"]);
  });
});

describe("能力区间草稿", () => {
  it("新区间从上一段之后续到最大值，铺满后为 null", () => {
    expect(nextCapability([], 1)).toEqual({ range: [0, 255], label: "" });
    expect(nextCapability([{ range: [0, 99], label: "" }], 1)?.range).toEqual([100, 255]);
    expect(nextCapability([{ range: [0, 255], label: "" }], 1)).toBeNull();
    expect(nextCapability([], 2)?.range).toEqual([0, 65535]);
  });

  it("均分铺满整个范围且互不重叠", () => {
    const caps = splitCapabilities(8, 1, (n) => `图案 ${n}`);
    expect(caps).toHaveLength(8);
    expect(caps[0]).toEqual({ range: [0, 31], label: "图案 1" });
    expect(caps[7].range).toEqual([224, 255]);
    for (let i = 1; i < caps.length; i += 1) expect(caps[i].range[0]).toBe(caps[i - 1].range[1] + 1);
    expect(splitCapabilities(3, 1, String).map((c) => c.range)).toEqual([[0, 84], [85, 169], [170, 255]]);
  });
});
