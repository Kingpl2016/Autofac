import { describe, expect, it } from "vitest";

import { channelRangeText, filterModels, warningParams } from "../format";
import type { FixtureModel } from "../types";

const model = (id: string, name: string): FixtureModel => ({
  id,
  name,
  system: "",
  productType: "",
  builtin: false,
  properties: [],
});

describe("format", () => {
  it("通道范围：单通道一个数字，双通道用连接号", () => {
    expect(channelRangeText(3, 1)).toBe("3");
    expect(channelRangeText(1, 2)).toBe("1–2");
  });

  it("过滤：忽略大小写与首尾空白，按名称或编号匹配，空词不过滤", () => {
    const all = [model("1.4.1.4", "RGB全彩灯"), model("2.1.2.1", "通用16CH摇头灯")];
    expect(filterModels(all, "  rgb ")).toEqual([all[0]]);
    expect(filterModels(all, "2.1")).toEqual([all[1]]);
    expect(filterModels(all, "")).toEqual(all);
    expect(filterModels(all, "不存在")).toEqual([]);
  });

  it("警告参数：缺失项用破折号占位", () => {
    expect(
      warningParams({ kind: "invalidRow", sheet: "S", row: null, modelId: null, detail: null }),
    ).toEqual({ sheet: "S", row: "—", model: "—", detail: "—" });
    expect(
      warningParams({ kind: "invalidRow", sheet: "S", row: 3, modelId: "1.1.1.1", detail: "x" }),
    ).toEqual({ sheet: "S", row: 3, model: "1.1.1.1", detail: "x" });
  });
});
