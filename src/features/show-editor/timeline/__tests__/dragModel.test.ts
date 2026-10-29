import { produce } from "immer";
import { describe, expect, it } from "vitest";

import { addStaticCue, checkPlacements, placeCues } from "../../lib/cueOps";
import { addFixtures } from "../../lib/ops";
import { createEmptyProject, type LookClip, type ShowProject } from "../../lib/project";
import { projectIntegrityIssues } from "../../lib/schema";
import { RGBW } from "../../lib/__tests__/testkit";
import { computeDrag, marqueeHits, type DragInput } from "../dragModel";

/** 三条轨道（第三条锁定）、时长 20 秒；轨道 0 上有 1~3 秒、5~6 秒两个片段，轨道 1 上有 2~4 秒。 */
function sample(): { project: ShowProject; a: string; b: string; c: string; ids: string[] } {
  const ids: string[] = [];
  const project = produce(createEmptyProject("t"), (d) => {
    addFixtures(d, RGBW, 3);
    d.durationMs = 20_000;
    ids.push(addStaticCue(d, d.tracks[0].id, 1000, { lengthMs: 2000 }) ?? "");
    ids.push(addStaticCue(d, d.tracks[0].id, 5000, { lengthMs: 1000 }) ?? "");
    ids.push(addStaticCue(d, d.tracks[1].id, 2000, { lengthMs: 2000 }) ?? "");
    d.tracks[2].lock = true;
  });
  return { project, a: project.tracks[0].id, b: project.tracks[1].id, c: project.tracks[2].id, ids };
}

const input = (over: Partial<DragInput>): DragInput => ({
  kind: "move",
  ids: [],
  deltaMs: 0,
  rowDelta: 0,
  snapTargets: null,
  thresholdMs: 100,
  ...over,
});

describe("移动", () => {
  it("整体平移，对齐到帧，保持长度", () => {
    const { project, ids, a } = sample();
    const r = computeDrag(project, input({ ids: [ids[1]], deltaMs: 1010 }));
    expect(r.valid).toBe(true);
    expect(r.placements).toEqual([{ id: ids[1], trackId: a, startMs: 6000, endMs: 7000 }]);
    expect(r.guideMs).toBeNull();
  });

  it("被同轨邻居挡住时贴着邻居停下", () => {
    const { project, ids } = sample();
    // 1~3 秒的片段往右拖 4 秒会压住 5~6 秒：停在 3~5 秒
    const r = computeDrag(project, input({ ids: [ids[0]], deltaMs: 4000 }));
    expect(r.valid).toBe(true);
    expect(r.placements[0]).toMatchObject({ startMs: 3000, endMs: 5000 });
    // 往左拖出节目起点：停在 0
    expect(computeDrag(project, input({ ids: [ids[0]], deltaMs: -5000 })).placements[0]).toMatchObject({ startMs: 0 });
  });

  it("多选整体移动：同轨两个片段一起走，相对位置不变", () => {
    const { project, ids } = sample();
    const r = computeDrag(project, input({ ids: [ids[0], ids[1]], deltaMs: 2000 }));
    expect(r.placements.map((p) => [p.startMs, p.endMs])).toEqual([
      [3000, 5000],
      [7000, 8000],
    ]);
    expect(r.valid).toBe(true);
  });

  it("实时吸附：起点或终点靠近目标就吸过去，并给出吸附线位置", () => {
    const { project, ids } = sample();
    // 5~6 秒的片段拖到 7.95~8.95 秒，终点离 9 秒 50ms：吸到 8~9 秒
    const r = computeDrag(project, input({ ids: [ids[1]], deltaMs: 2950, snapTargets: [9000, 12_000] }));
    expect(r.placements[0]).toMatchObject({ startMs: 8000, endMs: 9000 });
    expect(r.guideMs).toBe(9000);
  });

  it("换轨：目标轨道可用时换过去；锁定或越界时退回原轨", () => {
    const { project, ids, b } = sample();
    const ok = computeDrag(project, input({ ids: [ids[1]], rowDelta: 1 }));
    expect(ok).toMatchObject({ rowDelta: 1, valid: true });
    expect(ok.placements[0].trackId).toBe(b);
    // 压住轨道 1 上 2~4 秒的片段：不合法（预览标红）
    const blocked = computeDrag(project, input({ ids: [ids[0]], rowDelta: 1 }));
    expect(blocked.valid).toBe(false);
    // 轨道 2 锁定：不换轨
    expect(computeDrag(project, input({ ids: [ids[2]], rowDelta: 1 })).rowDelta).toBe(0);
    expect(computeDrag(project, input({ ids: [ids[0]], rowDelta: -1 })).rowDelta).toBe(0);
  });
});

