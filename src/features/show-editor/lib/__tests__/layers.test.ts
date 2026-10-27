import { describe, expect, it } from "vitest";

import type { FixtureModel } from "@/features/fixtures";
import {
  attrGroup,
  availableAttrs,
  capabilityAt,
  capabilityValue,
  layerGroupsOf,
  mergeLayers,
  normalizeSpread,
  pickLayers,
} from "../layers";
import { fixed } from "../looks";
import type { Look } from "../project";
import { HEAD16, RGBW } from "./testkit";

const look: Look = {
  intensity: fixed(80),
  color: fixed({ kind: "rgb", rgb: [255, 0, 0] }),
  attrs: { pan: fixed(0.5), gobo: fixed(0.2), colorWheel: fixed(0.1) },
};

describe("属性层", () => {
  it("属性组与模型里可编辑的属性", () => {
    expect(attrGroup("pan")).toBe("position");
    expect(attrGroup("gobo")).toBe("beam");
    expect(attrGroup("colorWheel")).toBe("color");
    expect(availableAttrs(RGBW)).toEqual([]);
    expect(availableAttrs(HEAD16).map((a) => [a.key, a.max])).toEqual([
      ["pan", 65535],
      ["tilt", 65535],
      ["reset", 255],
    ]);
    expect(availableAttrs(undefined)).toEqual([]);
  });

  it("能力区间的取值与命中", () => {
    const caps = [
      { range: [0, 9] as [number, number], label: "开" },
      { range: [10, 255] as [number, number], label: "图案" },
    ];
    expect(capabilityValue(caps[1], 255)).toBeCloseTo(132.5 / 255);
    expect(capabilityAt(caps, 5 / 255, 255)).toBe(0);
    expect(capabilityAt(caps, 1, 255)).toBe(1);
    expect(capabilityAt([], 0.5, 255)).toBe(-1);
  });

  it("选择性复制：按层组挑出；颜色组含颜色轮等颜色类属性", () => {
    expect(layerGroupsOf(look)).toEqual(["intensity", "color", "position", "beam"]);
    expect(pickLayers(look, new Set(["position"]))).toEqual({ attrs: { pan: fixed(0.5) } });
    expect(pickLayers(look, new Set(["color"]))).toEqual({
      color: fixed({ kind: "rgb", rgb: [255, 0, 0] }),
      attrs: { colorWheel: fixed(0.1) },
    });
    expect(pickLayers(look, new Set())).toEqual({});
  });

  it("粘贴：同名层覆盖，其它层保留", () => {
    const target: Look = { intensity: fixed(10), attrs: { tilt: fixed(0.3), pan: fixed(0) } };
    mergeLayers(target, pickLayers(look, new Set(["position", "beam"])));
    expect(target).toEqual({ intensity: fixed(10), attrs: { tilt: fixed(0.3), pan: fixed(0.5), gobo: fixed(0.2) } });
  });

  it("规整分布：默认值省略，全空时不分布", () => {
    expect(normalizeSpread({ order: "members", wings: 1, values: {}, delay: { fromMs: 0, toMs: 0 } })).toBeUndefined();
    expect(normalizeSpread({ order: "reverse", wings: 2.4, values: { intensity: { from: 100, to: 0 } } })).toEqual({
      order: "reverse",
      wings: 2,
      values: { intensity: { from: 100, to: 0 } },
    });
    const model: FixtureModel = HEAD16;
    expect(model.id).toBeTruthy();
  });
});
