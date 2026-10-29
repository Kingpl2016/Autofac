import { describe, expect, it } from "vitest";
import { produce } from "immer";

import { refOf } from "../fixtureRef";
import { mergeProject, projectEndMs, summarizeProject, type MergeOptions } from "../mergeProject";
import { addFixtures, createGroup } from "../ops";
import { createEmptyProject, type ShowProject } from "../project";
import { parseProject } from "../schema";
import { PIXEL_BAR, RGBW } from "./testkit";

const ALL: MergeOptions = { timeline: true, presets: true, markers: true, offsetMs: 0, repatch: true };

/** 一个带分组、轨道、片段、预设、场景、标记的源节目。 */
function source(): ShowProject {
  return produce(createEmptyProject("源"), (d) => {
    addFixtures(d, RGBW, 2);
    addFixtures(d, PIXEL_BAR, 1);
    const [a, b, bar] = d.fixtures;
    createGroup(d, "前排", [a.id, b.id]);
    const group = d.groups[0];
    d.presets.push({ id: "p1", name: "红", group: "color", look: { color: { kind: "value", value: { kind: "rgb", rgb: [255, 0, 0] } } } });
    d.presets.push({ id: "p2", name: "没用到", group: "color", look: {} });
    d.tracks.push({ id: "tg", target: { kind: "group", id: group.id }, mute: false, solo: false, lock: false });
    d.tracks.push({ id: "tp", target: { kind: "fixture", id: refOf(bar.id, 2) }, mute: false, solo: false, lock: false });
    d.tracks.push({ id: "ts", target: { kind: "scene" }, mute: false, solo: false, lock: false, name: "场景" });
    const base = { brightness: 100, fadeInMs: 0, fadeOutMs: 0, easing: "linear" as const };
    d.cues.push({ ...base, id: "c1", kind: "look", trackId: "tg", startMs: 0, endMs: 1000, look: { presetId: "p1" } });
    d.cues.push({ ...base, id: "c2", kind: "look", trackId: "tp", startMs: 500, endMs: 2500, look: { intensity: { kind: "value", value: 50 } } });
    d.cues.push({
      ...base,
      id: "c3",
      kind: "scene",
      trackId: "ts",
      startMs: 3000,
      endMs: 4000,
      entries: [{ fixtureId: refOf(bar.id, 1), look: { intensity: { kind: "value", value: 10 } } }],
    });
    d.markers.push({ id: "m1", timeMs: 1000, label: "副歌" });
    d.sections.push({ id: "s1", name: "前奏", startMs: 0, endMs: 2000, color: [1, 2, 3] });
  });
}

describe("导入节目（合并工程）", () => {
  it("全部导入：新 id、引用一并改写，合并结果是合法工程", () => {
    const src = source();
    const base = produce(createEmptyProject("当前"), (d) => void addFixtures(d, RGBW, 1));
    let report: ReturnType<typeof mergeProject> | null = null;
    const out = produce(base, (d) => {
      report = mergeProject(d, src, ALL);
    });
    expect(report).toMatchObject({ fixtures: 3, models: 1, groups: 1, tracks: src.tracks.length, cues: 3, presets: 2, markers: 2, unpatched: 0 });
    expect(parseProject(JSON.stringify(out)).ok).toBe(true);

    const srcIds = new Set([...src.fixtures, ...src.groups, ...src.tracks, ...src.cues, ...src.presets].map((x) => x.id));
    const imported = out.fixtures.slice(1);
    expect(imported.every((f) => !srcIds.has(f.id))).toBe(true);
    // 分组成员、轨道、片段、场景条目都指向新的对象
    const group = out.groups[0];
    expect(group.fixtureIds).toEqual(imported.slice(0, 2).map((f) => f.id));
    const groupTrack = out.tracks.find((t) => t.target.kind === "group" && out.cues.some((c) => c.trackId === t.id))!;
    expect(groupTrack.target).toEqual({ kind: "group", id: group.id });
    expect(out.tracks.some((t) => t.target.kind === "fixture" && t.target.id === refOf(imported[2].id, 2))).toBe(true);
    const c1 = out.cues.find((c) => c.trackId === groupTrack.id)!;
    expect(c1.kind === "look" && c1.look.presetId).toBe(out.presets.find((p) => p.name === "红")!.id);
    const scene = out.cues.find((c) => c.kind === "scene");
    expect(scene?.kind === "scene" && scene.entries[0].fixtureId).toBe(refOf(imported[2].id, 1));
    // 模型按 id 去重；重新配接后没有地址冲突
    expect(out.fixtureModels.map((m) => m.id).sort()).toEqual([PIXEL_BAR.id, RGBW.id].sort());
    const spots = out.fixtures.map((f) => `${f.universe}@${f.address}`);
    expect(new Set(spots).size).toBe(spots.length);
  });

  it("同一个节目导入两次：两份互不相干", () => {
    const src = source();
    const out = produce(createEmptyProject("当前"), (d) => {
      mergeProject(d, src, ALL);
      mergeProject(d, src, ALL);
    });
    expect(out.fixtures).toHaveLength(6);
    expect(new Set(out.fixtures.map((f) => f.id)).size).toBe(6);
    expect(new Set(out.cues.map((c) => c.id)).size).toBe(6);
    expect(parseProject(JSON.stringify(out)).ok).toBe(true);
  });

  it("只导入灯具：不带时间线、标记；预设只在勾选时导入；不重新配接时保留原地址", () => {
    const src = source();
    const out = produce(createEmptyProject("当前"), (d) =>
      void mergeProject(d, src, { timeline: false, presets: false, markers: false, offsetMs: 0, repatch: false }),
    );
    expect(out.fixtures.map((f) => [f.universe, f.address])).toEqual(src.fixtures.map((f) => [f.universe, f.address]));
    expect(out.tracks).toHaveLength(0);
    expect(out.cues).toEqual([]);
    expect(out.presets).toEqual([]);
    expect(out.markers).toEqual([]);
    expect(out.groups).toHaveLength(1);
  });

  it("不导入全部预设时只带上片段用到的；偏移整体平移片段、标记与段落，并延长节目时长", () => {
    const src = source();
    const out = produce(createEmptyProject("当前"), (d) => {
      d.durationMs = 1000;
      mergeProject(d, src, { ...ALL, presets: false, offsetMs: 10_000 });
    });
    expect(out.presets.map((p) => p.name)).toEqual(["红"]);
    expect(out.cues.map((c) => c.startMs).sort((a, b) => a - b)).toEqual([10_000, 10_500, 13_000]);
    expect(out.markers[0].timeMs).toBe(11_000);
    expect(out.sections[0]).toMatchObject({ startMs: 10_000, endMs: 12_000 });
    expect(out.durationMs).toBe(14_000);
  });

  it("摘要与末尾时间", () => {
    const src = source();
    expect(summarizeProject(src)).toEqual({ fixtures: 3, groups: 1, tracks: src.tracks.length, cues: 3, presets: 2, markers: 2, endMs: 4000 });
    expect(projectEndMs(createEmptyProject(""))).toBe(0);
  });
});
