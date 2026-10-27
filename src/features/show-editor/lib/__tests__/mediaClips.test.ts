import { describe, expect, it } from "vitest";
import { produce } from "immer";

import {
  addMediaTrack,
  applyMediaPlacements,
  checkMediaPlacements,
  computeMediaDrag,
  mediaContentEndMs,
  mediaGainAt,
  MIN_MEDIA_CLIP_MS,
  placeMediaClip,
  removeMediaClips,
  removeMediaTrack,
  setMediaClip,
  setMediaTrack,
  splitMediaClips,
  visibleVideoClip,
} from "../mediaClips";
import { createEmptyProject, type MediaClip, type ShowProject } from "../project";

function base(): ShowProject {
  return produce(createEmptyProject("t"), (d) => {
    d.media.push(
      { id: "a", kind: "audio", path: "a.mp3", name: "a.mp3", durationMs: 10_000 },
      { id: "v", kind: "video", path: "v.mp4", name: "v.mp4", durationMs: 5_000 },
    );
  });
}

const clip = (over: Partial<MediaClip>): MediaClip => ({
  id: "c",
  trackId: "t",
  mediaId: "a",
  startMs: 0,
  inMs: 0,
  durationMs: 1000,
  volume: 1,
  fadeInMs: 0,
  fadeOutMs: 0,
  ...over,
});

