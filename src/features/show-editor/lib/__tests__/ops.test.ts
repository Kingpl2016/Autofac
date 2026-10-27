import { produce } from "immer";
import { describe, expect, it } from "vitest";

import { analyzePatch } from "../patch";
import {
  addFixtures,
  createGroup,
  MAX_ADD_COUNT,
  moveGroupMember,
  removeFixtures,
  removeGroup,
  removeGroupMember,
  renameFixture,
  renameGroup,
  setFixtureAddress,
  trackName,
} from "../ops";
import { createEmptyProject, type Cue, type ShowProject } from "../project";
import { projectIntegrityIssues } from "../schema";
import { DIMMER, HEAD16, RGBW } from "./testkit";

/** 在不可变快照上执行一次编辑，返回新工程（和 store 里的行为一致）。 */
function edit(project: ShowProject, recipe: (draft: ShowProject) => void): ShowProject {
  return produce(project, recipe);
}

function withRgbw(count: number): { project: ShowProject; ids: string[] } {
  let ids: string[] = [];
  const project = edit(createEmptyProject("t"), (d) => {
    ids = addFixtures(d, RGBW, count);
  });
  return { project, ids };
}

const cue = (id: string, trackId: string): Cue => ({
  id,
  trackId,
  kind: "static",
  startMs: 0,
  endMs: 1000,
  brightness: 100,
  fadeInMs: 0,
  fadeOutMs: 0,
  easing: "linear",
  rgb: [255, 0, 0],
});

describe("addFixtures", () => {
  it("连续添加：地址依次排布，每个灯具一条轨道，名称带序号", () => {
    const { project, ids } = withRgbw(3);
    expect(ids).toHaveLength(3);
    expect(project.fixtures.map((f) => [f.name, f.universe, f.address])).toEqual([
      ["RGBW全彩灯 1", 0, 1],
      ["RGBW全彩灯 2", 0, 5],
      ["RGBW全彩灯 3", 0, 9],
    ]);
    expect(project.tracks).toHaveLength(3);
    expect(project.tracks.every((t) => t.target.kind === "fixture")).toBe(true);
    expect(project.fixtureModels).toHaveLength(1);
    expect(projectIntegrityIssues(project)).toEqual([]);
  });

  it("再次添加同一模型时序号接着往后，且不会产生冲突", () => {
    let { project } = withRgbw(2);
    project = edit(project, (d) => {
      addFixtures(d, RGBW, 2);
    });
    expect(project.fixtures.map((f) => f.name).at(-1)).toBe("RGBW全彩灯 4");
    expect([...analyzePatch(project).values()].every((s) => s.conflictsWith.length === 0)).toBe(true);
  });

  it("一个 Universe 排满后自动进入下一个", () => {
    const project = edit(createEmptyProject("t"), (d) => {
      addFixtures(d, HEAD16, 33);
    });
    const last = project.fixtures.at(-1);
    expect(project.fixtures).toHaveLength(33);
    expect(last).toMatchObject({ universe: 1, address: 1 });
  });

  it("数量被夹在 1 到上限之间", () => {
    const none = edit(createEmptyProject("t"), (d) => {
      addFixtures(d, DIMMER, 0);
    });
    expect(none.fixtures).toHaveLength(1);
    const many = edit(createEmptyProject("t"), (d) => {
      addFixtures(d, DIMMER, 100_000);
    });
    expect(many.fixtures).toHaveLength(MAX_ADD_COUNT);
  });

  it("再次添加时以素材库里的最新定义刷新模型快照", () => {
    let { project } = withRgbw(1);
    const renamed = { ...RGBW, name: "RGBW（改名后）" };
    project = edit(project, (d) => {
      addFixtures(d, renamed, 1);
    });
    expect(project.fixtureModels).toHaveLength(1);
    expect(project.fixtureModels[0].name).toBe("RGBW（改名后）");
  });

  it("工程里的模型快照是副本，改素材库对象不影响工程", () => {
    const model = structuredClone(RGBW);
    const project = edit(createEmptyProject("t"), (d) => {
      addFixtures(d, model, 1);
    });
    model.properties[0].code = "Changed";
    expect(project.fixtureModels[0].properties[0].code).toBe("Red");
  });
});

describe("removeFixtures", () => {
  it("连同轨道、Cue 一起删除，并清理不再使用的模型快照", () => {
    const { project, ids } = withRgbw(2);
    const trackId = project.tracks[0].id;
    const withCue = edit(project, (d) => {
      d.cues.push(cue("c1", trackId));
    });
    const after = edit(withCue, (d) => removeFixtures(d, [ids[0]]));
    expect(after.fixtures.map((f) => f.id)).toEqual([ids[1]]);
    expect(after.tracks).toHaveLength(1);
    expect(after.cues).toEqual([]);
    expect(after.fixtureModels).toHaveLength(1);
    const empty = edit(after, (d) => removeFixtures(d, [ids[1]]));
    expect(empty.fixtureModels).toEqual([]);
  });

  it("从分组里移除成员；成员不足 2 个时分组及其轨道一并删除", () => {
    const { project, ids } = withRgbw(3);
    const grouped = edit(project, (d) => {
      createGroup(d, "舞台", ids);
    });
    const one = edit(grouped, (d) => removeFixtures(d, [ids[2]]));
    expect(one.groups[0].fixtureIds).toEqual([ids[0], ids[1]]);
    const gone = edit(one, (d) => removeFixtures(d, [ids[1]]));
    expect(gone.groups).toEqual([]);
    expect(gone.tracks.every((t) => t.target.kind === "fixture")).toBe(true);
    expect(projectIntegrityIssues(gone)).toEqual([]);
  });
});

