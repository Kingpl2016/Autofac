import { produce } from "immer";
import { describe, expect, it } from "vitest";

import { colorModes, fixturesCapabilities, layerSupport } from "../fixtureProfile";
import { baseOf, headsOf, parseRef, pixelRefsOf, refExists, refName, refOf } from "../fixtureRef";
import { addFixtures, createGroup, removeFixtures, trackFixtureIds, trackName } from "../ops";
import { createEmptyProject, type ShowProject } from "../project";
import { parseProject } from "../schema";
import { setFixtureMode } from "../universeOps";
import { DIMMER, PIXEL_BAR as BAR } from "./testkit";

function project(): ShowProject {
  return produce(createEmptyProject("t"), (d) => void addFixtures(d, BAR, 1));
}

describe("灯具引用", () => {
  it("解析与拼接；不是正整数的后缀按整灯处理", () => {
    expect(parseRef("f1#3")).toEqual({ fixtureId: "f1", head: 3 });
    expect(parseRef("f1")).toEqual({ fixtureId: "f1", head: null });
    expect(parseRef("f1#x")).toEqual({ fixtureId: "f1#x", head: null });
    expect(refOf("f1", 2)).toBe("f1#2");
    expect(refOf("f1")).toBe("f1");
    expect(baseOf("f1#2")).toBe("f1");
    expect(headsOf(BAR)).toEqual([1, 2, 3]);
    expect(headsOf(BAR, "2px")).toEqual([1, 2]);
  });

  it("像素引用可以建组、建轨道，显示名带像素号", () => {
    let p = project();
    const f = p.fixtures[0];
    expect(pixelRefsOf(p, f)).toEqual([`${f.id}#1`, `${f.id}#2`, `${f.id}#3`]);
    expect(refExists(p, `${f.id}#3`)).toBe(true);
    expect(refExists(p, `${f.id}#4`)).toBe(false);
    p = produce(p, (d) => {
      createGroup(d, "像素", [`${f.id}#1`, `${f.id}#3`, `${f.id}#9`]);
      d.tracks.push({ id: "px", target: { kind: "fixture", id: `${f.id}#2` }, mute: false, solo: false, lock: false });
    });
    const group = p.groups[0];
    expect(group.fixtureIds).toEqual([`${f.id}#1`, `${f.id}#3`]);
    const track = p.tracks.find((t) => t.id === "px")!;
    expect(trackName(p, track)).toBe(`${f.name} · P2`);
    expect(refName(p, f.id)).toBe(f.name);
    const groupTrack = p.tracks.find((t) => t.target.kind === "group")!;
    expect(trackFixtureIds(p, groupTrack)).toEqual(group.fixtureIds);
    // 能保存并重新打开（v4）
    expect(parseProject(JSON.stringify(p))).toMatchObject({ ok: true });
  });

  it("像素的能力只看自己的通道；整灯有总调光时像素也能调亮度", () => {
    const p = project();
    const f = p.fixtures[0];
    const caps = fixturesCapabilities(p, [`${f.id}#1`]);
    expect([...caps.any].sort()).toEqual(["colorTemp", "intensity", "mixing"]);
    expect(layerSupport(p, [`${f.id}#1`]).attrs.size).toBe(0);

    // 色盘的颜色方式：按整灯 / 像素各自的通道判断；只有调光的灯没有任何方式；至少一台支持就显示
    const q = produce(p, (d) => void addFixtures(d, DIMMER, 1));
    const dim = q.fixtures[1].id;
    expect(colorModes(q, [f.id])).toEqual(["rgb", "kelvin", "manual"]);
    expect(colorModes(q, [`${f.id}#2`])).toEqual(["rgb", "kelvin", "manual"]);
    expect(colorModes(q, [dim])).toEqual([]);
    expect(colorModes(q, [dim, f.id])).toEqual(["rgb", "kelvin", "manual"]);
    expect(colorModes(q, [])).toEqual(["rgb", "kelvin", "manual"]);
  });

  it("换到像素更少的模式时清理失效引用（分组成员不足时整组删除），撤销即可恢复", () => {
    let p = project();
    const f = p.fixtures[0];
    p = produce(p, (d) => {
      createGroup(d, "像素", [`${f.id}#1`, `${f.id}#3`]);
      d.tracks.push({ id: "px3", target: { kind: "fixture", id: `${f.id}#3` }, mute: false, solo: false, lock: false });
    });
    const next = produce(p, (d) => setFixtureMode(d, f.id, "2px"));
    expect(next.groups).toHaveLength(0);
    expect(next.tracks.some((t) => t.id === "px3")).toBe(false);
    expect(next.tracks.some((t) => t.target.kind === "group")).toBe(false);
    // 原快照不受影响（撤销）
    expect(p.groups).toHaveLength(1);
  });

  it("打开工程时兜底清理失效的像素引用；删除灯具时一并删除像素轨道与场景条目", () => {
    let p = project();
    const f = p.fixtures[0];
    p = produce(p, (d) => {
      d.tracks.push({ id: "px9", target: { kind: "fixture", id: `${f.id}#9` }, mute: false, solo: false, lock: false });
    });
    const parsed = parseProject(JSON.stringify(p));
    expect(parsed.ok && parsed.project.tracks.some((t) => t.id === "px9")).toBe(false);

    p = produce(project(), (d) => {
      const id = d.fixtures[0].id;
      d.tracks.push({ id: "px1", target: { kind: "fixture", id: `${id}#1` }, mute: false, solo: false, lock: false });
      removeFixtures(d, [`${id}#1`]);
      expect(d.fixtures).toHaveLength(1);
      removeFixtures(d, [id]);
    });
    expect(p.fixtures).toHaveLength(0);
    expect(p.tracks).toHaveLength(0);
  });
});
