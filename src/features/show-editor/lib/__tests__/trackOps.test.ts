import { describe, expect, it } from "vitest";
import { produce } from "immer";

import { addStaticCue } from "../cueOps";
import { addFixtures, createGroup } from "../ops";
import { createEmptyProject, type ShowProject } from "../project";
import { parseProject } from "../schema";
import { previewRemoveTracks, removeTracks } from "../trackOps";
import { RGBW } from "./testkit";

function base(): ShowProject {
  return produce(createEmptyProject("t"), (d) => {
    const ids = addFixtures(d, RGBW, 4);
    createGroup(d, "前排", ids.slice(0, 3));
    for (const t of d.tracks) addStaticCue(d, t.id, 0);
    d.tracks.push({ id: "scene", target: { kind: "scene" }, mute: false, solo: false, lock: false, name: "场景" });
    d.cues.push({
      id: "sc",
      kind: "scene",
      trackId: "scene",
      startMs: 0,
      endMs: 1000,
      brightness: 100,
      fadeInMs: 0,
      fadeOutMs: 0,
      easing: "linear",
      entries: ids.map((fixtureId) => ({ fixtureId, look: { intensity: { kind: "value", value: 50 } } })),
    });
  });
}

const trackOf = (p: ShowProject, kind: "fixture" | "group", i = 0) => p.tracks.filter((t) => t.target.kind === kind)[i].id;

describe("删除轨道与灯具", () => {
  it("删除灯具轨道：删掉灯具、片段，并从分组与场景里移除；工程仍合法", () => {
    const p = base();
    let r: ReturnType<typeof removeTracks> = { fixtures: 0, groups: 0, tracks: 0, cues: 0 };
    const q = produce(p, (d) => {
      r = removeTracks(d, [trackOf(p, "fixture", 0)]);
    });
    expect(r).toEqual({ fixtures: 1, groups: 0, tracks: 1, cues: 1 });
    expect(q.fixtures).toHaveLength(3);
    expect(q.groups[0].fixtureIds).toHaveLength(2);
    const scene = q.cues.find((c) => c.id === "sc");
    expect(scene?.kind === "scene" && scene.entries).toHaveLength(3);
    expect(parseProject(JSON.stringify(q)).ok).toBe(true);
  });

  it("删除分组轨道：默认只删分组；连同成员时删掉成员灯具", () => {
    const p = base();
    const g = trackOf(p, "group");
    const only = produce(p, (d) => void removeTracks(d, [g]));
    expect(only.groups).toEqual([]);
    expect(only.fixtures).toHaveLength(4);
    expect(previewRemoveTracks(p, [g], true)).toEqual({ fixtures: 3, groups: 1, tracks: 4, cues: 4 });
    const all = produce(p, (d) => void removeTracks(d, [g], true));
    expect(all.fixtures).toHaveLength(1);
    expect(parseProject(JSON.stringify(all)).ok).toBe(true);
    // 预览不修改原工程
    expect(p.fixtures).toHaveLength(4);
  });

  it("删除场景轨道与多条轨道；分组成员不足 2 个时分组一并删除", () => {
    const p = base();
    const q = produce(p, (d) => void removeTracks(d, ["scene", trackOf(p, "fixture", 0), trackOf(p, "fixture", 1)]));
    expect(q.tracks.some((t) => t.id === "scene")).toBe(false);
    expect(q.cues.some((c) => c.id === "sc")).toBe(false);
    expect(q.groups).toEqual([]);
    expect(q.fixtures).toHaveLength(2);
  });
});
