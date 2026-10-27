import { describe, expect, it } from "vitest";

import {
  blankModel,
  blankProperty,
  cloneAsCustom,
  defaultValueFor,
  isDrivenFunction,
  nextCustomId,
  sortByChannel,
} from "../draft";
import type { FixtureModel, FixtureProperty } from "../types";

function prop(overrides: Partial<FixtureProperty> = {}): FixtureProperty {
  return {
    name: "x",
    code: "X",
    function: "other",
    channel: 1,
    width: 1,
    bigEndian: false,
    defaultValue: 0,
    valueDesc: "",
    description: "",
    ...overrides,
  };
}

function model(id: string, properties: FixtureProperty[] = [prop()]): FixtureModel {
  return { id, name: id, system: "", productType: "", builtin: false, properties };
}

describe("nextCustomId", () => {
  it("没有自定义模型时从 2.1 开始", () => {
    expect(nextCustomId([model("1.4.1.4")])).toBe("2.1.1.2");
  });

  it("取现有自定义序号的最大值加一", () => {
    expect(nextCustomId([model("2.1.2.1"), model("2.2.1.4"), model("1.1.1.1")])).toBe("2.3.1.2");
  });

  it("忽略非数字序号", () => {
    expect(nextCustomId([model("2.abc.1.1")])).toBe("2.1.1.2");
  });

  it("建议的编号不会与现有编号冲突", () => {
    expect(nextCustomId([model("2.4.1.2"), model("2.5.1.1")])).toBe("2.6.1.2");
  });
});

describe("属性辅助", () => {
  it("默认值与后端一致", () => {
    expect(defaultValueFor("shutter", 1)).toBe(105);
    expect(defaultValueFor("pan", 2)).toBe(32768);
    expect(defaultValueFor("pan", 1)).toBe(128);
    expect(defaultValueFor("focus", 1)).toBe(128);
    expect(defaultValueFor("red", 1)).toBe(0);
  });

  it("新属性接在现有通道之后", () => {
    const m = model("2.1.1.2", [prop({ channel: 1, width: 2 }), prop({ channel: 5 })]);
    expect(blankProperty(m).channel).toBe(6);
    expect(blankProperty(blankModel("x")).channel).toBe(1);
  });

  it("复制为自定义：新编号、加后缀、深拷贝属性", () => {
    const source = { ...model("1.4.1.4"), builtin: true, name: "RGB全彩灯" };
    const copy = cloneAsCustom(source, "2.1.1.2", "（副本）");
    expect(copy).toMatchObject({ id: "2.1.1.2", name: "RGB全彩灯（副本）", builtin: false });
    copy.properties[0].name = "changed";
    expect(source.properties[0].name).toBe("x");
  });

  it("颜色 / 亮度 / 开关类功能被判定为“灯光直接驱动”", () => {
    for (const fn of ["switch", "dimmer", "red", "green", "blue", "white", "coolWhite", "warmWhite"] as const) {
      expect(isDrivenFunction(fn)).toBe(true);
    }
    for (const fn of ["pan", "shutter", "macro", "other"] as const) {
      expect(isDrivenFunction(fn)).toBe(false);
    }
  });

  it("按起始通道排序且不修改入参", () => {
    const props = [prop({ code: "B", channel: 3 }), prop({ code: "A", channel: 1 })];
    expect(sortByChannel(props).map((p) => p.code)).toEqual(["A", "B"]);
    expect(props.map((p) => p.code)).toEqual(["B", "A"]);
  });
});
