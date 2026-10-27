import { beforeAll, describe, expect, it } from "vitest";
import { produce } from "immer";

import { loadTestEngine } from "../../engine/__tests__/testEngine";
import { createPreviewEvaluator } from "../color";
import { addFixtures } from "../ops";
import {
  buildPixelEntries,
  insertPixelScene,
  mapPoints,
  sampleColor,
  samplePixelFrames,
  simplifyKeys,
  splitBrightness,
  type FrameImage,
  type FrameSource,
  type PixelFrame,
} from "../pixelMap";
import { createEmptyProject, type Rgb } from "../project";
import { parseProject } from "../schema";
import { RGBW } from "./testkit";

let engine: ReturnType<typeof loadTestEngine>;
beforeAll(() => {
  engine = loadTestEngine();
});

/** 4×2 的画面：左半红、右半蓝；第二行亮度一半。 */
function image(fill: (x: number, y: number) => Rgb, width = 4, height = 2): FrameImage {
  const data: number[] = [];
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) data.push(...fill(x, y), 255);
  return { width, height, data };
}

const opts = { fps: 10, followBrightness: true, tolerance: 6 };

describe("像素映射", () => {
  it("取样点：舞台左右 → 画面左右，舞台后方 → 画面上方；可翻转", () => {
    const fixtures = [
      { id: "l", stage: { x: -6, y: 8 } },
      { id: "r", stage: { x: 6, y: 0 } },
      { id: "c", stage: { x: 0, y: 4 } },
    ];
    const pts = mapPoints(fixtures, { width: 12, depth: 8 });
    expect(pts.get("l")).toEqual({ u: 0, v: 0 });
    expect(pts.get("r")).toEqual({ u: 1, v: 1 });
    expect(pts.get("c")).toEqual({ u: 0.5, v: 0.5 });
    expect(mapPoints(fixtures, { width: 12, depth: 8 }, { flipX: true, flipY: true }).get("l")).toEqual({ u: 1, v: 1 });
  });

  it("取色：方块平均；拆成颜色 + 亮度", () => {
    const img = image((x, y) => (x < 2 ? [200, 0, 0] : [0, 0, y === 0 ? 255 : 100]));
    expect(sampleColor(img, { u: 0, v: 0 }, 0)).toEqual([200, 0, 0]);
    expect(sampleColor(img, { u: 1, v: 0 }, 1)).toEqual([0, 0, 178]);
    expect(splitBrightness([100, 50, 0])).toEqual({ intensity: 39.2, rgb: [255, 127, 0] });
    expect(splitBrightness([0, 0, 0])).toEqual({ intensity: 0, rgb: [0, 0, 0] });
  });

  it("关键帧简化：线性段只留端点，拐点保留", () => {
    const keys = [0, 1, 2, 3, 4, 5, 6].map((i) => ({ tMs: i * 100, value: i <= 3 ? i * 10 : 30 }));
    const out = simplifyKeys(keys, 0.5, (a, b, f) => a + (b - a) * f, (a, b) => Math.abs(a - b));
    expect(out.map((k) => k.tMs)).toEqual([0, 300, 600]);
  });

  it("逐帧取样（素材时刻 = 入点 + 帧时刻），可取消", async () => {
    const asked: number[] = [];
    const source: FrameSource = {
      grab: async (ms) => {
        asked.push(ms);
        return image(() => [ms >= 1200 ? 255 : 0, 0, 0]);
      },
    };
    const progress: number[] = [];
    const frames = await samplePixelFrames(source, { inMs: 1000, durationMs: 400 }, new Map([["f", { u: 0, v: 0 }]]), 10, (d) => progress.push(d));
    expect(asked).toEqual([1000, 1100, 1200, 1300, 1400]);
    expect(frames.map((f) => f.tMs)).toEqual([0, 100, 200, 300, 400]);
    expect(frames[2].colors.get("f")).toEqual([255, 0, 0]);
    expect(progress).toEqual([1, 2, 3, 4, 5]);
    const ac = new AbortController();
    ac.abort();
    await expect(samplePixelFrames(source, { inMs: 0, durationMs: 400 }, new Map(), 10, undefined, ac.signal)).rejects.toThrow("cancelled");
  });

  it("场景条目：颜色 / 亮度关键帧；不变时用固定值；黑场里沿用前一个颜色", () => {
    const frames: PixelFrame[] = [0, 100, 200, 300].map((tMs) => ({
      tMs,
      colors: new Map<string, Rgb>([
        ["a", tMs < 200 ? [255, 0, 0] : [0, 0, 0]],
        ["b", [0, 128, 0]],
      ]),
    }));
    const [a, b] = buildPixelEntries(frames, ["a", "b"], opts);
    expect(a.look.intensity).toEqual({
      kind: "keys",
      keys: [
        { tMs: 0, value: 100, curve: "linear" },
        { tMs: 100, value: 100, curve: "linear" },
        { tMs: 200, value: 0, curve: "linear" },
        { tMs: 300, value: 0, curve: "linear" },
      ],
    });
    expect(a.look.color).toEqual({ kind: "value", value: { kind: "rgb", rgb: [255, 0, 0] } });
    expect(b.look).toEqual({ intensity: { kind: "value", value: 50.2 }, color: { kind: "value", value: { kind: "rgb", rgb: [0, 255, 0] } } });
    // 不跟随亮度：强度 100，颜色原样
    const [plain] = buildPixelEntries(frames, ["b"], { ...opts, followBrightness: false });
    expect(plain.look).toEqual({ intensity: { kind: "value", value: 100 }, color: { kind: "value", value: { kind: "rgb", rgb: [0, 128, 0] } } });
  });

  it("放进空闲的场景轨道（没有就新建）；生成的工程合法，引擎按关键帧插值出颜色", () => {
    let id: string | null = null;
    const p = produce(createEmptyProject("t"), (d) => {
      addFixtures(d, RGBW, 2);
      d.durationMs = 10_000;
      d.output.gamma = 1;
      d.fixtures[0].stage = { x: -6, y: 4 };
      d.fixtures[1].stage = { x: 6, y: 4 };
    });
    const frames: PixelFrame[] = [0, 1000].map((tMs) => ({
      tMs,
      colors: new Map<string, Rgb>([
        [p.fixtures[0].id, tMs === 0 ? [255, 0, 0] : [0, 0, 255]],
        [p.fixtures[1].id, [0, 255, 0]],
      ]),
    }));
    const entries = buildPixelEntries(frames, p.fixtures.map((f) => f.id), opts);
    const q = produce(p, (d) => {
      id = insertPixelScene(d, entries, 2000, 3000, "像素映射", "像素映射 · v.mp4");
    });
    expect(id).not.toBeNull();
    expect(q.tracks.at(-1)).toMatchObject({ target: { kind: "scene" }, name: "像素映射" });
    expect(q.cues.at(-1)).toMatchObject({ kind: "scene", startMs: 2000, endMs: 3000, label: "像素映射 · v.mp4" });
    expect(parseProject(JSON.stringify(q)).ok).toBe(true);

    const evaluate = createPreviewEvaluator(q, engine);
    expect(evaluate(2000).get(q.fixtures[0].id)).toEqual([255, 0, 0]);
    const mid = evaluate(2500).get(q.fixtures[0].id)!;
    expect(mid[0]).toBeGreaterThan(0);
    expect(mid[2]).toBeGreaterThan(0);
    expect(evaluate(2500).get(q.fixtures[1].id)).toEqual([0, 255, 0]);
    // 同一时间段再放一次：原轨道被占，新建第二条场景轨道
    const r = produce(q, (d) => void insertPixelScene(d, entries, 2000, 3000, "像素映射", "x"));
    expect(r.tracks.filter((t) => t.target.kind === "scene")).toHaveLength(2);
    expect(produce(q, (d) => void insertPixelScene(d, [], 0, 1000, "x", "x"))).toBe(q);
  });
});
