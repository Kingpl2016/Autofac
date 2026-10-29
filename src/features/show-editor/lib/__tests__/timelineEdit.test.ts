import { produce } from "immer";
import { describe, expect, it } from "vitest";

import { addStaticCue } from "../cueOps";
import { addFixtures, addMarker } from "../ops";
import { createEmptyProject, type Look, type ShowProject } from "../project";
import { addSection } from "../sections";
import {
  alignCueStarts,
  chainCues,
  copyRange,
  deleteRange,
  insertGap,
  keyMoveRange,
  moveLookKey,
  moveTracks,
  moveTracksBy,
  quantizeCues,
  repeatCues,
  rippleShift,
  shiftTimelineObjects,
  spaceCues,
  type EditScope,
} from "../timelineEdit";
import { RGBW } from "./testkit";

/** 三条灯具轨道、时长 20 秒；`cues` 为 `[轨道下标, 起点, 长度]`。 */
function sample(cues: [number, number, number][] = [], durationMs = 20_000): { p: ShowProject; ids: string[] } {
  const ids: string[] = [];
  const p = produce(createEmptyProject("t"), (d) => {
    d.durationMs = durationMs;
    addFixtures(d, RGBW, 3);
    for (const [row, start, length] of cues) ids.push(addStaticCue(d, d.tracks[row].id, start, { lengthMs: length }) ?? "");
  });
  expect(ids.every((id) => id !== "")).toBe(true);
  return { p, ids };
}

/** 片段 `[起点, 终点]`（按 id 查）。 */
const span = (p: ShowProject, id: string) => {
  const c = p.cues.find((x) => x.id === id);
  return c ? [c.startMs, c.endMs] : null;
};

/** 某条轨道上全部片段的 `[起点, 终点]`（按起点排序）。 */
const spansOn = (p: ShowProject, row: number) =>
  p.cues
    .filter((c) => c.trackId === p.tracks[row].id)
    .sort((a, b) => a.startMs - b.startMs)
    .map((c) => [c.startMs, c.endMs]);

const only = (p: ShowProject, ...rows: number[]): EditScope => ({ trackIds: rows.map((r) => p.tracks[r].id), objects: false });
const ALL: EditScope = { trackIds: null, objects: true };

describe("轨道排序", () => {
  it("moveTracks：移到第 n 条之前，多条保持相对顺序；顺序不变时返回 false", () => {
    const { p } = sample();
    const [a, b, c] = p.tracks.map((t) => t.id);
    const order = (q: ShowProject) => q.tracks.map((t) => t.id);
    let changed = false;
    expect(order(produce(p, (d) => void (changed = moveTracks(d, [c], 0))))).toEqual([c, a, b]);
    expect(changed).toBe(true);
    expect(order(produce(p, (d) => void moveTracks(d, [a], 3)))).toEqual([b, c, a]);
    expect(order(produce(p, (d) => void moveTracks(d, [c, a], 1)))).toEqual([a, c, b]);
    // 放回原处：不算变化
    produce(p, (d) => void (changed = moveTracks(d, [a], 1)));
    expect(changed).toBe(false);
    produce(p, (d) => void (changed = moveTracks(d, ["nope"], 0)));
    expect(changed).toBe(false);
  });

  it("moveTracksBy：整组上移 / 下移一位，到顶 / 到底不动", () => {
    const { p } = sample();
    const [a, b, c] = p.tracks.map((t) => t.id);
    const order = (q: ShowProject) => q.tracks.map((t) => t.id);
    expect(order(produce(p, (d) => void moveTracksBy(d, [b], -1)))).toEqual([b, a, c]);
    expect(order(produce(p, (d) => void moveTracksBy(d, [a, b], 1)))).toEqual([c, a, b]);
    let changed = true;
    produce(p, (d) => void (changed = moveTracksBy(d, [a], -1)));
    expect(changed).toBe(false);
    produce(p, (d) => void (changed = moveTracksBy(d, [c], 1)));
    expect(changed).toBe(false);
  });
});

