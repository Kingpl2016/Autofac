import { produce } from "immer";
import { describe, expect, it } from "vitest";

import { BUILTIN_TEMPLATES } from "../../lib/cueTemplates";
import { BUILTIN_EFFECTS } from "../../lib/effectLibrary";
import { addFixtures, createGroup } from "../../lib/ops";
import { createEmptyProject, type LookClip, type ShowProject } from "../../lib/project";
import { DIMMER, HEAD16, RGBW } from "../../lib/__tests__/testkit";
import { buildAliases } from "../aliases";
import { planOps, type CompileEnv } from "../compile";
import { aiOpsSchema, type AiOp } from "../opsSchema";

const env = (over: Partial<CompileEnv> = {}): CompileEnv => ({
  effects: BUILTIN_EFFECTS,
  templates: BUILTIN_TEMPLATES,
  libraryModels: [RGBW, HEAD16],
  lang: "zh",
  playheadMs: 0,
  selection: [],
  ...over,
});

/** 4 台 RGBW + 2 台摇头灯，120 BPM（一小节 2 秒），两个段落。 */
function show(over: (d: ShowProject) => void = () => {}): ShowProject {
  return produce(createEmptyProject("t"), (d) => {
    addFixtures(d, RGBW, 4);
    addFixtures(d, HEAD16, 2);
    d.durationMs = 32_000;
    d.tempo = { bpm: 120, offsetMs: 0, beatsPerBar: 4 };
    d.sections = [
      { id: "s-verse", name: "主歌", startMs: 0, endMs: 16_000, color: [60, 180, 140] },
      { id: "s-chorus", name: "副歌", startMs: 16_000, endMs: 32_000, color: [235, 90, 70] },
    ];
    over(d);
  });
}

/** 按 schema 补齐默认值（模型漏写的字段）。 */
const parse = (ops: unknown[]): AiOp[] => aiOpsSchema.parse({ summary: "", ops }).ops;

const run = (p: ShowProject, ops: unknown[], e = env()) => planOps(p, parse(ops), e, buildAliases(p));

