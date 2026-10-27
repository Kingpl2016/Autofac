import { produce } from "immer";
import { describe, expect, it } from "vitest";

import {
  addStaticCue,
  copyCues,
  cuesAfter,
  cuesAt,
  cuesOfTrack,
  DEFAULT_CUE_MS,
  gapAround,
  normalizeFades,
  nudgeCues,
  pasteCues,
  removeCues,
  rippleDeleteCues,
  setCueTimes,
  splitCues,
  updateCues,
} from "../cueOps";
import { addFixtures, removeFixtures, setTrackFlag } from "../ops";
import { createEmptyProject, type Cue, type LookClip, type ShowProject } from "../project";
import { projectIntegrityIssues } from "../schema";
import { RGBW } from "./testkit";

const edit = (p: ShowProject, recipe: (d: ShowProject) => void) => produce(p, recipe);

/** 两条轨道、时长 60 秒的工程。 */
function base(): { project: ShowProject; a: string; b: string } {
  const project = produce(createEmptyProject("t"), (d) => {
    addFixtures(d, RGBW, 2);
    d.durationMs = 60_000;
  });
  return { project, a: project.tracks[0].id, b: project.tracks[1].id };
}

function withCues(
  project: ShowProject,
  trackId: string,
  spans: [number, number][],
): { project: ShowProject; ids: string[] } {
  const ids: string[] = [];
  const next = edit(project, (d) => {
    for (const [s, e] of spans) {
      const id = addStaticCue(d, trackId, s, { lengthMs: e - s });
      if (id) ids.push(id);
    }
  });
  return { project: next, ids };
}

describe("addStaticCue", () => {
  it("在空轨道上新建默认长度的 Cue，起点对齐到帧", () => {
    const { project, a } = base();
    let id: string | null = null;
    const next = edit(project, (d) => {
      id = addStaticCue(d, a, 1010);
    });
    expect(id).not.toBeNull();
    expect(next.cues[0]).toMatchObject({ kind: "static", trackId: a, startMs: 1000, endMs: 1000 + DEFAULT_CUE_MS });
    expect(next.cues[0].kind === "static" && next.cues[0].rgb).toEqual([255, 255, 255]);
    expect(projectIntegrityIssues(next)).toEqual([]);
  });

  it("长度被后一个 Cue 截短；空隙不足最短长度时不创建", () => {
    const { project, a } = base();
    const { project: p1 } = withCues(project, a, [[3000, 5000]]);
    const next = edit(p1, (d) => {
      addStaticCue(d, a, 2000);
    });
    expect(cuesOfTrack(next, a).map((c) => [c.startMs, c.endMs])).toEqual([
      [2000, 3000],
      [3000, 5000],
    ]);
    const tight = edit(p1, (d) => {
      expect(addStaticCue(d, a, 2950)).toBeNull();
    });
    expect(tight.cues).toHaveLength(1);
  });

  it("起点落在已有 Cue 里不创建；越过工程末尾会被截断", () => {
    const { project, a } = base();
    const { project: p1 } = withCues(project, a, [[1000, 3000]]);
    edit(p1, (d) => {
      expect(addStaticCue(d, a, 2000)).toBeNull();
    });
    const end = edit(project, (d) => {
      addStaticCue(d, a, 59_000);
    });
    expect(end.cues[0].endMs).toBe(60_000);
    edit(project, (d) => {
      expect(addStaticCue(d, a, 60_000)).toBeNull();
    });
  });

  it("可以指定外观，淡入淡出超出长度时自动收缩", () => {
    const { project, a } = base();
    const next = edit(project, (d) => {
      addStaticCue(d, a, 0, { lengthMs: 1000, rgb: [255, 0, 0], brightness: 50, fadeInMs: 800, fadeOutMs: 800, easing: "sCurve" });
    });
    const cue = next.cues[0];
    expect(cue).toMatchObject({ brightness: 50, easing: "sCurve" });
    expect(cue.fadeInMs + cue.fadeOutMs).toBeLessThanOrEqual(1000);
    expect(cue.fadeInMs).toBe(cue.fadeOutMs);
  });

  it("锁定的轨道和不存在的轨道不允许新建", () => {
    const { project, a } = base();
    const locked = edit(project, (d) => {
      d.tracks[0].lock = true;
    });
    edit(locked, (d) => {
      expect(addStaticCue(d, a, 0)).toBeNull();
      expect(addStaticCue(d, "ghost", 0)).toBeNull();
    });
  });
});

