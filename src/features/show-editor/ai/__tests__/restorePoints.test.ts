import { produce } from "immer";
import { describe, expect, it } from "vitest";

import { addFixtures } from "../../lib/ops";
import { createEmptyProject, type ShowProject, type StaticCue } from "../../lib/project";
import { RGBW } from "../../lib/__tests__/testkit";
import { diffProjects, makeRestorePoint, MAX_RESTORE_POINTS, pushPoint, reapplyPoint, restoreBefore, revertPoint } from "../restorePoints";

const cue = (trackId: string, id: string, startMs: number, rgb: [number, number, number] = [255, 0, 0]): StaticCue => ({
  id,
  kind: "static",
  trackId,
  startMs,
  endMs: startMs + 1000,
  brightness: 100,
  fadeInMs: 0,
  fadeOutMs: 0,
  easing: "linear",
  rgb,
});

const base = (): ShowProject =>
  produce(createEmptyProject("t"), (d) => {
    addFixtures(d, RGBW, 2);
    d.durationMs = 16_000;
    d.cues.push(cue(d.tracks[0].id, "keep", 0), cue(d.tracks[0].id, "old", 2000));
  });

/** AI 的改动：新增 a、b，删掉 old，把 keep 改成蓝色，设上速度。 */
const aiChange = (p: ShowProject) =>
  produce(p, (d) => {
    const tr = d.tracks[0].id;
    d.cues = d.cues.filter((c) => c.id !== "old");
    (d.cues.find((c) => c.id === "keep") as StaticCue).rgb = [0, 0, 255];
    d.cues.push(cue(tr, "a", 4000), cue(tr, "b", 6000));
    d.tempo = { bpm: 128, offsetMs: 0, beatsPerBar: 4 };
  });

describe("AI 改动的还原点", () => {
  it("只记下变了的字段与片段", () => {
    const before = base();
    const after = aiChange(before);
    const changes = diffProjects(before, after);
    expect(changes.map((c) => c.key).sort()).toEqual(["cues", "tempo"]);
    const cues = changes.find((c) => c.key === "cues")!;
    expect(cues.kind === "items" && [cues.added.map((x) => x.id), cues.removed.map((x) => x.item.id), cues.changed.map((x) => x.after.id)]).toEqual([["a", "b"], ["old"], ["keep"]]);
    expect(makeRestorePoint(before, before, { summary: "", source: "chat" })).toBeNull();
    expect(makeRestorePoint(before, after, { summary: "s", source: "chat" })?.cueCount).toBe(4);
  });

  it("只撤回这次：之后手动改过的片段跳过，AI 没碰过的内容不受影响", () => {
    const before = base();
    const after = aiChange(before);
    const point = makeRestorePoint(before, after, { summary: "s", source: "chat" })!;
    // 之后：手动把 a 挪了位置，又新建了一个 manual
    const edited = produce(after, (d) => {
      d.cues.find((c) => c.id === "a")!.startMs = 5000;
      d.cues.push(cue(d.tracks[1].id, "manual", 0));
    });
    const r = revertPoint(edited, point);
    expect(r.skipped).toBe(1);
    const ids = r.next.cues.map((c) => c.id).sort();
    expect(ids).toEqual(["a", "keep", "manual", "old"]);
    expect((r.next.cues.find((c) => c.id === "keep") as StaticCue).rgb).toEqual([255, 0, 0]);
    expect(r.next.tempo).toEqual(before.tempo);
    // 重新应用：反方向
    const again = reapplyPoint(r.next, point);
    expect(again.next.cues.map((c) => c.id).sort()).toEqual(["a", "b", "keep", "manual"]);
    expect(again.next.tempo?.bpm).toBe(128);
  });

  it("恢复到某次之前：这一次及之后的 AI 改动全部强制改回", () => {
    const p0 = base();
    const p1 = aiChange(p0);
    const first = makeRestorePoint(p0, p1, { summary: "1", source: "chat" })!;
    const p2 = produce(p1, (d) => {
      d.cues.push(cue(d.tracks[1].id, "c", 0));
    });
    const second = makeRestorePoint(p1, p2, { summary: "2", source: "suggestion" })!;
    // 之后手动改了 b（冲突也覆盖）
    const edited = produce(p2, (d) => {
      d.cues.find((c) => c.id === "b")!.startMs = 9000;
    });
    const r = restoreBefore(edited, [first, second], first.id);
    expect(r.reverted).toEqual([second.id, first.id]);
    expect(r.next.cues.map((c) => c.id).sort()).toEqual(["keep", "old"]);
    expect(r.next.tempo).toEqual(p0.tempo);
  });

  it("最多保留 20 个", () => {
    const p0 = base();
    const point = makeRestorePoint(p0, aiChange(p0), { summary: "x", source: "draft" })!;
    let list = [point];
    for (let i = 0; i < 25; i += 1) list = pushPoint(list, { ...point, id: `p${i}` });
    expect(list).toHaveLength(MAX_RESTORE_POINTS);
    expect(list.at(-1)!.id).toBe("p24");
  });
});
