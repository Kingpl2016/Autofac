import { describe, expect, it } from "vitest";
import { produce } from "immer";

import { addFixtures, createGroup, ensureRefTracks } from "../ops";
import { createEmptyProject, type ShowProject } from "../project";
import { filterSwatchSections, pickSwatch, strobingFixtures, swatchLabelText, swatchSections, visibleOrder } from "../swatchGroups";
import { clampHeaderWidth, DEFAULT_EDITOR_PREFS, sanitizeEditorPrefs } from "../../stores/useEditorPrefsStore";
import { DIMMER, prop, RGBW } from "./testkit";

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
      swatchLabel: "name",
      swatchSort: "address",
      swatchCollapsed: [],
      trackHeaderWidth: 480,
      fixtureAdd: DEFAULT_EDITOR_PREFS.fixtureAdd,
      outputAdvancedOpen: false,
      followPlayhead: true,
      snapKinds: DEFAULT_EDITOR_PREFS.snapKinds,
      rippleEdit: false,
      rulerFormat: "timecode",
      patchSections: {},
      programSections: {},
      cueSections: {},
      programmerRecord: DEFAULT_EDITOR_PREFS.programmerRecord,
      effectParams: {},
      favoriteTemplates: [],
      stage: DEFAULT_EDITOR_PREFS.stage,
      sheet: DEFAULT_EDITOR_PREFS.sheet,
      fixtureLibrary: DEFAULT_EDITOR_PREFS.fixtureLibrary,
    });
    // 灯具素材库偏好：模型 id 去重限量，分区只保留认识的，密度只接受两种
    expect(
      sanitizeEditorPrefs(
        { fixtureLibrary: { favorites: ["a", "a", 3, ""], recent: ["1", "2", "3", "4", "5", "6", "7"], collapsed: ["mover", "nope", "recent"], density: "tiny" } },
        DEFAULT_EDITOR_PREFS,
      ).fixtureLibrary,
    ).toEqual({ favorites: ["a"], recent: ["1", "2", "3", "4", "5", "6"], collapsed: ["recent", "mover"], density: "comfortable" });
    // 灯具表偏好逐字段兜底；属性组只保留认识的
    expect(
      sanitizeEditorPrefs({ sheet: { readout: "hex", filter: "x", sort: "name", hiddenGroups: ["color", "nope", "beam"], showModel: 1, expandPixels: true } }, DEFAULT_EDITOR_PREFS).sheet,
    ).toEqual({ readout: "hex", filter: "all", sort: "name", hiddenGroups: ["color", "beam"], showModel: false, expandPixels: true });
    // 舞台偏好逐字段兜底
    expect(
      sanitizeEditorPrefs({ stage: { bloom: false, labels: "x", snapM: 0.3, backgroundOpacity: 5, arcSweep: 2, gridColumns: 3.4 } }, DEFAULT_EDITOR_PREFS).stage,
    ).toEqual({ bloom: false, labels: "selected", snapM: 0.25, backgroundOpacity: 1, arcSweep: 10, gridColumns: 3 });
    // 收藏的模板：去重、只保留合法 id
    expect(sanitizeEditorPrefs({ favoriteTemplates: ["a", "a", "bad id", 3, "lee-106"] }, DEFAULT_EDITOR_PREFS).favoriteTemplates).toEqual(["a", "lee-106"]);
    // 记住的特效插入参数：只保留结构合法的条目
    const good = { period: { kind: "beats", beats: 2 }, size: 50, spread: 1, wings: 1, direction: 1, order: "members" };
    expect(
      sanitizeEditorPrefs({ effectParams: { ok: good, "bad id!": good, broken: { size: "x" } } }, DEFAULT_EDITOR_PREFS).effectParams,
    ).toEqual({ ok: good });
    expect(sanitizeEditorPrefs({ effectParams: [1] }, DEFAULT_EDITOR_PREFS).effectParams).toEqual({});
    // 属性面板各页的分区展开状态：只保留本页认识的分区和布尔值；不是对象时保持当前值
    const current = { ...DEFAULT_EDITOR_PREFS, patchSections: { sync: true }, cueSections: { time: false } };
    expect(sanitizeEditorPrefs({ patchSections: { placement: false, sync: "yes", nope: true } }, current).patchSections).toEqual({ placement: false });
    expect(sanitizeEditorPrefs({ patchSections: [true] }, current).patchSections).toEqual({ sync: true });
    expect(sanitizeEditorPrefs({ programSections: { record: false, basic: true } }, current).programSections).toEqual({ record: false });
    expect(sanitizeEditorPrefs({ cueSections: "x" }, current).cueSections).toEqual({ time: false });
    expect(sanitizeEditorPrefs({ cueSections: { layers: true, clipboard: 1 } }, current).cueSections).toEqual({ layers: true });
    expect(sanitizeEditorPrefs({ snapKinds: { beats: false, edges: "x" }, rulerFormat: "bars", rippleEdit: true }, DEFAULT_EDITOR_PREFS)).toMatchObject({
      snapKinds: { beats: false, markers: true, edges: true, playhead: true },
      rulerFormat: "bars",
      rippleEdit: true,
    });
    expect(sanitizeEditorPrefs({ trackHeaderWidth: "wide" }, DEFAULT_EDITOR_PREFS).trackHeaderWidth).toBe(208);
    // 批量添加设置逐字段规整；高级分区开关只接受布尔
    const p = sanitizeEditorPrefs({ fixtureAdd: { count: 999, gap: -3, autoStart: "x", address: 600, group: true }, outputAdvancedOpen: 1 }, DEFAULT_EDITOR_PREFS);
    expect(p.fixtureAdd).toEqual({ count: 128, gap: 0, autoStart: true, universe: 0, address: 512, group: true });
    expect(p.outputAdvancedOpen).toBe(false);
    expect(clampHeaderWidth(10.6 + 200)).toBe(211);
    expect(clampHeaderWidth(Number.NaN)).toBe(208);
  });
});

