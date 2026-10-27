import { describe, expect, it } from "vitest";

import { extensionOf, fileNameOf, isMediaPath, kindOfPath, mediaEndMs, primaryMedia } from "../media";
import { addMedia, ensureDuration, MAX_DURATION_MS, relinkMedia, removeMedia, setMediaOffset } from "../ops";
import { createEmptyProject, type MediaRef } from "../project";
import { peakColumns } from "../waveform";

const ref = (over: Partial<MediaRef> = {}): MediaRef => ({
  id: "m1",
  kind: "audio",
  path: "D:\\music\\歌.mp3",
  name: "歌.mp3",
  durationMs: 60_000,
  offsetMs: 0,
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

  it("主素材优先取第一个音频，其次第一个视频", () => {
    const video = ref({ id: "v", kind: "video", path: "v.mp4" });
    const audio = ref({ id: "a", kind: "audio", path: "a.mp3" });
    expect(primaryMedia({ media: [] })).toBeUndefined();
    expect(primaryMedia({ media: [video] })?.id).toBe("v");
    expect(primaryMedia({ media: [video, audio] })?.id).toBe("a");
    expect(mediaEndMs(ref({ offsetMs: -500, durationMs: 2000 }))).toBe(1500);
  });
});

describe("素材编辑操作", () => {
  it("加入素材；同一路径不重复加入；新素材偏移为 0", () => {
    const p = createEmptyProject("t");
    expect(addMedia(p, ref({ offsetMs: 99 }))).toBe("m1");
    expect(p.media[0].offsetMs).toBe(0);
    expect(addMedia(p, ref({ id: "m2" }))).toBeNull();
    expect(p.media).toHaveLength(1);
  });

  it("移除素材；设置偏移会取整并夹在 ±1 小时", () => {
    const p = createEmptyProject("t");
    addMedia(p, ref());
    setMediaOffset(p, "m1", 12.6);
    expect(p.media[0].offsetMs).toBe(13);
    setMediaOffset(p, "m1", 9e9);
    expect(p.media[0].offsetMs).toBe(3_600_000);
    setMediaOffset(p, "m1", -9e9);
    expect(p.media[0].offsetMs).toBe(-3_600_000);
    setMediaOffset(p, "ghost", 1);
    removeMedia(p, "m1");
    expect(p.media).toHaveLength(0);
  });

  it("重新链接保留偏移；新路径已被占用或素材不存在时失败", () => {
    const p = createEmptyProject("t");
    addMedia(p, ref());
    addMedia(p, ref({ id: "m2", path: "other.mp3", name: "other.mp3" }));
    setMediaOffset(p, "m1", 250);
    const next = { path: "E:\\新位置\\歌.wav", name: "歌.wav", kind: "audio" as const, durationMs: 61_000 };
    expect(relinkMedia(p, "m1", next)).toBe(true);
    expect(p.media[0]).toMatchObject({ ...next, offsetMs: 250, id: "m1" });
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