describe("AiOps 编译", () => {
  it("addEffect 到 all：建出全部灯具分组，片段带特效快照、颜色与精确起止", () => {
    const p = show();
    const r = run(p, [{ op: "addEffect", target: "all", from: "S2", to: "S2:end", effect: "colorChase", colors: ["blue", "violet"], period: "2" }]);
    expect(r.issues).toEqual([]);
    expect(r.failed).toBe(false);
    const group = r.next.groups.find((g) => g.name === "全部灯具");
    expect(group?.fixtureIds).toHaveLength(6);
    const cue = r.next.cues[0] as LookClip;
    expect(cue).toMatchObject({ kind: "look", startMs: 16_000, endMs: 32_000 });
    expect(cue.fx?.def.id).toBe("colorChase");
    expect(cue.fx?.params.period).toEqual({ kind: "beats", beats: 2 });
    expect(cue.fx?.params.values?.colors).toEqual([[0, 0, 255], [140, 0, 255]]);
    // 同一批再用 all 复用同一个分组
    const twice = run(p, [
      { op: "addEffect", target: "all", from: "S1", to: "S1:end", effect: "breathe" },
      { op: "addEffect", target: "all", from: "S2", to: "S2:end", effect: "rainbow" },
    ]);
    expect(twice.next.groups).toHaveLength(1);
  });

  it("没有颜色层的强度特效：颜色作为固定颜色写进特效快照", () => {
    const r = run(show(), [{ op: "addEffect", target: "all", from: "b1", to: "b5", effect: "intensityChase", colors: ["red"] }]);
    const cue = r.next.cues[0] as LookClip;
    expect(cue.fx?.def.look.color).toEqual({ rgb: [255, 0, 0] });
    expect(cue.look.color).toEqual({ kind: "value", value: { kind: "rgb", rgb: [255, 0, 0] } });
    expect([cue.startMs, cue.endMs]).toEqual([0, 8000]);
  });

  it("能力不符、别名不存在、时间不合法时报错（说明给模型看）", () => {
    const rgbOnly = produce(createEmptyProject("t"), (d) => {
      addFixtures(d, RGBW, 2);
      d.durationMs = 10_000;
    });
    expect(run(rgbOnly, [{ op: "addEffect", target: "all", from: "0s", to: "4s", effect: "circle" }]).issues[0].message).toMatch(/position/);
    expect(run(rgbOnly, [{ op: "addEffect", target: "movers", from: "0s", to: "4s", effect: "circle" }]).issues[0].message).toMatch(/moving heads/);
    expect(run(show(), [{ op: "addEffect", target: "G9", from: "S1", to: "S1:end", effect: "breathe" }]).issues[0].message).toMatch(/no group/);
    expect(run(show(), [{ op: "addEffect", target: "all", from: "S1", to: "S1:end", effect: "nope" }]).issues[0].message).toMatch(/unknown effect/);
    expect(run(rgbOnly, [{ op: "addEffect", target: "all", from: "b1", to: "b2", effect: "breathe" }]).issues[0].message).toMatch(/no tempo/);
    const bad = run(show(), [{ op: "addEffect", target: "all", from: "S2", to: "S1", effect: "breathe" }]);
    expect(bad.failed).toBe(true);
    expect(bad.issues[0]).toMatchObject({ index: 0, level: "error" });
  });

  it("addLook：强度波形 + 静态多色分布；时间按 1/4 拍量化", () => {
    const r = run(show(), [
      {
        op: "addLook",
        target: "all",
        from: "1.03s",
        to: "b3",
        intensityWave: { shape: "sine", low: 22, high: 98, period: "2" },
        colorSpread: ["red", "#1F8FFF"],
      },
    ]);
    expect(r.issues).toEqual([]);
    const cue = r.next.cues[0] as LookClip;
    // 1.03 s → 最近的 1/4 拍（0.125 s 网格）= 1.0 s
    expect(cue.startMs).toBe(1000);
    expect(cue.look.intensity).toMatchObject({ kind: "curve", curve: { from: 20, to: 100, period: { kind: "beats", beats: 2 } } });
    expect(cue.spread?.colors?.colors).toHaveLength(2);
  });

  it("频闪超过 10 Hz 时拒绝", () => {
    const fast = show((d) => void (d.tempo = { bpm: 300, offsetMs: 0, beatsPerBar: 4 }));
    const r = run(fast, [{ op: "addLook", target: "all", from: "0s", to: "4s", intensityWave: { shape: "square", low: 0, high: 100, period: "1/4" } }]);
    expect(r.issues[0].message).toMatch(/10 Hz/);
  });

  it("applyTemplate 用模板，终点按 to 设定", () => {
    const r = run(show(), [{ op: "applyTemplate", target: "G1", from: "S1", to: "b3", template: "mood-calm" }]);
    expect(r.issues).toEqual([{ index: 0, level: "error", message: "no group 'G1'" }]);
    const withGroup = show((d) => void createGroup(d, "前排", d.fixtures.slice(0, 4).map((f) => f.id)));
    const ok = run(withGroup, [{ op: "applyTemplate", target: "G1", from: "S1", to: "b3", template: "mood-calm" }]);
    expect(ok.issues).toEqual([]);
    expect(ok.next.cues[0]).toMatchObject({ startMs: 0, endMs: 4000, label: "宁静" });
  });

  it("editCues：特效片段换色保留特效、加速周期减半；selection 指选中的片段", () => {
    const p0 = run(show(), [{ op: "addEffect", target: "all", from: "S1", to: "S1:end", effect: "colorChase", period: "2" }]).next;
    const id = p0.cues[0].id;
    const r = run(p0, [{ op: "editCues", cues: ["selection"], colors: ["green"], speed: "x2", brightness: 83 }], env({ selection: [id] }));
    expect(r.issues).toEqual([]);
    const cue = r.next.cues[0] as LookClip;
    expect(cue.fx?.params.period).toEqual({ kind: "beats", beats: 1 });
    // 颜色追逐至少要 2 个颜色：只给一个时重复补齐
    expect(cue.fx?.params.values?.colors).toEqual([[0, 255, 0], [0, 255, 0]]);
    expect(cue.brightness).toBe(85);
    expect(run(p0, [{ op: "editCues", cues: ["selection"], brightness: 50 }]).issues[0].message).toMatch(/not selected/);
  });

  it("移动、分割、删除片段，并按别名引用", () => {
    const p0 = run(show(), [{ op: "addEffect", target: "all", from: "b1", to: "b3", effect: "breathe" }]).next;
    const moved = run(p0, [{ op: "moveCues", cues: ["C1"], by: "+2bars" }]);
    expect(moved.next.cues[0]).toMatchObject({ startMs: 4000, endMs: 8000 });
    const split = run(p0, [{ op: "splitCues", cues: ["C1"], at: "b2" }]);
    expect(split.next.cues.map((c) => [c.startMs, c.endMs])).toEqual([[0, 2000], [2000, 4000]]);
    const gone = run(p0, [{ op: "deleteCues", cues: ["C1"] }]);
    expect(gone.next.cues).toHaveLength(0);
    expect(run(p0, [{ op: "deleteCues", cues: ["C7"] }]).issues[0].message).toMatch(/no clip/);
  });

  it("新放的片段默认替换范围里的旧片段；replace=false 时重叠报错", () => {
    const p0 = run(show(), [{ op: "addEffect", target: "all", from: "S1", to: "S1:end", effect: "breathe" }]).next;
    const r = run(p0, [{ op: "addEffect", target: "all", from: "b3", to: "b5", effect: "rainbow" }]);
    expect(r.next.cues.map((c) => [c.startMs, c.endMs]).sort((a, b) => a[0] - b[0])).toEqual([
      [0, 4000],
      [4000, 8000],
      [8000, 16_000],
    ]);
    expect(run(p0, [{ op: "addEffect", target: "all", from: "b3", to: "b5", effect: "rainbow", replace: false }]).failed).toBe(true);
  });

  it("新建分组后在同一批里用 new_ 引用；段落与标记点", () => {
    const r = run(show(), [
      { op: "createGroup", as: "new_front", name: "前排", members: ["F1", "F2", "F3"] },
      { op: "addEffect", target: "new_front", from: "S1", to: "S1:end", effect: "pulse" },
      { op: "addSection", from: "b1", to: "b2", name: "Intro", energy: "low" },
      { op: "addMarker", at: "S2", label: "drop" },
    ]);
    // 段落和已有段落重叠
    expect(r.issues).toEqual([{ index: 2, level: "error", message: "the section overlaps an existing section or is shorter than 0.5 s" }]);
    expect(r.next.groups[0]).toMatchObject({ name: "前排" });
    expect(r.next.markers[0]).toMatchObject({ timeMs: 16_000, label: "drop" });
  });

  it("配接与输出是敏感操作；大批量删除也是", () => {
    const p = show();
    const out = run(p, [{ op: "setOutput", mode: "unicast", ip: "192.168.1.50" }]);
    expect(out.sensitive).toBe(true);
    expect(out.next.output.target).toEqual({ kind: "direct", ip: "192.168.1.50", protocol: "artNet", port: 6454 });
    expect(run(p, [{ op: "setOutput", mode: "unicast", ip: "1.2.3" }]).issues[0].message).toMatch(/IPv4/);
    const added = run(p, [{ op: "addFixtures", model: "L1", count: 2, as: "new_side" }, { op: "addEffect", target: "new_side", from: "S1", to: "S1:end", effect: "rainbow" }]);
    expect(added.issues).toEqual([]);
    expect(added.next.fixtures).toHaveLength(8);
    expect(added.sensitive).toBe(true);
    const many = produce(p, (d) => {
      d.durationMs = 60_000;
      for (let i = 0; i < 25; i += 1) d.cues.push({ id: `c${i}`, kind: "static", trackId: d.tracks[0].id, startMs: i * 2000, endMs: i * 2000 + 1000, rgb: [255, 0, 0], brightness: 100, fadeInMs: 0, fadeOutMs: 0, easing: "linear" });
    });
    const del = run(many, [{ op: "clearRange", target: "T1", from: "start", to: "end" }]);
    expect(del.sensitive).toBe(true);
    expect(run(many, [{ op: "deleteCues", cues: ["C1"] }]).sensitive).toBe(false);
  });

  it("结果总能通过结构与引用完整性校验", () => {
    const r = run(show((d) => void addFixtures(d, DIMMER, 1)), [
      { op: "setTempo", bpm: 128.04, beatsPerBar: null, offset: "0.5s" },
      { op: "addEffect", target: "all", from: "b1", to: "b9", effect: "intensityWave", spread: "full", mirror: true },
      { op: "addEffect", target: "movers", from: "b1", to: "b9", effect: "figure8", size: "large" },
      { op: "addLook", target: "F1", from: "b9", to: "end", color: "warmWhite", intensityKeys: [{ at: 0, value: 0 }, { at: 1, value: 100 }] },
    ]);
    expect(r.issues).toEqual([]);
    expect(r.next.tempo).toEqual({ bpm: 128, offsetMs: 500, beatsPerBar: 4 });
  });
});