describe("gapAround", () => {
  it("给出时刻所在空隙的上下界，落在 Cue 内部为 null", () => {
    const { project, a, b } = base();
    const { project: p } = withCues(project, a, [[1000, 2000], [5000, 6000]]);
    expect(gapAround(p, a, 3000)).toEqual([2000, 5000]);
    expect(gapAround(p, a, 500)).toEqual([0, 1000]);
    expect(gapAround(p, a, 7000)).toEqual([6000, 60_000]);
    expect(gapAround(p, a, 1500)).toBeNull();
    expect(gapAround(p, a, 2000)).toEqual([2000, 5000]);
    expect(gapAround(p, b, 1500)).toEqual([0, 60_000]);
  });

  it("可以排除正在拖动的 Cue", () => {
    const { project, a } = base();
    const { project: p, ids } = withCues(project, a, [[1000, 2000]]);
    expect(gapAround(p, a, 1500, new Set(ids))).toEqual([0, 60_000]);
  });
});

describe("setCueTimes", () => {
  it("移动和拉伸，时间对齐到帧", () => {
    const { project, a } = base();
    const { project: p, ids } = withCues(project, a, [[1000, 3000]]);
    const moved = edit(p, (d) => {
      expect(setCueTimes(d, ids[0], 5010, 7010)).toBe(true);
    });
    expect(moved.cues[0]).toMatchObject({ startMs: 5000, endMs: 7000 });
    const stretched = edit(moved, (d) => {
      expect(setCueTimes(d, ids[0], 5000, 9000)).toBe(true);
    });
    expect(stretched.cues[0].endMs).toBe(9000);
  });

  it("与同轨其他 Cue 重叠被拒绝；不同轨道互不影响；与自己重叠没问题", () => {
    const { project, a, b } = base();
    const { project: p, ids } = withCues(project, a, [[1000, 3000], [5000, 7000]]);
    const withOther = edit(p, (d) => {
      addStaticCue(d, b, 1000, { lengthMs: 5000 });
    });
    edit(withOther, (d) => {
      expect(setCueTimes(d, ids[0], 4000, 6000)).toBe(false);
      expect(setCueTimes(d, ids[0], 1000, 3500)).toBe(true);
      // 恰好首尾相接不算重叠
      expect(setCueTimes(d, ids[0], 3000, 5000)).toBe(true);
    });
  });

  it("夹在工程范围内，太短被拒绝，缩短后淡入淡出自动收缩", () => {
    const { project, a } = base();
    const { project: p, ids } = withCues(project, a, [[1000, 3000]]);
    const withFades = edit(p, (d) => {
      d.cues[0].fadeInMs = 800;
      d.cues[0].fadeOutMs = 800;
    });
    const next = edit(withFades, (d) => {
      expect(setCueTimes(d, ids[0], -500, 1000)).toBe(true);
      expect(setCueTimes(d, ids[0], 0, 40)).toBe(false);
    });
    expect(next.cues[0]).toMatchObject({ startMs: 0, endMs: 1000 });
    expect(next.cues[0].fadeInMs + next.cues[0].fadeOutMs).toBeLessThanOrEqual(1000);
    const clamped = edit(p, (d) => {
      expect(setCueTimes(d, ids[0], 59_000, 70_000)).toBe(true);
    });
    expect(clamped.cues[0].endMs).toBe(60_000);
  });

  it("锁定轨道上的 Cue 不能改", () => {
    const { project, a } = base();
    const { project: p, ids } = withCues(project, a, [[1000, 3000]]);
    const locked = edit(p, (d) => {
      d.tracks[0].lock = true;
    });
    edit(locked, (d) => {
      expect(setCueTimes(d, ids[0], 2000, 4000)).toBe(false);
    });
  });
});

