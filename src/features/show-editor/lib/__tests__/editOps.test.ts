import { describe, expect, it } from "vitest";
import { produce } from "immer";

import { addLookCue, addStaticCue } from "../cueOps";
import {
  adjacentCue,
  adjacentEditPoint,
  clampTime,
  duplicateCuesTo,
  editPoints,
  setCueLengths,
  setCueTag,
  toggleCuesDisabled,
  trimCuesAt,
  trimMediaAt,
} from "../editOps";
import { addFixtures } from "../ops";
import { createEmptyProject, type MediaClip, type ShowProject } from "../project";
import { parseProject } from "../schema";
import { RGBW } from "./testkit";

/** 两条灯具轨道；第一条上有 0~2000 的外观片段（带关键帧）和 3000~5000 的静态片段。 */
function base(): ShowProject {
  return produce(createEmptyProject("t"), (d) => {
    d.durationMs = 20_000;
    addFixtures(d, RGBW, 2);
    const t = d.tracks[0].id;
    addLookCue(
      d,
      t,
      0,
      {
        intensity: {
          kind: "keys",
          keys: [
            { tMs: 0, value: 0, curve: "linear" },
            { tMs: 1500, value: 100, curve: "linear" },
          ],
        },
      },
      2000,
    );
    addStaticCue(d, t, 3000, { lengthMs: 2000 });
  });
}

const t0 = (p: ShowProject) => p.tracks[0].id;
const t1 = (p: ShowProject) => p.tracks[1].id;
const look = (p: ShowProject) => p.cues.find((c) => c.kind === "look")!;
const stat = (p: ShowProject) => p.cues.find((c) => c.kind === "static")!;

const clip = (over: Partial<MediaClip>): MediaClip => ({
  id: "m",
  trackId: "mt",
  mediaId: "a",
  startMs: 0,
  inMs: 0,
  durationMs: 1000,
  volume: 1,
  fadeInMs: 0,
  fadeOutMs: 0,
  ...over,
});

describe("Q / W 修剪", () => {
  it("删左侧：片段从播放头开始，关键帧保持在原来的绝对时刻", () => {
    const p = base();
    let n = 0;
    const q = produce(p, (d) => {
      n = trimCuesAt(d, [look(p).id], 1000, "start");
    });
    expect(n).toBe(1);
    const c = look(q);
    expect([c.startMs, c.endMs]).toEqual([1000, 2000]);
    // 原来 1500 ms 的关键帧，现在相对新起点是 500 ms
    expect(c.kind === "look" && c.look.intensity?.kind === "keys" && c.look.intensity.keys.map((k) => k.tMs)).toEqual([0, 500]);
    expect(q.cues).toHaveLength(2);
  });

  it("删右侧：保留原 id 的左半段；播放头不在片段内或太靠边时不动", () => {
    const p = base();
    const q = produce(p, (d) => void trimCuesAt(d, [look(p).id, stat(p).id], 1000, "end"));
    expect([look(q).id, look(q).startMs, look(q).endMs]).toEqual([look(p).id, 0, 1000]);
    // 静态片段 3000~5000 不跨过 1000，原样保留
    expect(stat(q)).toEqual(stat(p));
    let n = -1;
    produce(p, (d) => {
      n = trimCuesAt(d, [look(p).id], 1950, "end");
    });
    expect(n).toBe(0);
  });

  it("锁定轨道上的片段不修剪", () => {
    const p = produce(base(), (d) => {
      d.tracks[0].lock = true;
    });
    let n = -1;
    const q = produce(p, (d) => {
      n = trimCuesAt(d, [look(p).id], 1000, "start");
    });
    expect(n).toBe(0);
    expect(q).toBe(p);
  });

  it("媒体片段：删左侧时入点随之后移", () => {
    const p = produce(base(), (d) => {
      d.mediaClips.push(clip({ id: "m", startMs: 0, durationMs: 2000 }));
    });
    const q = produce(p, (d) => void trimMediaAt(d, ["m"], 500, "start"));
    expect(q.mediaClips).toHaveLength(1);
    expect(q.mediaClips[0]).toMatchObject({ startMs: 500, inMs: 500, durationMs: 1500 });
    const r = produce(p, (d) => void trimMediaAt(d, ["m"], 500, "end"));
    expect(r.mediaClips).toEqual([expect.objectContaining({ id: "m", startMs: 0, durationMs: 500 })]);
  });
});

