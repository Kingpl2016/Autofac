import { describe, expect, it } from "vitest";

import type { FrameImage, FrameSource } from "../pixelMap";
import { analyzeVideo, detectShots, frameStats, MAX_VIDEO_FRAMES, parseVideoCache, sampleTimes, videoCacheText } from "../videoAnalysis";

/** 一帧纯色画面（8×4），可加一点噪声。 */
function solid(rgb: [number, number, number], noise = 0): FrameImage {
  const data = new Uint8ClampedArray(8 * 4 * 4);
  for (let i = 0; i < 32; i += 1) {
    const n = noise ? ((i * 7) % 5) - 2 : 0;
    data[i * 4] = rgb[0] + n;
    data[i * 4 + 1] = rgb[1] + n;
    data[i * 4 + 2] = rgb[2] + n;
    data[i * 4 + 3] = 255;
  }
  return { width: 8, height: 4, data };
}

/** 红 0~4 秒、蓝 4~8 秒、绿 8~12 秒的视频。 */
const source: FrameSource = {
  grab: async (ms) => solid(ms < 4000 ? [220, 30, 30] : ms < 8000 ? [30, 40, 220] : [30, 200, 60], 2),
};

describe("视频画面分析", () => {
  it("颜色突变处记为切换，每个镜头给出主色与亮度", async () => {
    const r = await analyzeVideo(source, 12_000);
    expect(r.cuts.map((c) => c.atMs)).toEqual([4000, 8000]);
    expect(r.shots).toHaveLength(3);
    const [red, blue, green] = r.shots.map((s) => s.rgb);
    expect(red[0]).toBeGreaterThan(200);
    expect(blue[2]).toBeGreaterThan(200);
    expect(green[1]).toBeGreaterThan(180);
    expect(r.shots[0].startMs).toBe(0);
    expect(r.shots.at(-1)!.endMs).toBe(12_000);
  });

  it("平稳的画面没有切换；切换之间至少隔 1 秒", () => {
    const calm = [0, 500, 1000, 1500].map((at) => frameStats(solid([100, 100, 100], 2), at));
    expect(detectShots(calm, 2000).cuts).toEqual([]);
    // 一直在闪（频闪画面）：阈值随中位数抬高，不算切换
    const flicker = [0, 500, 1000, 1500, 2000].map((at, i) => frameStats(solid(i % 2 ? [255, 0, 0] : [0, 0, 255]), at));
    expect(detectShots(flicker, 2500).cuts).toEqual([]);
    // 两次突变只隔半秒：只认第一次
    const colors: [number, number, number][] = [[200, 0, 0], [200, 0, 0], [200, 0, 0], [0, 0, 200], [0, 200, 0], [0, 200, 0], [0, 200, 0], [0, 200, 0]];
    const twice = colors.map((rgb, i) => frameStats(solid(rgb), i * 500));
    expect(detectShots(twice, 4000).cuts.map((c) => c.atMs)).toEqual([1250]);
  });

  it("取样时刻：2 帧 / 秒，太长时降低帧率", () => {
    expect(sampleTimes(2000)).toEqual([250, 750, 1250, 1750]);
    expect(sampleTimes(0)).toEqual([]);
    expect(sampleTimes(3 * 3600_000).length).toBeLessThanOrEqual(MAX_VIDEO_FRAMES);
  });

  it("可以取消", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(analyzeVideo(source, 12_000, { signal: ctrl.signal })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("缓存往返；版本不对或损坏时作废", async () => {
    const r = await analyzeVideo(source, 12_000);
    expect(parseVideoCache(videoCacheText(r))).toEqual(r);
    expect(parseVideoCache(JSON.stringify({ ...r, version: 99 }))).toBeNull();
    expect(parseVideoCache("{oops")).toBeNull();
    expect(parseVideoCache(null)).toBeNull();
  });
});