describe("removeCues", () => {
  it("删除指定 Cue，锁定轨道上的保留", () => {
    const { project, a, b } = base();
    const { project: p, ids: aIds } = withCues(project, a, [[0, 1000], [2000, 3000]]);
    const { project: q, ids: bIds } = withCues(p, b, [[0, 1000]]);
    const locked = edit(q, (d) => {
      d.tracks[1].lock = true;
    });
    let removed = 0;
    const next = edit(locked, (d) => {
      removed = removeCues(d, [aIds[0], bIds[0]]);
    });
    expect(removed).toBe(1);
    expect(next.cues.map((c) => c.id).sort()).toEqual([aIds[1], bIds[0]].sort());
  });

  it("删除灯具时其轨道上的 Cue 一起消失，工程引用仍完整", () => {
    const { project, a } = base();
    const { project: p } = withCues(project, a, [[0, 1000]]);
    const fixtureId = p.fixtures[0].id;
    const next = edit(p, (d) => removeFixtures(d, [fixtureId]));
    expect(next.cues).toEqual([]);
    expect(projectIntegrityIssues(next)).toEqual([]);
  });
});

describe("normalizeFades", () => {
  it("装得下时不动", () => {
    const cue = { startMs: 0, endMs: 1000, fadeInMs: 300, fadeOutMs: 300 } as Cue;
    normalizeFades(cue);
    expect([cue.fadeInMs, cue.fadeOutMs]).toEqual([300, 300]);
  });

  it("装不下时按比例收缩", () => {
    const cue = { startMs: 0, endMs: 1000, fadeInMs: 1500, fadeOutMs: 500 } as Cue;
    normalizeFades(cue);
    expect([cue.fadeInMs, cue.fadeOutMs]).toEqual([750, 250]);
  });
});

describe("复制 / 粘贴", () => {
  it("保持相对位置与轨道，粘贴到播放头处", () => {
    const { project, a, b } = base();
    const { project: p1, ids: ai } = withCues(project, a, [[1000, 2000], [4000, 5000]]);
    const { project: p2, ids: bi } = withCues(p1, b, [[2000, 3000]]);
    const clip = copyCues(p2, [ai[0], ai[1], bi[0]]);
    expect(clip.map((c) => [c.trackId === a ? "a" : "b", c.offsetMs, c.lengthMs])).toEqual([
      ["a", 0, 1000],
      ["b", 1000, 1000],
      ["a", 3000, 1000],
    ]);
    let created: string[] = [];
    const next = edit(p2, (d) => {
      created = pasteCues(d, clip, 10_000);
    });
    expect(created).toHaveLength(3);
    expect(cuesOfTrack(next, a).map((c) => c.startMs)).toEqual([1000, 4000, 10_000, 13_000]);
    expect(cuesOfTrack(next, b).map((c) => c.startMs)).toEqual([2000, 11_000]);
    expect(new Set(next.cues.map((c) => c.id)).size).toBe(next.cues.length);
    expect(projectIntegrityIssues(next)).toEqual([]);
  });

  it("目标位置被占用时向后挪到 Cue 的终点；放不下就跳过", () => {
    const { project, a } = base();
    const { project: p, ids } = withCues(project, a, [[0, 1000], [1500, 2500]]);
    const clip = copyCues(p, [ids[0]]);
    let created: string[] = [];
    const next = edit(p, (d) => {
      // 0 处被占用 → 挪到 1000，但 1000~2000 与 1500 开始的 Cue 冲突 → 跳过
      created = pasteCues(d, clip, 0);
    });
    expect(created).toEqual([]);
    expect(next.cues).toHaveLength(2);
    const ok = edit(p, (d) => {
      created = pasteCues(d, clip, 2000);
    });
    expect(created).toHaveLength(1);
    expect(cuesOfTrack(ok, a).at(-1)).toMatchObject({ startMs: 2500, endMs: 3500 });
  });

  it("超出工程末尾、轨道被锁定或已删除的 Cue 被跳过", () => {
    const { project, a, b } = base();
    const { project: p, ids } = withCues(project, a, [[0, 1000]]);
    const clip = copyCues(p, ids);
    edit(p, (d) => {
      expect(pasteCues(d, clip, 59_500)).toEqual([]);
    });
    const locked = edit(p, (d) => {
      d.tracks[0].lock = true;
    });
    edit(locked, (d) => {
      expect(pasteCues(d, clip, 5000)).toEqual([]);
    });
    const { project: pb, ids: bi } = withCues(project, b, [[0, 1000]]);
    const clipB = copyCues(pb, bi);
    const gone = edit(pb, (d) => removeFixtures(d, [d.fixtures[1].id]));
    edit(gone, (d) => {
      expect(pasteCues(d, clipB, 5000)).toEqual([]);
    });
  });

  it("剪贴板是深拷贝：之后改原 Cue 不影响粘贴内容", () => {
    const { project, a } = base();
    const { project: p, ids } = withCues(project, a, [[0, 1000]]);
    const clip = copyCues(p, ids);
    const changed = edit(p, (d) => {
      const cue = d.cues[0];
      if (cue.kind === "static") cue.rgb = [1, 2, 3];
    });
    const next = edit(changed, (d) => {
      pasteCues(d, clip, 5000);
    });
    const pasted = cuesOfTrack(next, a).at(-1);
    expect(pasted?.kind === "static" && pasted.rgb).toEqual([255, 255, 255]);
  });

  it("没有可复制的 Cue 时返回空", () => {
    expect(copyCues({ cues: [] }, ["x"])).toEqual([]);
  });
});

