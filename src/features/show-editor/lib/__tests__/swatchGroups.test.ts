import { describe, expect, it } from "vitest";
import { produce } from "immer";

import { addFixtures, createGroup } from "../ops";
import { createEmptyProject, type ShowProject } from "../project";
import { pickSwatch, swatchSections, visibleOrder } from "../swatchGroups";
import { clampHeaderWidth, DEFAULT_EDITOR_PREFS, sanitizeEditorPrefs } from "../../stores/useEditorPrefsStore";
import { DIMMER, RGBW } from "./testkit";

/** U1：调光灯 @1；U0：RGBW @9、@1（Patch 顺序打乱）；前两台 RGBW 编为“前排”。 */
function base(): ShowProject {
  return produce(createEmptyProject("t"), (d) => {
    const rgb = addFixtures(d, RGBW, 2);
    addFixtures(d, DIMMER, 1);
    d.fixtures[0].address = 9;
    d.fixtures[1].address = 1;
    d.fixtures[2].universe = 1;
    d.fixtures[2].address = 1;
    createGroup(d, "前排", rgb);
    d.output.universes.push({ universe: 1, label: "舞台左", color: [0, 128, 255], ports: [] });
  });
}

describe("预览色块分区", () => {
  it("按 Universe：编号升序，区内按地址；带名称、颜色与占用", () => {
    const sections = swatchSections(base(), "universe");
    expect(sections.map((s) => s.title)).toEqual(["U0", "U1"]);
    expect(sections[0].items.map((it) => [it.name, it.address, it.end])).toEqual([
      ["RGBW全彩灯 2", 1, 4],
      ["RGBW全彩灯 1", 9, 12],
    ]);
    expect(sections[0].used).toBe(8);
    expect(sections[1]).toMatchObject({ subtitle: "舞台左", color: [0, 128, 255], used: 1 });
  });

  it("冲突的灯具计数", () => {
    const p = produce(base(), (d) => {
      d.fixtures[0].address = 3;
    });
    expect(swatchSections(p, "universe")[0].conflicts).toBe(2);
  });

  it("按分组：成员顺序，其余放“未分组”；按型号：按 Patch 中首次出现的顺序", () => {
    const p = base();
    const g = swatchSections(p, "group");
    expect(g.map((s) => [s.title, s.ungrouped, s.items.length])).toEqual([
      ["前排", false, 2],
      ["", true, 1],
    ]);
    const m = swatchSections(p, "model");
    expect(m.map((s) => [s.title, s.items.length])).toEqual([
      ["RGBW全彩灯", 2],
      ["可调白光灯", 1],
    ]);
  });

  it("显示顺序去重并跳过折叠区；Shift 按显示顺序连选", () => {
    const p = produce(base(), (d) => void createGroup(d, "全部", d.fixtures.map((f) => f.id)));
    const sections = swatchSections(p, "group");
    const [f1, f2, f3] = p.fixtures.map((f) => f.id);
    expect(visibleOrder(sections, new Set())).toEqual([f1, f2, f3]);
    expect(visibleOrder(sections, new Set([sections[0].key]))).toEqual([f1, f2, f3]);
    const byU = swatchSections(p, "universe");
    const order = visibleOrder(byU, new Set());
    expect(order).toEqual([f2, f1, f3]);
    expect(pickSwatch(order, [], f2, f3, { shift: true, toggle: false })).toEqual([f2, f1, f3]);
    expect(pickSwatch(order, [f3], f2, f1, { shift: true, toggle: true })).toEqual([f3, f2, f1]);
    expect(pickSwatch(order, [f1], null, f1, { shift: false, toggle: true })).toEqual([]);
    expect(pickSwatch(order, [f1], null, f2, { shift: false, toggle: false })).toEqual([f2]);
  });

  it("视图偏好：默认色块；非法值逐项兜底", () => {
    expect(DEFAULT_EDITOR_PREFS.centerView).toBe("swatches");
    expect(sanitizeEditorPrefs({ centerView: "stage", swatchGroupBy: "x", swatchDensity: 3, trackHeaderWidth: 9999 }, DEFAULT_EDITOR_PREFS)).toEqual({
      centerView: "stage",
      swatchGroupBy: "universe",
      swatchDensity: "comfortable",
      trackHeaderWidth: 480,
    });
    expect(sanitizeEditorPrefs({ trackHeaderWidth: "wide" }, DEFAULT_EDITOR_PREFS).trackHeaderWidth).toBe(208);
    expect(clampHeaderWidth(10.6 + 200)).toBe(211);
    expect(clampHeaderWidth(Number.NaN)).toBe(208);
  });
});