describe("rename / setFixtureAddress", () => {
  it("重命名去除空白，空名称被忽略", () => {
    const { project, ids } = withRgbw(1);
    const a = edit(project, (d) => renameFixture(d, ids[0], "  前排 "));
    expect(a.fixtures[0].name).toBe("前排");
    const b = edit(a, (d) => renameFixture(d, ids[0], "   "));
    expect(b.fixtures[0].name).toBe("前排");
  });

  it("地址被夹回合法范围，非数字回落默认", () => {
    const { project, ids } = withRgbw(1);
    const a = edit(project, (d) => setFixtureAddress(d, ids[0], 99_999, 9999));
    expect(a.fixtures[0]).toMatchObject({ universe: 2047, address: 512 });
    const b = edit(a, (d) => setFixtureAddress(d, ids[0], -3, 0));
    expect(b.fixtures[0]).toMatchObject({ universe: 0, address: 1 });
    const c = edit(b, (d) => setFixtureAddress(d, ids[0], Number.NaN, Number.NaN));
    expect(c.fixtures[0]).toMatchObject({ universe: 0, address: 1 });
  });

  it("手工改地址造成重叠时能被 Patch 分析发现", () => {
    const { project, ids } = withRgbw(2);
    const clash = edit(project, (d) => setFixtureAddress(d, ids[1], 0, 3));
    expect(analyzePatch(clash).get(ids[0])?.conflictsWith).toEqual([ids[1]]);
  });
});

describe("分组", () => {
  it("创建分组同时创建分组轨道；成员保持给定顺序并忽略重复 / 不存在的", () => {
    const { project, ids } = withRgbw(3);
    let groupId: string | null = null;
    const next = edit(project, (d) => {
      groupId = createGroup(d, "", [ids[2], ids[0], ids[0], "nope"]);
    });
    expect(groupId).not.toBeNull();
    expect(next.groups[0]).toMatchObject({ name: "G1", fixtureIds: [ids[2], ids[0]] });
    expect(next.tracks.at(-1)?.target).toEqual({ kind: "group", id: groupId });
    expect(trackName(next, next.tracks.at(-1)!)).toBe("G1");
    expect(projectIntegrityIssues(next)).toEqual([]);
  });

  it("成员少于 2 个不创建分组", () => {
    const { project, ids } = withRgbw(2);
    let id: string | null = "x";
    const next = edit(project, (d) => {
      id = createGroup(d, "g", [ids[0]]);
    });
    expect(id).toBeNull();
    expect(next).toBe(project);
  });

  it("重命名、调整顺序、移除成员", () => {
    const { project, ids } = withRgbw(4);
    let gid = "";
    let next = edit(project, (d) => {
      gid = createGroup(d, "舞台", ids) ?? "";
    });
    next = edit(next, (d) => renameGroup(d, gid, " 后排 "));
    expect(next.groups[0].name).toBe("后排");
    next = edit(next, (d) => moveGroupMember(d, gid, 0, 2));
    expect(next.groups[0].fixtureIds).toEqual([ids[1], ids[2], ids[0], ids[3]]);
    next = edit(next, (d) => moveGroupMember(d, gid, 3, -5));
    expect(next.groups[0].fixtureIds[0]).toBe(ids[3]);
    next = edit(next, (d) => removeGroupMember(d, gid, ids[0]));
    expect(next.groups[0].fixtureIds).toHaveLength(3);
  });

  it("成员减到 2 个以下时分组被删除；删除分组连同轨道上的 Cue", () => {
    const { project, ids } = withRgbw(2);
    let gid = "";
    let next = edit(project, (d) => {
      gid = createGroup(d, "g", ids) ?? "";
    });
    const groupTrack = next.tracks.find((t) => t.target.kind === "group")!;
    next = edit(next, (d) => {
      d.cues.push(cue("c", groupTrack.id));
    });
    const dropped = edit(next, (d) => removeGroupMember(d, gid, ids[0]));
    expect(dropped.groups).toEqual([]);
    expect(dropped.cues).toEqual([]);
    const removed = edit(next, (d) => removeGroup(d, gid));
    expect(removed.groups).toEqual([]);
    expect(removed.tracks.every((t) => t.target.kind === "fixture")).toBe(true);
  });
});

describe("撤销友好：编辑不改动旧快照", () => {
  it("旧快照保持不变", () => {
    const { project, ids } = withRgbw(2);
    const before = structuredClone(project);
    edit(project, (d) => {
      removeFixtures(d, ids);
    });
    expect(project).toEqual(before);
  });
});