describe("updateCues", () => {
  it("批量修改亮度、颜色和缓动", () => {
    const { project, a, b } = base();
    const { project: p1, ids: ai } = withCues(project, a, [[0, 2000], [3000, 5000]]);
    const { project: p2, ids: bi } = withCues(p1, b, [[0, 2000]]);
    let touched = 0;
    const next = edit(p2, (d) => {
      touched = updateCues(d, [...ai, ...bi], { brightness: 55.4, rgb: [10, 20, 300], easing: "sCurve" });
    });
    expect(touched).toBe(3);
    for (const c of next.cues) {
      expect(c).toMatchObject({ brightness: 55, easing: "sCurve" });
      expect(c.kind === "static" && c.rgb).toEqual([10, 20, 255]);
    }
  });

  it("亮度夹在 0~100", () => {
    const { project, a } = base();
    const { project: p, ids } = withCues(project, a, [[0, 2000]]);
    expect(edit(p, (d) => { updateCues(d, ids, { brightness: 150 }); }).cues[0].brightness).toBe(100);
    expect(edit(p, (d) => { updateCues(d, ids, { brightness: -5 }); }).cues[0].brightness).toBe(0);
  });

  it("淡入淡出不会超过 Cue 长度，先改的一项优先", () => {
    const { project, a } = base();
    const { project: p, ids } = withCues(project, a, [[0, 2000]]);
    const step1 = edit(p, (d) => { updateCues(d, ids, { fadeInMs: 1500 }); });
    expect(step1.cues[0].fadeInMs).toBe(1500);
    const step2 = edit(step1, (d) => { updateCues(d, ids, { fadeOutMs: 1500 }); });
    expect(step2.cues[0]).toMatchObject({ fadeInMs: 1500, fadeOutMs: 500 });
    const step3 = edit(step2, (d) => { updateCues(d, ids, { fadeInMs: -10 }); });
    expect(step3.cues[0].fadeInMs).toBe(0);
    const huge = edit(p, (d) => { updateCues(d, ids, { fadeInMs: 99_999 }); });
    expect(huge.cues[0].fadeInMs).toBe(2000);
  });

  it("特效 Cue 不接受颜色修改；锁定轨道不受影响", () => {
    const { project, a, b } = base();
    const { project: p1, ids: ai } = withCues(project, a, [[0, 2000]]);
    const { project: p2, ids: bi } = withCues(p1, b, [[0, 2000]]);
    const prepared = edit(p2, (d) => {
      d.tracks[1].lock = true;
      const c = d.cues[0];
      d.cues[0] = {
        id: c.id, trackId: c.trackId, startMs: c.startMs, endMs: c.endMs, brightness: c.brightness,
        fadeInMs: 0, fadeOutMs: 0, easing: "linear", kind: "effect", effect: "breathe",
        colors: [[255, 0, 0]], period: { kind: "ms", ms: 1000 }, phaseSpread: 0, direction: 1, range: [0, 100], seed: 1,
      };
    });
    let touched = 0;
    const next = edit(prepared, (d) => {
      touched = updateCues(d, [...ai, ...bi], { rgb: [1, 2, 3], brightness: 40 });
    });
    expect(touched).toBe(1);
    expect(next.cues[0].kind).toBe("effect");
    expect(next.cues[0].brightness).toBe(40);
    expect(next.cues[1].brightness).toBe(100);
  });
});

