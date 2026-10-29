import { produce } from "immer";
import { describe, expect, it } from "vitest";

import { addStaticCue } from "../cueOps";
import { setSymmetricFades } from "../editOps";
import { addFixtures } from "../ops";
import { createEmptyProject, type ShowProject } from "../project";
import { closeGaps, extendCue } from "../timelineEdit";
import { RGBW } from "./testkit";

/** 两条轨道、时长 20 秒；轨道 1 上有 2~4 秒、8~9 秒两个片段，轨道 2 上有 1~2 秒、5~6 秒。 */
function sample(): { p: ShowProject; a: string; b: string; c: string; d: string } {
  const ids = { a: "", b: "", c: "", d: "" };
  const p = produce(createEmptyProject("t"), (d) => {
    addFixtures(d, RGBW, 2);
    d.durationMs = 20_000;
    ids.a = addStaticCue(d, d.tracks[0].id, 2000, { lengthMs: 2000 }) ?? "";
    ids.b = addStaticCue(d, d.tracks[0].id, 8000, { lengthMs: 1000 }) ?? "";
    ids.c = addStaticCue(d, d.tracks[1].id, 1000, { lengthMs: 1000 }) ?? "";
    ids.d = addStaticCue(d, d.tracks[1].id, 5000, { lengthMs: 1000 }) ?? "";
  });
  return { p, ...ids };
}

const span = (p: ShowProject, id: string) => {
  const c = p.cues.find((x) => x.id === id)!;
  return [c.startMs, c.endMs];
};

describe("延伸片段", () => {
  it("终点延伸到下一个片段；播放头更近时停在播放头", () => {
    const { p, a } = sample();
    expect(span(produce(p, (d) => void extendCue(d, a, "end", 0)), a)).toEqual([2000, 8000]);
    expect(span(produce(p, (d) => void extendCue(d, a, "end", 6000)), a)).toEqual([2000, 6000]);
    // 播放头在片段之前：不算延伸方向上的停靠点
    expect(span(produce(p, (d) => void extendCue(d, a, "end", 1000)), a)).toEqual([2000, 8000]);
  });

  it("起点延伸到上一个片段的终点（没有时到 0）；最后一个片段的终点延伸到节目结尾", () => {
    const { p, a, b } = sample();
    expect(span(produce(p, (d) => void extendCue(d, a, "start", 9000)), a)).toEqual([0, 4000]);
    expect(span(produce(p, (d) => void extendCue(d, b, "start", 5000)), b)).toEqual([5000, 9000]);
    expect(span(produce(p, (d) => void extendCue(d, b, "end", 0)), b)).toEqual([8000, 20_000]);
  });

  it("已经贴住或轨道锁定时不改", () => {
    const { p, a } = sample();
    const touching = produce(p, (d) => void extendCue(d, a, "end", 0));
    let ok = true;
    produce(touching, (d) => void (ok = extendCue(d, a, "end", 0)));
    expect(ok).toBe(false);
    const locked = produce(p, (d) => {
      d.tracks[0].lock = true;
    });
    produce(locked, (d) => void (ok = extendCue(d, a, "end", 0)));
    expect(ok).toBe(false);
  });
});

describe("合拢空隙", () => {
  it("按轨道把后面的片段依次前移，第一个不动、长度不变；锁定轨道跳过", () => {
    const { p, a, b, c, d } = sample();
    let n = 0;
    const one = produce(p, (draft) => void (n = closeGaps(draft, [p.tracks[0].id])));
    expect(n).toBe(1);
    expect(span(one, a)).toEqual([2000, 4000]);
    expect(span(one, b)).toEqual([4000, 5000]);
    expect(span(one, d)).toEqual([5000, 6000]);

    const all = produce(p, (draft) => void (n = closeGaps(draft, null)));
    expect(n).toBe(2);
    expect(span(all, c)).toEqual([1000, 2000]);
    expect(span(all, d)).toEqual([2000, 3000]);

    const locked = produce(p, (draft) => {
      draft.tracks[1].lock = true;
    });
    produce(locked, (draft) => void (n = closeGaps(draft, null)));
    expect(n).toBe(1);
  });
});

describe("对称淡入淡出", () => {
  it("淡入淡出设成同样的时长；片段太短时各取一半", () => {
    const { p, a, b } = sample();
    const q = produce(p, (d) => void setSymmetricFades(d, [a, b], 800));
    const fades = (id: string) => {
      const c = q.cues.find((x) => x.id === id)!;
      return [c.fadeInMs, c.fadeOutMs];
    };
    expect(fades(a)).toEqual([800, 800]);
    expect(fades(b)).toEqual([500, 500]);
    expect(produce(q, (d) => void setSymmetricFades(d, [a], 0)).cues.find((x) => x.id === a)).toMatchObject({ fadeInMs: 0, fadeOutMs: 0 });
  });
});