describe("媒体轨道与片段", () => {
  it("放置素材：有空位的同类轨道优先，重叠或类型不同就新建轨道；首选轨道可用时用它", () => {
    let r1: ReturnType<typeof placeMediaClip> = null;
    let r2: ReturnType<typeof placeMediaClip> = null;
    let r3: ReturnType<typeof placeMediaClip> = null;
    let r4: ReturnType<typeof placeMediaClip> = null;
    const p = produce(base(), (d) => {
      r1 = placeMediaClip(d, "a", 0, "音频 1");
      r2 = placeMediaClip(d, "a", 5000, "音频 2"); // 与 r1 重叠
      r3 = placeMediaClip(d, "a", 10_000, "音频 3"); // 第一条轨道 10 s 之后空着
      r4 = placeMediaClip(d, "v", 0, "视频 1");
    });
    expect(r1).toMatchObject({ createdTrack: true });
    expect(r2).toMatchObject({ createdTrack: true });
    expect(r3).toMatchObject({ createdTrack: false, trackId: r1!.trackId });
    expect(r4).toMatchObject({ createdTrack: true });
    expect(p.mediaTracks.map((t) => [t.kind, t.name])).toEqual([
      ["audio", "音频 1"],
      ["audio", "音频 2"],
      ["video", "视频 1"],
    ]);
    expect(mediaContentEndMs(p)).toBe(20_000);
    const q = produce(p, (d) => void placeMediaClip(d, "a", 30_000, "x", r2!.trackId));
    expect(q.mediaClips.at(-1)?.trackId).toBe(r2!.trackId);
    expect(produce(p, (d) => void placeMediaClip(d, "ghost", 0, "x"))).toBe(p);
  });

  it("轨道设置（音量夹到 0~1）；删除轨道连同片段", () => {
    let id = "";
    const p = produce(base(), (d) => {
      id = addMediaTrack(d, "audio", "音频 1");
      d.mediaClips.push(clip({ trackId: id }));
      setMediaTrack(d, id, { volume: 3, mute: true, name: "鼓" });
    });
    expect(p.mediaTracks[0]).toMatchObject({ volume: 1, mute: true, name: "鼓" });
    const q = produce(p, (d) => removeMediaTrack(d, id));
    expect(q.mediaTracks).toEqual([]);
    expect(q.mediaClips).toEqual([]);
  });

  it("片段音量 / 淡入淡出夹取（淡入 + 淡出不超过长度）、静音、删除", () => {
    const p = produce(base(), (d) => {
      d.mediaClips.push(clip({ durationMs: 1000 }));
      setMediaClip(d, ["c"], { volume: -1, fadeInMs: 700, muted: true });
      setMediaClip(d, ["c"], { fadeOutMs: 900 });
    });
    expect(p.mediaClips[0]).toMatchObject({ volume: 0, fadeInMs: 700, fadeOutMs: 300, muted: true });
    const q = produce(p, (d) => setMediaClip(d, ["c"], { muted: false }));
    expect(q.mediaClips[0].muted).toBeUndefined();
    expect(produce(q, (d) => removeMediaClips(d, ["c"])).mediaClips).toEqual([]);
  });

  it("在播放头处分割：后半段的入点接着前半段，淡出留给后半段；太短不分", () => {
    let created: string[] = [];
    const p = produce(base(), (d) => {
      d.mediaClips.push(clip({ startMs: 1000, inMs: 2000, durationMs: 4000, fadeInMs: 500, fadeOutMs: 800 }));
      created = splitMediaClips(d, ["c"], 3000);
    });
    expect(created).toHaveLength(1);
    expect(p.mediaClips[0]).toMatchObject({ startMs: 1000, inMs: 2000, durationMs: 2000, fadeInMs: 500, fadeOutMs: 0 });
    expect(p.mediaClips[1]).toMatchObject({ startMs: 3000, inMs: 4000, durationMs: 2000, fadeInMs: 0, fadeOutMs: 800 });
    const q = produce(p, (d) => void splitMediaClips(d, ["c"], 1000 + MIN_MEDIA_CLIP_MS / 2));
    expect(q).toBe(p);
  });

  it("检查目标位置：重叠、超出素材、类型不符、锁定轨道都不合法", () => {
    const p = produce(base(), (d) => {
      d.mediaTracks.push(
        { id: "t", kind: "audio", name: "1", mute: false, solo: false, lock: false, volume: 1 },
        { id: "vt", kind: "video", name: "v", mute: false, solo: false, lock: false, volume: 1 },
        { id: "lk", kind: "audio", name: "锁", mute: false, solo: false, lock: true, volume: 1 },
      );
      d.mediaClips.push(clip({ id: "x", startMs: 0, durationMs: 2000 }), clip({ id: "y", startMs: 3000, durationMs: 2000 }));
    });
    const at = (over: Partial<{ trackId: string; startMs: number; inMs: number; durationMs: number }>) => [
      { id: "y", trackId: "t", startMs: 3000, inMs: 0, durationMs: 2000, ...over },
    ];
    expect(checkMediaPlacements(p, at({ startMs: 2000 }))).toBe(true);
    expect(checkMediaPlacements(p, at({ startMs: 1500 }))).toBe(false);
    expect(checkMediaPlacements(p, at({ inMs: 9000 }))).toBe(false);
    expect(checkMediaPlacements(p, at({ trackId: "vt" }))).toBe(false);
    expect(checkMediaPlacements(p, at({ trackId: "lk" }))).toBe(false);
    expect(checkMediaPlacements(p, at({ durationMs: 50 }))).toBe(false);
    const q = produce(p, (d) => applyMediaPlacements(d, at({ startMs: 2000 })));
    expect(q.mediaClips[1].startMs).toBe(2000);
  });

  it("拖动：移动吸附到目标、换到同类轨道、裁剪入点（起点与入点一起动，不早于素材开头）、裁剪出点（不超出素材）", () => {
    const p = produce(base(), (d) => {
      d.mediaTracks.push(
        { id: "t", kind: "audio", name: "1", mute: false, solo: false, lock: false, volume: 1 },
        { id: "vt", kind: "video", name: "v", mute: false, solo: false, lock: false, volume: 1 },
        { id: "t2", kind: "audio", name: "2", mute: false, solo: false, lock: false, volume: 1 },
      );
      d.mediaClips.push(clip({ id: "x", startMs: 2000, inMs: 1000, durationMs: 3000 }));
    });
    const drag = (kind: "move" | "trimStart" | "trimEnd", deltaMs: number, rowDelta = 0, targets: number[] | null = null) =>
      computeMediaDrag(p, { kind, ids: ["x"], deltaMs, rowDelta, snapTargets: targets, thresholdMs: 100 });

    const moved = drag("move", 960, 0, [3000]);
    expect(moved.placements[0]).toMatchObject({ startMs: 3000, inMs: 1000, durationMs: 3000 });
    expect(moved.guideMs).toBe(3000);
    // 隔一条视频轨道跳到第二条音频轨道不行（中间那条类型不符）；跳两行可以
    expect(drag("move", 0, 1).placements[0].trackId).toBe("t");
    expect(drag("move", 0, 2).placements[0].trackId).toBe("t2");
    // 移动不早于 0
    expect(drag("move", -9000).placements[0].startMs).toBe(0);

    const trimIn = drag("trimStart", -5000);
    expect(trimIn.placements[0]).toMatchObject({ startMs: 1000, inMs: 0, durationMs: 4000 });
    const trimInRight = drag("trimStart", 1000);
    expect(trimInRight.placements[0]).toMatchObject({ startMs: 3000, inMs: 2000, durationMs: 2000 });
    const trimOut = drag("trimEnd", 99_000);
    expect(trimOut.placements[0]).toMatchObject({ startMs: 2000, inMs: 1000, durationMs: 9000 });
    expect(trimOut.valid).toBe(true);
    expect(drag("trimEnd", -99_000).placements[0].durationMs).toBeGreaterThanOrEqual(MIN_MEDIA_CLIP_MS);
  });

  it("增益：片段音量 × 轨道音量 × 淡入淡出；静音、独奏、片段外为 0", () => {
    const track = { id: "t", kind: "audio" as const, name: "1", mute: false, solo: false, lock: false, volume: 0.5 };
    const c = clip({ startMs: 1000, durationMs: 4000, volume: 0.8, fadeInMs: 1000, fadeOutMs: 2000 });
    expect(mediaGainAt(c, track, 500, false)).toBe(0);
    expect(mediaGainAt(c, track, 1500, false)).toBeCloseTo(0.2);
    expect(mediaGainAt(c, track, 2500, false)).toBeCloseTo(0.4);
    expect(mediaGainAt(c, track, 4000, false)).toBeCloseTo(0.2);
    expect(mediaGainAt(c, track, 5000, false)).toBe(0);
    expect(mediaGainAt(c, track, 2500, true)).toBe(0);
    expect(mediaGainAt(c, { ...track, solo: true }, 2500, true)).toBeCloseTo(0.4);
    expect(mediaGainAt({ ...c, muted: true }, track, 2500, false)).toBe(0);
    expect(mediaGainAt(c, { ...track, mute: true }, 2500, false)).toBe(0);
  });

  it("可见视频：从上到下第一条在此刻有片段的视频轨道", () => {
    const p = produce(base(), (d) => {
      d.mediaTracks.push(
        { id: "a1", kind: "audio", name: "a", mute: false, solo: false, lock: false, volume: 1 },
        { id: "v1", kind: "video", name: "上", mute: false, solo: false, lock: false, volume: 1 },
        { id: "v2", kind: "video", name: "下", mute: false, solo: false, lock: false, volume: 1 },
      );
      d.mediaClips.push(
        clip({ id: "top", trackId: "v1", mediaId: "v", startMs: 2000, durationMs: 1000 }),
        clip({ id: "bottom", trackId: "v2", mediaId: "v", startMs: 0, durationMs: 5000 }),
      );
    });
    expect(visibleVideoClip(p, 1000)).toBe("bottom");
    expect(visibleVideoClip(p, 2500)).toBe("top");
    expect(visibleVideoClip(p, 6000)).toBeNull();
  });
});