describe("nudgeCues", () => {
  it("整体平移选中的 Cue", () => {
    const { project, a, b } = base();
    const { project: p1, ids: ai } = withCues(project, a, [[1000, 2000]]);
    const { project: p2, ids: bi } = withCues(p1, b, [[3000, 4000]]);
    const next = edit(p2, (d) => {
      expect(nudgeCues(d, [...ai, ...bi], 500)).toBe(true);
    });
    expect(next.cues.map((c) => [c.startMs, c.endMs])).toEqual([
      [1500, 2500],
      [3500, 4500],
    ]);
  });

  it("越界、压住别的 Cue、锁定轨道都会整体拒绝", () => {
    const { project, a } = base();
    const { project: p, ids } = withCues(project, a, [[0, 1000], [1500, 2500]]);
    edit(p, (d) => {
      expect(nudgeCues(d, [ids[0]], -33)).toBe(false);
      expect(nudgeCues(d, [ids[0]], 600)).toBe(false);
      expect(nudgeCues(d, [ids[0]], 500)).toBe(true);
      expect(nudgeCues(d, [ids[1]], 100_000)).toBe(false);
      expect(nudgeCues(d, [ids[1]], 0)).toBe(false);
      expect(nudgeCues(d, ["ghost"], 100)).toBe(false);
    });
    const locked = edit(p, (d) => { d.tracks[0].lock = true; });
    edit(locked, (d) => {
      expect(nudgeCues(d, [ids[1]], 100)).toBe(false);
    });
  });

  it("一起平移的相邻 Cue 互相不算冲突", () => {
    const { project, a } = base();
    const { project: p, ids } = withCues(project, a, [[0, 1000], [1000, 2000]]);
    const next = edit(p, (d) => {
      expect(nudgeCues(d, ids, 333)).toBe(true);
    });
    expect(next.cues.map((c) => c.startMs)).toEqual([333, 1333]);
  });
});