describe("片段排列", () => {
  it("起点对齐：到最早的起点或指定时刻；同轨会重叠时整次放弃", () => {
    const { p, ids } = sample([
      [0, 1000, 1000],
      [1, 3000, 2000],
      [1, 8000, 1000],
    ]);
    let ok = false;
    const q = produce(p, (d) => void (ok = alignCueStarts(d, [ids[0], ids[1]])));
    expect(ok).toBe(true);
    expect([span(q, ids[0]), span(q, ids[1])]).toEqual([
      [1000, 2000],
      [1000, 3000],
    ]);
    const r = produce(p, (d) => void alignCueStarts(d, [ids[0], ids[1]], 5000));
    expect([span(r, ids[0]), span(r, ids[1])]).toEqual([
      [5000, 6000],
      [5000, 7000],
    ]);
    const s = produce(p, (d) => void (ok = alignCueStarts(d, [ids[1], ids[2]])));
    expect(ok).toBe(false);
    expect(s).toBe(p);
  });

  it("首尾相接：第一个不动，后面依次接上（可留间隔）", () => {
    const { p, ids } = sample([
      [0, 0, 1000],
      [0, 3000, 1000],
      [0, 6000, 1000],
    ]);
    expect(spansOn(produce(p, (d) => void chainCues(d, ids)), 0)).toEqual([
      [0, 1000],
      [1000, 2000],
      [2000, 3000],
    ]);
    expect(spansOn(produce(p, (d) => void chainCues(d, ids, 500)), 0)).toEqual([
      [0, 1000],
      [1500, 2500],
      [3000, 4000],
    ]);
    let ok = true;
    produce(p, (d) => void (ok = chainCues(d, [ids[0]])));
    expect(ok).toBe(false);
  });

  it("等距排开：第 i 个起点 = 第一个起点 + i × 间隔", () => {
    const { p, ids } = sample([
      [0, 0, 1000],
      [1, 500, 1000],
      [2, 5000, 1000],
    ]);
    const q = produce(p, (d) => void spaceCues(d, ids, 2000));
    expect(ids.map((id) => span(q, id)?.[0])).toEqual([0, 2000, 4000]);
    let ok = true;
    produce(p, (d) => void (ok = spaceCues(d, ids, 0)));
    expect(ok).toBe(false);
  });

  it("量化：起点吸到最近的节拍；已经在网格上时返回 false", () => {
    const { p, ids } = sample([
      [0, 1100, 200],
      [1, 1300, 200],
    ]);
    const tempo = { bpm: 120, offsetMs: 0, beatsPerBar: 4 };
    let ok = false;
    const q = produce(p, (d) => void (ok = quantizeCues(d, ids, tempo)));
    expect(ok).toBe(true);
    expect(ids.map((id) => span(q, id))).toEqual([
      [1000, 1200],
      [1500, 1700],
    ]);
    produce(q, (d) => void (ok = quantizeCues(d, ids, tempo)));
    expect(ok).toBe(false);
  });

  it("复制多份：整组按“跨度 + 间隔”往后复制；放不下时停在那一份", () => {
    const { p, ids } = sample([
      [0, 0, 1000],
      [1, 500, 1000],
    ]);
    let r = { ids: [] as string[], copies: 0 };
    const q = produce(p, (d) => void (r = repeatCues(d, ids, 3, 500)));
    expect(r.copies).toBe(3);
    expect(r.ids).toHaveLength(6);
    expect(spansOn(q, 0).map((s) => s[0])).toEqual([0, 2000, 4000, 6000]);
    expect(spansOn(q, 1).map((s) => s[0])).toEqual([500, 2500, 4500, 6500]);
    // 20 秒里，每 2 秒一份、每份占 1.5 秒：最多放 9 份
    const full = produce(p, (d) => void (r = repeatCues(d, ids, 64, 500)));
    expect(r.copies).toBe(9);
    expect(Math.max(...full.cues.map((c) => c.endMs))).toBeLessThanOrEqual(20_000);
  });

  it("锁定轨道上的片段不参与排列", () => {
    const { p, ids } = sample([
      [0, 0, 1000],
      [1, 3000, 1000],
    ]);
    const locked = produce(p, (d) => void (d.tracks[1].lock = true));
    const q = produce(locked, (d) => void alignCueStarts(d, ids, 5000));
    expect([span(q, ids[0]), span(q, ids[1])]).toEqual([
      [5000, 6000],
      [3000, 4000],
    ]);
  });
});

