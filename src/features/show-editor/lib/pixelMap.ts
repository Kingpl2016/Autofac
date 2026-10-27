import { placeFixtures } from "../stage/stageGeometry";
import { gapAround, MIN_CUE_MS } from "./cueOps";
import { newId } from "./ids";
import type { ColorValue, FixtureInstance, Keyframe, Param, Rgb, SceneClip, SceneEntry, ShowProject, StageLayout } from "./project";
import { clamp, snapToFrame } from "./time";

/**
 * 像素映射（视频 → 灯具）：按每台灯在舞台上的位置，从视频画面对应的点取色，
 * 逐帧烘焙成一个场景片段（每台灯一条颜色关键帧，可选亮度跟随画面）。
 *
 * 取帧经 [`FrameSource`] 接口（策略），界面里用 `<video>` + 画布实现，测试里用假的帧源。
 * 关键帧经过简化：能由相邻两帧线性插值得到（误差在容差内）的中间帧被去掉，工程不会因长视频膨胀。
 *
 * 映射关系（俯视）：画面左右对应舞台左右（x），画面上方对应舞台后方（y 大）。
 */

/** 一帧画面（RGBA，逐行）。 */
export interface FrameImage {
  width: number;
  height: number;
  data: ArrayLike<number>;
}

/** 帧源：给出素材内某一时刻的画面。 */
export interface FrameSource {
  /**
   * 取一帧。
   *
   * @param sourceMs 素材内时刻（毫秒）。
   * @returns 画面。
   */
  grab(sourceMs: number): Promise<FrameImage>;
}

/** 像素映射选项。 */
export interface PixelMapOptions {
  /** 取样帧率（帧 / 秒） */
  fps: number;
  /** 亮度跟随画面（否则恒为 100%，颜色保持画面原样） */
  followBrightness: boolean;
  /** 关键帧简化的容差（0~255 的颜色差 / 0~100 的亮度差） */
  tolerance: number;
  flipX?: boolean;
  flipY?: boolean;
}

/** 默认选项：15 帧 / 秒、亮度跟随画面、容差 6。 */
export const DEFAULT_PIXEL_MAP: PixelMapOptions = { fps: 15, followBrightness: true, tolerance: 6 };

/** 可选的取样帧率。 */
export const PIXEL_MAP_FPS = [10, 15, 30] as const;

/** 画面上的取样点（0~1）。 */
export interface MapPoint {
  u: number;
  v: number;
}

/**
 * 每台灯具在画面上的取样点。
 *
 * @param fixtures 灯具（没摆放的按舞台监视器的自动排布）。
 * @param stage 舞台尺寸。
 * @param flip 左右 / 上下翻转。
 * @returns 灯具 id → 取样点。
 */
export function mapPoints(
  fixtures: readonly Pick<FixtureInstance, "id" | "stage">[],
  stage: Pick<StageLayout, "width" | "depth">,
  flip: { flipX?: boolean; flipY?: boolean } = {},
): Map<string, MapPoint> {
  const placed = placeFixtures(fixtures, stage);
  const out = new Map<string, MapPoint>();
  for (const f of fixtures) {
    const p = placed.get(f.id) ?? { x: 0, y: 0 };
    let u = clamp(p.x / Math.max(0.1, stage.width) + 0.5, 0, 1);
    let v = clamp(1 - p.y / Math.max(0.1, stage.depth), 0, 1);
    if (flip.flipX) u = 1 - u;
    if (flip.flipY) v = 1 - v;
    out.set(f.id, { u, v });
  }
  return out;
}

/**
 * 在画面上取色：以取样点为中心、`radius` 像素半径的方块求平均。
 *
 * @param img 画面。
 * @param point 取样点。
 * @param radius 半径（像素）。
 * @returns sRGB 颜色。
 */
