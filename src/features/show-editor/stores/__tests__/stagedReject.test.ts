import { produce } from "immer";
import { beforeEach, describe, expect, it } from "vitest";

import { buildAliases } from "../../ai/aliases";
import { planOps, type CompileEnv } from "../../ai/compile";
import { displayTracks, stagedGhosts } from "../../ai/ghosts";
import { aiOpsSchema } from "../../ai/opsSchema";
import { BUILTIN_TEMPLATES } from "../../lib/cueTemplates";
import { BUILTIN_EFFECTS } from "../../lib/effectLibrary";
import { addFixtures } from "../../lib/ops";
import { createEmptyProject, type ShowProject } from "../../lib/project";
import { RGBW } from "../../lib/__tests__/testkit";
import { dependentsOf, makeStaged, rejectOp, restoreOps, useAiStagingStore } from "../useAiStagingStore";

const env: CompileEnv = { effects: BUILTIN_EFFECTS, templates: BUILTIN_TEMPLATES, libraryModels: [], lang: "zh", playheadMs: 0, selection: [] };

const base: ShowProject = produce(createEmptyProject("t"), (d) => {
  addFixtures(d, RGBW, 4);
  d.durationMs = 16_000;
  d.tempo = { bpm: 120, offsetMs: 0, beatsPerBar: 4 };
});

const ops = aiOpsSchema.parse({
  summary: "s",
  ops: [
    // 0：新建分组 new_front
    { op: "createGroup", as: "new_front", name: "前排", members: ["F1", "F2"] },
    // 1：在 new_front 上放呼吸（依赖 0）
    { op: "addEffect", target: "new_front", from: "b1", to: "b3", effect: "breathe" },
    // 2：全部灯 b5~b7 彩虹（独立）
    { op: "addEffect", target: "all", from: "b5", to: "b7", effect: "rainbow" },
    // 3：加标记点（独立）
    { op: "addMarker", at: "b2", label: "x" },
  ],
}).ops;

const stage = () => {
  const s = makeStaged({ summary: "s", ops, base, aliases: buildAliases(base), env, source: "chat" })!;
  useAiStagingStore.setState({ staged: s, previewing: true, outcomes: {} });
  return s;
};

beforeEach(() => useAiStagingStore.setState({ staged: null }));

describe("逐条拒绝 AI 改动", () => {
  it("每条操作的影响与依赖：用了本批新建分组的操作依赖建分组的那条", () => {
    const s = stage();
    expect(s.effects.map((e) => [e?.added.length, e?.deps])).toEqual([
      [0, []],
      [1, [0]],
      [1, []],
      [0, []],
    ]);
    expect(dependentsOf(s, 0)).toEqual([1]);
    expect(dependentsOf(s, 2)).toEqual([]);
  });

  it("拒绝一条：连同依赖它的一起拒绝；结果等于只用剩下的操作试运行", () => {
    stage();
    const r = rejectOp(0);
    expect(r).toEqual({ ok: true, rejected: [0, 1] });
    const s = useAiStagingStore.getState().staged!;
    expect(s.rejected).toEqual([
      { index: 0, reason: "user" },
      { index: 1, reason: "dependency" },
    ]);
    expect(s.ops.map((o) => o.op)).toEqual(["addEffect", "addMarker"]);
    const direct = planOps(base, [ops[2], ops[3]], env, buildAliases(base)).next;
    expect(s.next.cues.map((c) => [c.startMs, c.endMs])).toEqual(direct.cues.map((c) => [c.startMs, c.endMs]));
    expect(s.next.groups.map((g) => g.name)).toEqual(direct.groups.map((g) => g.name));
    expect(s.effects[0]).toBeNull();
    expect(s.effects[2]?.added).toHaveLength(1);
  });

  it("恢复：单条恢复时它依赖的也一起恢复；全部恢复回到原样；全部拒绝等于放弃", () => {
    const original = stage();
    rejectOp(0);
    expect(restoreOps([1])).toBe(true);
    expect(useAiStagingStore.getState().staged!.rejected).toEqual([]);
    rejectOp(3);
    expect(useAiStagingStore.getState().staged!.ops).toHaveLength(3);
    expect(restoreOps()).toBe(true);
    const back = useAiStagingStore.getState().staged!;
    expect(back.ops).toEqual(original.ops);
    expect(back.next.cues.length).toBe(original.next.cues.length);

    rejectOp(0);
    rejectOp(2);
    rejectOp(3);
    expect(useAiStagingStore.getState().staged).toBeNull();
  });

  it("虚影：新增的片段归到产生它的操作；新建的轨道插在改动后的位置并锁定", () => {
    const s = stage();
    const ghosts = stagedGhosts(s);
    expect(ghosts.map((g) => [g.kind, g.opIndex])).toEqual(expect.arrayContaining([["add", 1], ["add", 2]]));
    expect(ghosts).toHaveLength(2);
    const shown = displayTracks(base, s);
    expect(shown.tracks.length).toBe(s.next.tracks.length);
    expect(shown.pendingIds.size).toBe(s.next.tracks.length - base.tracks.length);
    expect(shown.tracks.filter((t) => shown.pendingIds.has(t.id)).every((t) => t.lock)).toBe(true);
    expect(shown.names.filter((_, i) => shown.pendingIds.has(shown.tracks[i].id))).toEqual(["前排", "全部灯具"]);
    expect(displayTracks(base, null).tracks).toBe(base.tracks);
  });

  it("修改与删除已有片段的虚影", () => {
    const withCue = planOps(base, aiOpsSchema.parse({ summary: "", ops: [{ op: "addEffect", target: "F1", from: "b1", to: "b3", effect: "breathe" }] }).ops, env, buildAliases(base)).next;
    const s = makeStaged({
      summary: "s",
      ops: aiOpsSchema.parse({ summary: "", ops: [{ op: "editCues", cues: ["C1"], brightness: 50 }, { op: "addEffect", target: "F2", from: "b1", to: "b2", effect: "pulse" }] }).ops,
      base: withCue,
      aliases: buildAliases(withCue),
      env,
      source: "chat",
    })!;
    expect(stagedGhosts(s).map((g) => [g.kind, g.opIndex])).toEqual(expect.arrayContaining([["change", 0], ["add", 1]]));
    const del = makeStaged({ summary: "s", ops: aiOpsSchema.parse({ summary: "", ops: [{ op: "deleteCues", cues: ["C1"] }] }).ops, base: withCue, aliases: buildAliases(withCue), env, source: "chat" })!;
    expect(stagedGhosts(del)).toMatchObject([{ kind: "remove", opIndex: 0, cue: { id: withCue.cues[0].id } }]);
  });
});