describe("色块筛选、标签、排序与状态", () => {
  it("搜索名称 / 型号 / 地址（@12、1.12），筛选选中 / 编程中 / 冲突；空分区不显示", () => {
    const p = base();
    const [rgb1, rgb2, dim] = p.fixtures.map((f) => f.id);
    const sections = swatchSections(p, "universe");
    const none = { selected: new Set<string>(), programmed: new Set<string>() };
    const ids = (s: ReturnType<typeof filterSwatchSections>) => s.flatMap((x) => x.items.map((it) => it.fixtureId));
    expect(ids(filterSwatchSections(sections, "全彩灯 2", "all", none))).toEqual([rgb2]);
    expect(ids(filterSwatchSections(sections, "可调白光", "all", none))).toEqual([dim]);
    // 型号名
    expect(ids(filterSwatchSections(sections, "rgbw", "all", none))).toEqual([rgb2, rgb1]);
    // 地址落在占用范围内即命中
    expect(ids(filterSwatchSections(sections, "@10", "all", none))).toEqual([rgb1]);
    expect(ids(filterSwatchSections(sections, "1.1", "all", none))).toEqual([dim]);
    expect(ids(filterSwatchSections(sections, "0:2", "all", none))).toEqual([rgb2]);
    expect(filterSwatchSections(sections, "不存在", "all", none)).toEqual([]);

    expect(ids(filterSwatchSections(sections, "", "selected", { ...none, selected: new Set([dim]) }))).toEqual([dim]);
    expect(ids(filterSwatchSections(sections, "", "programmed", { ...none, programmed: new Set([rgb1]) }))).toEqual([rgb1]);
    expect(filterSwatchSections(sections, "", "conflict", none)).toEqual([]);
  });

  it("标签文字：名称、地址、强度百分比、HEX、不显示", () => {
    const it0 = swatchSections(base(), "universe")[0].items[0];
    expect(swatchLabelText("name", it0, [0, 0, 0])).toBe("RGBW全彩灯 2");
    expect(swatchLabelText("address", it0, [0, 0, 0])).toBe("U0 @1");
    expect(swatchLabelText("level", it0, [128, 10, 0])).toBe("50%");
    expect(swatchLabelText("hex", it0, [255, 16, 0])).toBe("#FF1000");
    expect(swatchLabelText("none", it0, [255, 16, 0])).toBe("");
  });

  it("按舞台位置排序（先 y 后 x，没有位置的排最后）；通道锁定标在灯上", () => {
    const p = produce(base(), (d) => {
      d.output.park.push({ universe: 0, channel: 10, value: 255 });
    });
    const [rgb1, rgb2] = p.fixtures.map((f) => f.id);
    const positions = new Map([
      [rgb1, { x: 1, y: 0 }],
      [rgb2, { x: 5, y: 2 }],
    ]);
    const u0 = swatchSections(p, "universe", { sort: "stage", positions })[0];
    expect(u0.items.map((it) => it.fixtureId)).toEqual([rgb1, rgb2]);
    expect(u0.items.map((it) => it.parked)).toEqual([true, false]);
  });

  it("频闪：快门当前值落在“频闪”区间里", () => {
    const model = {
      ...RGBW,
      id: "strobe",
      properties: [
        ...RGBW.properties,
        {
          ...prop("Shutter", "shutter", 5),
          capabilities: [
            { range: [0, 9] as [number, number], label: "Closed", tag: "shutterClosed" as const },
            { range: [10, 249] as [number, number], label: "Strobe", tag: "strobe" as const },
            { range: [250, 255] as [number, number], label: "Open", tag: "shutterOpen" as const },
          ],
        },
      ],
    };
    const p = produce(createEmptyProject("t"), (d) => void addFixtures(d, model, 2));
    const frame = new Uint8Array(512);
    frame[4] = 100; // 第 1 台：频闪
    frame[9] = 255; // 第 2 台：开光
    expect([...strobingFixtures(p, () => frame)]).toEqual([p.fixtures[0].id]);
    expect(strobingFixtures(p, () => null).size).toBe(0);
  });

  it("为引用建轨道：已有的跳过，不存在的忽略，重复的只建一次", () => {
    const p = base();
    const [rgb1, , dim] = p.fixtures.map((f) => f.id);
    let created: string[] = [];
    const q = produce(p, (d) => {
      d.tracks = d.tracks.filter((t) => !(t.target.kind === "fixture" && t.target.id === dim));
      created = ensureRefTracks(d, [rgb1, dim, dim, "nope"]);
    });
    expect(created).toHaveLength(1);
    expect(q.tracks.filter((t) => t.target.kind === "fixture" && t.target.id === dim)).toHaveLength(1);
  });
});