export function sampleColor(img: FrameImage, point: MapPoint, radius = 1): Rgb {
  if (img.width <= 0 || img.height <= 0) return [0, 0, 0];
  const cx = Math.round(point.u * (img.width - 1));
  const cy = Math.round(point.v * (img.height - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = Math.max(0, cy - radius); y <= Math.min(img.height - 1, cy + radius); y += 1) {
    for (let x = Math.max(0, cx - radius); x <= Math.min(img.width - 1, cx + radius); x += 1) {
      const i = (y * img.width + x) * 4;
      r += img.data[i];
      g += img.data[i + 1];
      b += img.data[i + 2];
      n += 1;
    }
  }
  return n === 0 ? [0, 0, 0] : [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

/**
 * 把画面颜色拆成“色彩 + 亮度”：亮度取最大通道，颜色放大到最大通道为 255（黑色时颜色为黑、亮度 0）。
 *
 * @param rgb 画面颜色。
 * @returns 亮度（0~100）与满亮度的颜色。
 */
export function splitBrightness(rgb: Rgb): { intensity: number; rgb: Rgb } {
  const max = Math.max(...rgb);
  if (max <= 0) return { intensity: 0, rgb: [0, 0, 0] };
  const k = 255 / max;
  return {
    intensity: Math.round((max / 255) * 1000) / 10,
    rgb: [Math.round(rgb[0] * k), Math.round(rgb[1] * k), Math.round(rgb[2] * k)],
  };
}

/** 一个时刻的取样结果（时刻相对片段起点）。 */
export interface PixelFrame {
  tMs: number;
  colors: Map<string, Rgb>;
}

/**
 * 简化关键帧：去掉能由“上一个保留帧”与“下一帧”线性插值得到（误差 ≤ 容差）的帧；首尾保留。
 *
 * @param keys 按时间升序的值。
 * @param tolerance 容差。
 * @param lerp 插值。
 * @param distance 误差。
 * @returns 保留下来的帧。
 */
export function simplifyKeys<T>(
  keys: readonly { tMs: number; value: T }[],
  tolerance: number,
  lerp: (a: T, b: T, f: number) => T,
  distance: (a: T, b: T) => number,
): { tMs: number; value: T }[] {
  if (keys.length <= 2) return [...keys];
  const out = [keys[0]];
  for (let i = 1; i < keys.length - 1; i += 1) {
    const prev = out[out.length - 1];
    const next = keys[i + 1];
    const f = (keys[i].tMs - prev.tMs) / Math.max(1, next.tMs - prev.tMs);
    if (distance(lerp(prev.value, next.value, f), keys[i].value) > tolerance) out.push(keys[i]);
  }
  out.push(keys[keys.length - 1]);
  return out;
}

const lerpRgb = (a: Rgb, b: Rgb, f: number): Rgb => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
const rgbDistance = (a: Rgb, b: Rgb) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));

/** 关键帧序列 → 参数（只有一个不同的值时用固定值）。 */
function toParam<T>(keys: { tMs: number; value: T }[], same: (a: T, b: T) => boolean): Param<T> {
  if (keys.length === 0 || keys.every((k) => same(k.value, keys[0].value))) {
    return { kind: "value", value: keys[0]?.value } as Param<T>;
  }
  return { kind: "keys", keys: keys.map((k): Keyframe<T> => ({ tMs: k.tMs, value: k.value, curve: "linear" })) } as Param<T>;
}

/**
 * 把逐帧取样变成场景条目：每台灯一条颜色关键帧（亮度跟随画面时再加一条强度关键帧），经过简化。
 *
 * @param frames 逐帧取样（时间相对片段起点，升序）。
 * @param fixtureIds 参与的灯具（顺序即条目顺序）。
 * @param options 选项。
 * @returns 场景条目。
 */
export function buildPixelEntries(frames: readonly PixelFrame[], fixtureIds: readonly string[], options: PixelMapOptions): SceneEntry[] {
  return fixtureIds.map((fixtureId) => {
    const raw = frames.map((f) => ({ tMs: Math.round(f.tMs), rgb: f.colors.get(fixtureId) ?? ([0, 0, 0] as Rgb) }));
    if (!options.followBrightness) {
      const colors = simplifyKeys(raw.map((k) => ({ tMs: k.tMs, value: k.rgb })), options.tolerance, lerpRgb, rgbDistance);
      const rounded = colors.map((k) => ({ tMs: k.tMs, value: k.value.map(Math.round) as Rgb }));
      return {
        fixtureId,
        look: {
          intensity: { kind: "value", value: 100 },
          color: rgbParam(rounded),
        },
      };
    }
    const split = raw.map((k) => ({ tMs: k.tMs, ...splitBrightness(k.rgb) }));
    const levels = simplifyKeys(
      split.map((k) => ({ tMs: k.tMs, value: k.intensity })),
      (options.tolerance / 255) * 100,
      (a, b, f) => a + (b - a) * f,
      (a, b) => Math.abs(a - b),
    );
    // 全黑的帧颜色无意义：沿用前一个有颜色的帧，避免颜色在黑场里乱跳
    let last: Rgb = split.find((k) => k.intensity > 0)?.rgb ?? [0, 0, 0];
    const hues = split.map((k) => {
      if (k.intensity > 0) last = k.rgb;
      return { tMs: k.tMs, value: last };
    });
    const colors = simplifyKeys(hues, options.tolerance, lerpRgb, rgbDistance);
    return {
      fixtureId,
      look: {
        intensity: toParam(levels, (a, b) => a === b),
        color: rgbParam(colors.map((k) => ({ tMs: k.tMs, value: k.value.map(Math.round) as Rgb }))),
      },
    };
  });
}

function rgbParam(keys: { tMs: number; value: Rgb }[]): Param<ColorValue> {
  return toParam<ColorValue>(
    keys.map((k) => ({ tMs: k.tMs, value: { kind: "rgb", rgb: k.value } })),
    (a, b) => a.kind === "rgb" && b.kind === "rgb" && a.rgb.every((v, i) => v === b.rgb[i]),
  );
}

/** 烘焙进度回调：已完成的帧数与总帧数。 */
export type BakeProgress = (done: number, total: number) => void;

/**
 * 逐帧取样一段视频。
 *
 * @param source 帧源。
 * @param range 素材内的范围（入点与长度，毫秒）。
 * @param points 灯具 id → 取样点。
 * @param fps 取样帧率。
 * @param onProgress 进度回调。
 * @param signal 取消信号（中途取消时抛出 `AbortError`）。
 * @returns 逐帧取样（时间相对范围起点）。
 */
export async function samplePixelFrames(
  source: FrameSource,
  range: { inMs: number; durationMs: number },
  points: ReadonlyMap<string, MapPoint>,
  fps: number,
  onProgress?: BakeProgress,
  signal?: AbortSignal,
): Promise<PixelFrame[]> {
  const step = 1000 / clamp(fps, 1, 60);
  const total = Math.max(1, Math.floor(range.durationMs / step) + 1);
  const frames: PixelFrame[] = [];
  for (let i = 0; i < total; i += 1) {
    if (signal?.aborted) throw new DOMException("cancelled", "AbortError");
    const tMs = Math.min(range.durationMs, i * step);
    const img = await source.grab(range.inMs + tMs);
    const colors = new Map<string, Rgb>();
    for (const [id, p] of points) colors.set(id, sampleColor(img, p));
    frames.push({ tMs, colors });
    onProgress?.(i + 1, total);
  }
  return frames;
}

/**
 * 把烘焙好的场景条目放到时间线上：找一条在 `[startMs, endMs)` 空闲的场景轨道，没有就新建。
 *
 * @param d 工程草稿。
 * @param entries 场景条目。
 * @param startMs 起点。
 * @param endMs 终点。
 * @param trackName 新建场景轨道的名字。
 * @param label 片段标签。
 * @returns 新片段 id；条目为空或太短时为 `null`。
 */
export function insertPixelScene(
  d: ShowProject,
  entries: SceneEntry[],
  startMs: number,
  endMs: number,
  trackName: string,
  label: string,
): string | null {
  const start = clamp(snapToFrame(startMs), 0, d.durationMs);
  const end = clamp(snapToFrame(endMs), 0, d.durationMs);
  if (entries.length === 0 || end - start < MIN_CUE_MS) return null;
  const fits = (trackId: string) => {
    const gap = gapAround(d, trackId, start);
    return gap !== null && gap[1] >= end;
  };
  let track = d.tracks.find((t) => t.target.kind === "scene" && !t.lock && !t.onTop && fits(t.id));
  if (!track) {
    track = { id: newId(), target: { kind: "scene" }, mute: false, solo: false, lock: false, name: trackName };
    d.tracks.push(track);
  }
  const clip: SceneClip = {
    id: newId(),
    kind: "scene",
    trackId: track.id,
    startMs: start,
    endMs: end,
    brightness: 100,
    fadeInMs: 0,
    fadeOutMs: 0,
    easing: "linear",
    entries,
    label,
  };
  d.cues.push(clip);
  return clip.id;
}