describe("裁剪", () => {
  it("左裁剪：不越过前一个片段，不短于最短长度", () => {
    const { project, ids } = sample();
    expect(computeDrag(project, input({ kind: "trimStart", ids: [ids[1]], deltaMs: -500 })).placements[0]).toMatchObject({
      startMs: 4500,
      endMs: 6000,
    });
    expect(computeDrag(project, input({ kind: "trimStart", ids: [ids[1]], deltaMs: -9000 })).placements[0].startMs).toBe(3000);
    expect(computeDrag(project, input({ kind: "trimStart", ids: [ids[1]], deltaMs: 5000 })).placements[0].startMs).toBe(5900);
  });

  it("右裁剪：吸附终点，不越过后一个片段", () => {
    const { project, ids } = sample();
    const r = computeDrag(project, input({ kind: "trimEnd", ids: [ids[0]], deltaMs: 950, snapTargets: [4000] }));
    expect(r.placements[0]).toMatchObject({ startMs: 1000, endMs: 4000 });
    expect(r.guideMs).toBe(4000);
    expect(computeDrag(project, input({ kind: "trimEnd", ids: [ids[0]], deltaMs: 9000 })).placements[0].endMs).toBe(5000);
  });
});

describe("placeCues", () => {
  it("整组生效或整组不动；换轨后完整性仍然成立", () => {
    const { project, ids, a, b } = sample();
    const moved = produce(project, (d) => {
      expect(placeCues(d, [{ id: ids[1], trackId: b, startMs: 6000, endMs: 7000 }])).toBe(true);
    });
    expect(moved.cues.find((c) => c.id === ids[1])).toMatchObject({ trackId: b, startMs: 6000, endMs: 7000 });
    expect(projectIntegrityIssues(moved)).toEqual([]);
    const rejected = produce(project, (d) => {
      expect(
        placeCues(d, [
          { id: ids[0], trackId: a, startMs: 8000, endMs: 10_000 },
          { id: ids[1], trackId: b, startMs: 2500, endMs: 3500 },
        ]),
      ).toBe(false);
    });
    expect(rejected).toBe(project);
  });

  it("锁定轨道、类型不符的轨道、越界与过短都被拒绝", () => {
    const { project, ids, c } = sample();
    expect(checkPlacements(project, [{ id: ids[0], trackId: c, startMs: 0, endMs: 1000 }])).toBeNull();
    expect(checkPlacements(project, [{ id: ids[0], trackId: project.tracks[0].id, startMs: 19_500, endMs: 21_000 }])).toBeNull();
    expect(checkPlacements(project, [{ id: ids[0], trackId: project.tracks[0].id, startMs: 0, endMs: 50 }])).toBeNull();
    const withScene = produce(project, (d) => {
      d.tracks.push({ id: "scene", target: { kind: "scene" }, mute: false, solo: false, lock: false });
    });
    expect(checkPlacements(withScene, [{ id: ids[0], trackId: "scene", startMs: 0, endMs: 1000 }])).toBeNull();
  });

  it("左裁剪外观片段：关键帧按新起点重新计时，画面在绝对时间上不动", () => {
    const { project, b } = sample();
    const look: LookClip = {
      id: "look",
      kind: "look",
      trackId: b,
      startMs: 10_000,
      endMs: 14_000,
      brightness: 100,
      fadeInMs: 0,
      fadeOutMs: 0,
      easing: "linear",
      look: {
        intensity: {
          kind: "keys",
          keys: [
            { tMs: 0, value: 0, curve: "linear" },
            { tMs: 2000, value: 100, curve: "linear" },
          ],
        },
      },
    };
    const p = produce(project, (d) => void d.cues.push(look));
    const trimmed = produce(p, (d) => void placeCues(d, [{ id: "look", trackId: b, startMs: 11_000, endMs: 14_000 }]));
    const cue = trimmed.cues.find((x) => x.id === "look");
    expect(cue?.kind === "look" && cue.look.intensity?.kind === "keys" && cue.look.intensity.keys.map((k) => k.tMs)).toEqual([0, 1000]);
    // 整体移动不改关键帧
    const moved = produce(p, (d) => void placeCues(d, [{ id: "look", trackId: b, startMs: 12_000, endMs: 16_000 }]));
    const m = moved.cues.find((x) => x.id === "look");
    expect(m?.kind === "look" && m.look.intensity?.kind === "keys" && m.look.intensity.keys.map((k) => k.tMs)).toEqual([0, 2000]);
  });
});

