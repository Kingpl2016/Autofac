import { describe, expect, it } from "vitest";

import { extensionOf, fileNameOf, isMediaPath, kindOfPath, primaryMedia } from "../media";
import { addMedia, ensureDuration, MAX_DURATION_MS, relinkMedia, removeMedia } from "../ops";
import { createEmptyProject, type MediaRef } from "../project";
import { peakColumns } from "../waveform";

const ref = (over: Partial<MediaRef> = {}): MediaRef => ({
  id: "m1",
  kind: "audio",
  path: "D:\\music\\歌.mp3",
  name: "歌.mp3",
  durationMs: 60_000,
  ...over,
});

describe("路径工具", () => {
  it("文件名与扩展名同时支持两种分隔符", () => {
    expect(fileNameOf("D:\\a\\b\\歌.MP3")).toBe("歌.MP3");
    expect(fileNameOf("/home/u/clip.mp4")).toBe("clip.mp4");
    expect(extensionOf("D:\\a\\歌.MP3")).toBe("mp3");
    expect(extensionOf("noext")).toBe("");
    expect(extensionOf("dir.v2/file")).toBe("");
  });

  it("按扩展名判断是否可导入与素材类型", () => {
    expect(isMediaPath("a.wav")).toBe(true);
    expect(isMediaPath("a.MKV")).toBe(true);
    expect(isMediaPath("a.txt")).toBe(false);
    expect(isMediaPath("a.artshow")).toBe(false);
    expect(kindOfPath("a.mp4")).toBe("video");
    expect(kindOfPath("a.flac")).toBe("audio");
  });

  it("主素材优先取时间线上最早的音频片段，其次第一个音频，再次第一个视频", () => {
    const video = ref({ id: "v", kind: "video", path: "v.mp4" });
    const audio = ref({ id: "a", kind: "audio", path: "a.mp3" });
    const late = ref({ id: "b", kind: "audio", path: "b.mp3" });
    const clip = (id: string, mediaId: string, startMs: number) => ({
      id, trackId: "t", mediaId, startMs, inMs: 0, durationMs: 1000, volume: 1, fadeInMs: 0, fadeOutMs: 0,
    });
    expect(primaryMedia({ media: [], mediaClips: [] })).toBeUndefined();
    expect(primaryMedia({ media: [video], mediaClips: [] })?.id).toBe("v");
    expect(primaryMedia({ media: [video, audio], mediaClips: [] })?.id).toBe("a");
    expect(primaryMedia({ media: [video, audio, late], mediaClips: [clip("1", "a", 5000), clip("2", "b", 0)] })?.id).toBe("b");
  });
});

describe("素材编辑操作", () => {
  it("加入素材库；同一路径不重复加入；多余字段不写入", () => {
    const p = createEmptyProject("t");
    expect(addMedia(p, { ...ref(), extra: 1 } as MediaRef)).toBe("m1");
    expect(p.media[0]).toEqual(ref());
    expect(addMedia(p, ref({ id: "m2" }))).toBeNull();
    expect(p.media).toHaveLength(1);
  });

  it("移除素材同时移除用到它的片段", () => {
    const p = createEmptyProject("t");
    addMedia(p, ref());
    p.mediaTracks.push({ id: "t", kind: "audio", name: "音频 1", mute: false, solo: false, lock: false, volume: 1 });
    p.mediaClips.push({ id: "c", trackId: "t", mediaId: "m1", startMs: 0, inMs: 0, durationMs: 1000, volume: 1, fadeInMs: 0, fadeOutMs: 0 });
    removeMedia(p, "m1");
    expect(p.media).toHaveLength(0);
    expect(p.mediaClips).toHaveLength(0);
    expect(p.mediaTracks).toHaveLength(1);
  });

  it("重新链接：片段保留位置，新文件更短时裁短（太短的删除）；新路径已被占用或素材不存在时失败", () => {
    const p = createEmptyProject("t");
    addMedia(p, ref());
    addMedia(p, ref({ id: "m2", path: "other.mp3", name: "other.mp3" }));
    p.mediaTracks.push({ id: "t", kind: "audio", name: "音频 1", mute: false, solo: false, lock: false, volume: 1 });
    p.mediaClips.push(
      { id: "a", trackId: "t", mediaId: "m1", startMs: 250, inMs: 0, durationMs: 60_000, volume: 1, fadeInMs: 0, fadeOutMs: 5000 },
      { id: "b", trackId: "t", mediaId: "m1", startMs: 70_000, inMs: 39_950, durationMs: 5000, volume: 1, fadeInMs: 0, fadeOutMs: 0 },
    );
    const next = { path: "E:\\新位置\\歌.wav", name: "歌.wav", kind: "audio" as const, durationMs: 40_000 };
    expect(relinkMedia(p, "m1", next)).toBe(true);
    expect(p.media[0]).toMatchObject({ ...next, id: "m1" });
    expect(p.mediaClips.map((c) => c.id)).toEqual(["a"]);
    expect(p.mediaClips[0]).toMatchObject({ startMs: 250, durationMs: 40_000, fadeOutMs: 5000 });
    expect(relinkMedia(p, "m1", { ...next, path: "other.mp3" })).toBe(false);
    expect(relinkMedia(p, "ghost", next)).toBe(false);
  });

  it("按需延长节目时长：至少覆盖到该时刻，不超过 24 小时", () => {
    const p = createEmptyProject("t");
    expect(ensureDuration(p, 1000)).toBe(false);
    expect(p.durationMs).toBe(180_000);
    expect(ensureDuration(p, 200_009.4)).toBe(true);
    expect(p.durationMs).toBe(200_010);
    expect(ensureDuration(p, 9e12)).toBe(true);
    expect(p.durationMs).toBe(MAX_DURATION_MS);
  });
});

describe("peakColumns", () => {
  // 每秒 10 个桶（每桶 100 ms）：桶 i 的范围是 [-(i+1), i+1]
  const peaks = { perSecond: 10, peaks: Array.from({ length: 10 }, (_, i) => [-(i + 1), i + 1]).flat() };

  it("每列取覆盖范围内所有桶的最小 / 最大", () => {
    // 每列 300 ms：覆盖桶 0~2、3~5
    const cols = peakColumns(peaks, 0, 300, 2);
    expect(cols).toEqual([
      { min: -3, max: 3 },
      { min: -6, max: 6 },
    ]);
  });

  it("放大时多列共用一个桶", () => {
    const cols = peakColumns(peaks, 0, 25, 8);
    expect(cols.slice(0, 4).every((c) => c?.max === 1)).toBe(true);
    expect(cols[4]?.max).toBe(2);
  });

  it("素材之外的列为 null：开头之前和结尾之后", () => {
    const before = peakColumns(peaks, -200, 100, 3);
    expect(before[0]).toBeNull();
    expect(before[1]).toBeNull();
    expect(before[2]).toEqual({ min: -1, max: 1 });
    const after = peakColumns(peaks, 900, 100, 3);
    expect(after[0]).toEqual({ min: -10, max: 10 });
    expect(after[1]).toBeNull();
  });

  it("没有数据时全是 null", () => {
    expect(peakColumns({ perSecond: 10, peaks: [] }, 0, 100, 2)).toEqual([null, null]);
  });
});