describe("splitCues", () => {
  it("在播放头处一分为二：左段去掉淡出，右段去掉淡入", () => {
    const { project, a } = base();
    const { project: p, ids } = withCues(project, a, [[1000, 5000]]);
    const withFades = edit(p, (d) => {
      d.cues[0].fadeInMs = 500;
      d.cues[0].fadeOutMs = 500;
    });
    let created: string[] = [];
    const next = edit(withFades, (d) => {
      created = splitCues(d, ids, 3010);
    });
    expect(created).toHaveLength(1);
    const left = next.cues.find((c) => c.id === ids[0]);
    const right = next.cues.find((c) => c.id === created[0]);
    expect(left).toMatchObject({ startMs: 1000, endMs: 3000, fadeInMs: 500, fadeOutMs: 0 });
    expect(right).toMatchObject({ startMs: 3000, endMs: 5000, fadeInMs: 0, fadeOutMs: 500, trackId: a });
    expect(projectIntegrityIssues(next)).toEqual([]);
  });

  it("太靠近端点或不包含该时刻的片段不分割", () => {
    const { project, a } = base();
    const { project: p, ids } = withCues(project, a, [[1000, 5000]]);
    let created: string[] = ["x"];
    const next = edit(p, (d) => {
      created = [...splitCues(d, ids, 1010), ...splitCues(d, ids, 8000)];
    });
    expect(created).toEqual([]);
    expect(next.cues).toHaveLength(1);
  });

  it("锁定轨道上的片段不分割", () => {
    const { project, a } = base();
    const { project: p, ids } = withCues(project, a, [[1000, 5000]]);
    const locked = edit(p, (d) => setTrackFlag(d, a, "lock", true));
    const next = edit(locked, (d) => void splitCues(d, ids, 3000));
    expect(next.cues).toHaveLength(1);
  });

  it("外观片段右半段的关键帧按新起点重新计时", () => {
    const { project, a } = base();
    const look: LookClip = {
      id: "look1",
      kind: "look",
      trackId: a,
      startMs: 0,
      endMs: 4000,
      brightness: 100,
      fadeInMs: 0,
      fadeOutMs: 0,
      easing: "linear",
      look: {
        intensity: {
          kind: "keys",
          keys: [
            { tMs: 0, value: 0, curve: "linear" },
            { tMs: 4000, value: 100, curve: "linear" },
          ],
        },
      },
    };
    const p = edit(project, (d) => void d.cues.push(look));
    let created: string[] = [];
    const next = edit(p, (d) => {
      created = splitCues(d, ["look1"], 1000);
    });
    const right = next.cues.find((c) => c.id === created[0]);
    expect(right?.kind === "look" && right.look.intensity?.kind === "keys" && right.look.intensity.keys.map((k) => k.tMs)).toEqual([
      0, 3000,
    ]);
  });
});

describe("rippleDeleteCues", () => {
  it("删除后同轨道后面的片段前移补位，其它轨道不动", () => {
    const { project, a, b } = base();
    const first = withCues(project, a, [
      [0, 2000],
      [2000, 4000],
      [5000, 6000],
    ]);
    const second = withCues(first.project, b, [[3000, 4000]]);
    let removed = 0;
    const next = edit(second.project, (d) => {
      removed = rippleDeleteCues(d, [first.ids[0]]);
    });
    expect(removed).toBe(1);
    expect(cuesOfTrack(next, a).map((c) => [c.startMs, c.endMs])).toEqual([
      [0, 2000],
      [3000, 4000],
    ]);
    expect(cuesOfTrack(next, b).map((c) => [c.startMs, c.endMs])).toEqual([[3000, 4000]]);
  });

  it("同一轨道删多段时按各自长度累计前移", () => {
    const { project, a } = base();
    const { project: p, ids } = withCues(project, a, [
      [0, 1000],
      [1000, 3000],
      [3000, 4000],
    ]);
    const next = edit(p, (d) => void rippleDeleteCues(d, [ids[0], ids[1]]));
    expect(cuesOfTrack(next, a).map((c) => [c.startMs, c.endMs])).toEqual([[0, 1000]]);
  });
});

describe("cuesAt / cuesAfter", () => {
  it("按播放头和轨道筛选", () => {
    const { project, a, b } = base();
    const first = withCues(project, a, [
      [0, 2000],
      [3000, 4000],
    ]);
    const second = withCues(first.project, b, [[1000, 5000]]);
    expect(cuesAt(second.project, 1500, null).sort()).toEqual([first.ids[0], second.ids[0]].sort());
    expect(cuesAt(second.project, 1500, a)).toEqual([first.ids[0]]);
    expect(cuesAfter(second.project, 1000, null).sort()).toEqual([first.ids[1], second.ids[0]].sort());
    expect(cuesAfter(second.project, 1000, a)).toEqual([first.ids[1]]);
  });
});