describe("剪辑点与相邻片段", () => {
  it("剪辑点：节目起止、片段边缘、媒体、标记与段落，升序去重", () => {
    const p = produce(base(), (d) => {
      d.mediaClips.push(clip({ startMs: 6000, durationMs: 1000 }));
      d.markers.push({ id: "k", timeMs: 8000, label: "k" });
    });
    expect(editPoints(p)).toEqual([0, 2000, 3000, 5000, 6000, 7000, 8000, 20_000]);
  });

  it("上一个 / 下一个剪辑点：相差不到一帧的视为同一点，到头为 null", () => {
    const pts = [0, 2000, 3000, 20_000];
    expect(adjacentEditPoint(pts, 2000, 1)).toBe(3000);
    expect(adjacentEditPoint(pts, 2005, -1)).toBe(0);
    expect(adjacentEditPoint(pts, 2500, -1)).toBe(2000);
    expect(adjacentEditPoint(pts, 20_000, 1)).toBeNull();
    expect(adjacentEditPoint(pts, 0, -1)).toBeNull();
  });

  it("相邻片段：有当前片段时取前后一个，否则以播放头为准", () => {
    const p = base();
    const [a, b] = [look(p).id, stat(p).id];
    expect(adjacentCue(p, t0(p), a, 0, 1)).toBe(b);
    expect(adjacentCue(p, t0(p), b, 0, 1)).toBeNull();
    expect(adjacentCue(p, t0(p), b, 0, -1)).toBe(a);
    expect(adjacentCue(p, t0(p), null, 2500, 1)).toBe(b);
    expect(adjacentCue(p, t0(p), null, 2500, -1)).toBe(a);
    expect(adjacentCue(p, t1(p), null, 0, 1)).toBeNull();
  });

  it("时刻夹在节目范围内", () => {
    expect(clampTime({ durationMs: 1000 }, -50)).toBe(0);
    expect(clampTime({ durationMs: 1000 }, 5000)).toBe(1000);
  });
});

describe("统一长度、复制、标签、禁用", () => {
  it("统一长度：起点不动；放不下时缩到后一个片段的起点", () => {
    const p = base();
    let n = 0;
    const q = produce(p, (d) => {
      n = setCueLengths(d, [look(p).id, stat(p).id], 4000);
    });
    expect(n).toBe(2);
    expect([look(q).startMs, look(q).endMs]).toEqual([0, 3000]);
    expect([stat(q).startMs, stat(q).endMs]).toEqual([3000, 7000]);
  });

  it("复制到给定位置：原片段不动；任何副本重叠或越界时整次放弃", () => {
    const p = base();
    let ids: string[] = [];
    const q = produce(p, (d) => {
      ids = duplicateCuesTo(d, [{ id: look(p).id, trackId: t1(p), startMs: 500, endMs: 2500 }]);
    });
    expect(ids).toHaveLength(1);
    const copy = q.cues.find((c) => c.id === ids[0])!;
    expect(copy).toMatchObject({ kind: "look", trackId: t1(p), startMs: 500, endMs: 2500 });
    expect(look(q)).toEqual(look(p));

    const clash = produce(p, (d) => {
      ids = duplicateCuesTo(d, [
        { id: look(p).id, trackId: t1(p), startMs: 0, endMs: 2000 },
        { id: stat(p).id, trackId: t0(p), startMs: 1000, endMs: 3000 },
      ]);
    });
    expect(ids).toEqual([]);
    expect(clash).toBe(p);
    produce(p, (d) => {
      ids = duplicateCuesTo(d, [{ id: look(p).id, trackId: t1(p), startMs: 19_000, endMs: 21_000 }]);
    });
    expect(ids).toEqual([]);
  });

  it("颜色标签与禁用：可清除；有一个启用时全部禁用，再切换全部启用；能存盘读回", () => {
    const p = base();
    const ids = [look(p).id, stat(p).id];
    const tagged = produce(p, (d) => {
      setCueTag(d, ids, "green");
      d.cues[0].disabled = true;
    });
    let state: boolean | null = null;
    const off = produce(tagged, (d) => {
      state = toggleCuesDisabled(d, ids);
    });
    expect(state).toBe(true);
    expect(off.cues.every((c) => c.disabled === true && c.tag === "green")).toBe(true);
    const parsed = parseProject(JSON.stringify(off));
    expect(parsed.ok && parsed.project.cues.map((c) => [c.tag, c.disabled])).toEqual([
      ["green", true],
      ["green", true],
    ]);

    const on = produce(off, (d) => {
      state = toggleCuesDisabled(d, ids);
      setCueTag(d, ids, null);
    });
    expect(state).toBe(false);
    expect(on.cues.every((c) => !("disabled" in c) && !("tag" in c))).toBe(true);
  });
});