describe("波纹平移", () => {
  it("只动范围内、起点不早于 fromMs 的片段；往后推超出时长时延长节目", () => {
    const { p, ids } = sample(
      [
        [0, 0, 1000],
        [0, 2000, 1000],
        [0, 5000, 1000],
        [1, 2000, 1000],
      ],
      6000,
    );
    let delta = 0;
    const q = produce(p, (d) => void (delta = rippleShift(d, only(d, 0), 2000, 1000)));
    expect(delta).toBe(1000);
    expect(spansOn(q, 0)).toEqual([
      [0, 1000],
      [3000, 4000],
      [6000, 7000],
    ]);
    expect(span(q, ids[3])).toEqual([2000, 3000]);
    expect(q.durationMs).toBe(7000);
  });

  it("往前移被同轨不动的片段截停；exclude 的片段不移动", () => {
    const { p, ids } = sample([
      [0, 0, 1000],
      [0, 2000, 1000],
      [0, 5000, 1000],
    ]);
    let delta = 0;
    const q = produce(p, (d) => void (delta = rippleShift(d, only(d, 0), 2000, -1500)));
    expect(delta).toBe(-1000);
    expect(spansOn(q, 0)).toEqual([
      [0, 1000],
      [1000, 2000],
      [4000, 5000],
    ]);
    const r = produce(p, (d) => void rippleShift(d, only(d, 0), 2000, 500, new Set([ids[1]])));
    expect(spansOn(r, 0)).toEqual([
      [0, 1000],
      [2000, 3000],
      [5500, 6500],
    ]);
  });

  it("全部轨道：标记点、段落、循环区与媒体片段一起移动；锁定轨道不动", () => {
    const { p, ids } = sample([
      [0, 3000, 1000],
      [1, 4000, 1000],
      [2, 4000, 1000],
    ]);
    const q = produce(p, (d) => {
      d.tracks[2].lock = true;
      addMarker(d, 1000);
      addMarker(d, 4000);
      addSection(d, 4000, 2000, "副歌");
      d.loopRange = { startMs: 1000, endMs: 8000 };
      d.mediaTracks.push({ id: "mt", kind: "audio", name: "a", mute: false, solo: false, lock: false, volume: 1 });
      d.mediaClips.push({ id: "m", trackId: "mt", mediaId: "a", startMs: 3000, inMs: 0, durationMs: 1000, volume: 1, fadeInMs: 0, fadeOutMs: 0 });
      rippleShift(d, ALL, 3000, 1000);
    });
    expect([span(q, ids[0]), span(q, ids[1]), span(q, ids[2])]).toEqual([
      [4000, 5000],
      [5000, 6000],
      [4000, 5000],
    ]);
    expect(q.markers.map((m) => m.timeMs).sort((a, b) => a - b)).toEqual([1000, 5000]);
    expect(q.sections.map((s) => [s.startMs, s.endMs])).toEqual([[5000, 7000]]);
    expect(q.loopRange).toEqual({ startMs: 1000, endMs: 9000 });
    expect(q.mediaClips[0].startMs).toBe(4000);
  });

  it("shiftTimelineObjects 只移标记点等，不动片段", () => {
    const { p, ids } = sample([[0, 3000, 1000]]);
    const q = produce(p, (d) => {
      addMarker(d, 2000);
      addMarker(d, 5000);
      shiftTimelineObjects(d, 3000, -500);
    });
    expect(q.markers.map((m) => m.timeMs).sort((a, b) => a - b)).toEqual([2000, 4500]);
    expect(span(q, ids[0])).toEqual([3000, 4000]);
  });
});