describe("marqueeHits", () => {
  it("与选框相交的片段", () => {
    const spans = [
      { id: "a", left: 0, top: 0, width: 50, height: 40 },
      { id: "b", left: 100, top: 0, width: 50, height: 40 },
      { id: "c", left: 0, top: 50, width: 50, height: 40 },
    ];
    expect(marqueeHits(spans, { left: 40, top: 10, width: 70, height: 10 })).toEqual(["a", "b"]);
    expect(marqueeHits(spans, { left: 60, top: 60, width: 10, height: 10 })).toEqual([]);
  });
});

describe("波纹拖动", () => {
  it("同轨移动：其后的片段跟着平移，结果带上波纹信息", () => {
    const { project, ids, a } = sample();
    const r = computeDrag(project, input({ ids: [ids[0]], deltaMs: 1000, ripple: { allTracks: false } }));
    expect(r.valid).toBe(true);
    expect(r.placements).toEqual([
      { id: ids[0], trackId: a, startMs: 2000, endMs: 4000 },
      { id: ids[1], trackId: a, startMs: 6000, endMs: 7000 },
    ]);
    expect(r.ripple).toEqual({ fromMs: 3000, deltaMs: 1000, allTracks: false });
  });

  it("全部轨道：别的轨道上其后的片段也跟着移；只看同轨时不动", () => {
    const { project, ids } = sample();
    const all = computeDrag(project, input({ ids: [ids[2]], deltaMs: 500, ripple: { allTracks: true } }));
    expect(all.placements.map((p) => p.id)).toEqual([ids[2], ids[1]]);
    expect(all.placements[1]).toMatchObject({ startMs: 5500, endMs: 6500 });
    const same = computeDrag(project, input({ ids: [ids[2]], deltaMs: 500, ripple: { allTracks: false } }));
    expect(same.placements.map((p) => p.id)).toEqual([ids[2]]);
  });

  it("往左只受左边邻居限制；往右可以超出节目时长（松手时延长）", () => {
    const { project, ids } = sample();
    const left = computeDrag(project, input({ ids: [ids[1]], deltaMs: -5000, ripple: { allTracks: false } }));
    expect(left.placements[0]).toMatchObject({ startMs: 3000, endMs: 4000 });
    expect(left.ripple?.deltaMs).toBe(-2000);
    const right = computeDrag(project, input({ ids: [ids[1]], deltaMs: 15_000, ripple: { allTracks: false } }));
    expect(right.valid).toBe(true);
    expect(right.placements[0]).toMatchObject({ startMs: 20_000, endMs: 21_000 });
  });

  it("拉右边缘：后面的片段被推开，不再被它挡住", () => {
    const { project, ids } = sample();
    const plain = computeDrag(project, input({ kind: "trimEnd", ids: [ids[0]], deltaMs: 3000 }));
    expect(plain.placements).toHaveLength(1);
    expect(plain.placements[0]).toMatchObject({ endMs: 5000 });
    const r = computeDrag(project, input({ kind: "trimEnd", ids: [ids[0]], deltaMs: 3000, ripple: { allTracks: false } }));
    expect(r.valid).toBe(true);
    expect(r.placements.map((p) => [p.startMs, p.endMs])).toEqual([
      [1000, 6000],
      [8000, 9000],
    ]);
    expect(r.ripple).toEqual({ fromMs: 3000, deltaMs: 3000, allTracks: false });
  });

  it("换轨时不做波纹", () => {
    const { project, ids } = sample();
    const r = computeDrag(project, input({ ids: [ids[1]], rowDelta: 1, ripple: { allTracks: false } }));
    expect(r.rowDelta).toBe(1);
    expect(r.ripple).toBeUndefined();
  });
});