describe("时间范围", () => {
  it("插入空白：跨过插入点的片段切开，后面整体推后；后面没有内容时返回 false", () => {
    const { p } = sample([
      [0, 1000, 2000],
      [1, 1000, 2000],
    ]);
    let ok = false;
    const q = produce(p, (d) => void (ok = insertGap(d, 2000, 1000, only(d, 0))));
    expect(ok).toBe(true);
    expect(spansOn(q, 0)).toEqual([
      [1000, 2000],
      [3000, 4000],
    ]);
    expect(spansOn(q, 1)).toEqual([[1000, 3000]]);
    produce(p, (d) => void (ok = insertGap(d, 10_000, 1000, only(d, 0))));
    expect(ok).toBe(false);
    // 全部轨道：后面只有标记点也算有内容被推后
    const marked = produce(p, (d) => {
      addMarker(d, 12_000);
      ok = insertGap(d, 10_000, 1000, ALL);
    });
    expect(ok).toBe(true);
    expect(marked.markers[0].timeMs).toBe(13_000);
  });

  it("删除一段时间：两端切开删掉中间；合拢时后面前移", () => {
    const { p } = sample([
      [0, 0, 2000],
      [0, 3000, 1000],
      [0, 5000, 2000],
    ]);
    let n = 0;
    const open = produce(p, (d) => void (n = deleteRange(d, { startMs: 1000, endMs: 6000 }, only(d, 0), false)));
    expect(n).toBe(3);
    expect(spansOn(open, 0)).toEqual([
      [0, 1000],
      [6000, 7000],
    ]);
    // 起止颠倒也行
    const closed = produce(p, (d) => void deleteRange(d, { startMs: 6000, endMs: 1000 }, only(d, 0), true));
    expect(spansOn(closed, 0)).toEqual([
      [0, 1000],
      [1000, 2000],
    ]);
  });

  it("全部轨道合拢：范围里的标记点删除，后面的标记点、段落一起前移；范围外的轨道不受影响", () => {
    const { p } = sample([
      [0, 0, 1000],
      [0, 7000, 1000],
      [1, 7000, 1000],
    ]);
    const q = produce(p, (d) => {
      d.tracks[1].lock = true;
      addMarker(d, 2000);
      addMarker(d, 8000);
      addSection(d, 6500, 2500, "尾声");
      deleteRange(d, { startMs: 1000, endMs: 6000 }, ALL, true);
    });
    expect(spansOn(q, 0)).toEqual([
      [0, 1000],
      [2000, 3000],
    ]);
    expect(spansOn(q, 1)).toEqual([[7000, 8000]]);
    expect(q.markers.map((m) => m.timeMs)).toEqual([3000]);
    expect(q.sections.map((s) => [s.startMs, s.endMs])).toEqual([[1500, 4000]]);
  });

  it("复制一段时间：只取范围里的部分，偏移相对范围起点；锁定轨道也能复制，原工程不变", () => {
    const { p } = sample([
      [0, 0, 2000],
      [1, 1500, 1500],
    ]);
    const locked = produce(p, (d) => void (d.tracks[0].lock = true));
    const clip = copyRange(locked, { startMs: 1000, endMs: 2500 }, null);
    expect(clip.map((c) => [c.trackId, c.offsetMs, c.lengthMs])).toEqual([
      [p.tracks[0].id, 0, 1000],
      [p.tracks[1].id, 500, 1000],
    ]);
    expect(spansOn(locked, 0)).toEqual([[0, 2000]]);
    expect(copyRange(locked, { startMs: 1000, endMs: 2500 }, [p.tracks[1].id])).toHaveLength(1);
  });
});

describe("关键帧移动", () => {
  const look = (): Look => ({
    intensity: {
      kind: "keys",
      keys: [
        { tMs: 0, value: 0, curve: "linear" },
        { tMs: 1000, value: 100, curve: "linear" },
        { tMs: 2000, value: 50, curve: "linear" },
      ],
    },
  });
  const times = (l: Look) => (l.intensity?.kind === "keys" ? l.intensity.keys.map((k) => k.tMs) : []);

  it("可移动范围不越过相邻关键帧、不出片段", () => {
    expect(keyMoveRange(look(), 1000, 3000)).toEqual([1, 1999]);
    expect(keyMoveRange(look(), 0, 3000)).toEqual([0, 999]);
    expect(keyMoveRange(look(), 2000, 3000)).toEqual([1001, 3000]);
  });

  it("移动被夹在允许范围；复制保留原关键帧；没有这个时刻时为 null", () => {
    const moved = look();
    expect(moveLookKey(moved, 1000, 5000, 3000)).toBe(1999);
    expect(times(moved)).toEqual([0, 1999, 2000]);
    const copied = look();
    expect(moveLookKey(copied, 0, 2500, 3000, true)).toBe(2500);
    expect(times(copied)).toEqual([0, 1000, 2000, 2500]);
    expect(moveLookKey(look(), 1234, 1500, 3000)).toBeNull();
  });
});
