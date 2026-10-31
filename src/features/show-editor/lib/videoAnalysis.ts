import type { VideoAnalysisResult } from "./mediaAnalysis";
import type { FrameImage, FrameSource } from "./pixelMap";

/**
 * 视频画面分析（在 webview 里解码取帧，确定性计算，不调用模型）：按固定帧率取小图，
 * 相邻帧的颜色直方图差异大于阈值处记为镜头切换；每个镜头给出主色与平均亮度。
 * 结果是素材内时刻，经 `mapAnalysis` 换算到时间线；后端按素材的修改时间缓存（`media_cache_*`）。
 */

/** 分析算法的版本（变化时缓存失效）。 */
export const VIDEO_ANALYSIS_VERSION = 1;
/** 取样帧率（帧 / 秒）。 */
export const VIDEO_FPS = 2;
/** 取样画面的宽度（像素）。 */
export const VIDEO_GRAB_WIDTH = 64;
/** 最多取多少帧（太长的视频降低帧率）。 */
export const MAX_VIDEO_FRAMES = 1800;
/** 两次切换至少隔多久（毫秒）。 */
const MIN_SHOT_MS = 1000;
/** 切换的直方图差异下限（0~1）。 */
const MIN_CUT_DIFF = 0.35;
/** 每个通道的直方图分箱数。 */
const BINS = 16;

/** 一帧的统计量。 */
export interface FrameStats {
  atMs: number;
  /** 三个通道的归一化直方图（各 16 箱，依次 R、G、B） */
  hist: Float32Array;
  /** 平均亮度 0~255 */
  luma: number;
  /** 4×4×4 颜色桶：权重（偏向饱和色）与加权的 RGB 和 */
  buckets: Float64Array;
}

/**
 * 统计一帧。
 *
 * @param img 画面（RGBA）。
 * @param atMs 素材内时刻。
 * @returns 统计量。
 */
export function frameStats(img: FrameImage, atMs: number): FrameStats {
  const hist = new Float32Array(BINS * 3);
  // 每个桶 4 个数：权重、R、G、B
  const buckets = new Float64Array(64 * 4);
  const n = img.width * img.height;
  let luma = 0;
  for (let i = 0; i < n; i += 1) {
    const r = img.data[i * 4];
    const g = img.data[i * 4 + 1];
    const b = img.data[i * 4 + 2];
    hist[r >> 4] += 1;
    hist[BINS + (g >> 4)] += 1;
    hist[BINS * 2 + (b >> 4)] += 1;
    luma += 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const w = 0.15 + (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
    const k = ((r >> 6) * 16 + (g >> 6) * 4 + (b >> 6)) * 4;
    buckets[k] += w;
    buckets[k + 1] += w * r;
    buckets[k + 2] += w * g;
    buckets[k + 3] += w * b;
  }
  if (n > 0) for (let i = 0; i < hist.length; i += 1) hist[i] /= n;
  return { atMs, hist, luma: n > 0 ? luma / n : 0, buckets };
}

/** 两帧直方图的差异 0~1（三个通道 L1 距离的平均的一半）。 */
export function histDiff(a: FrameStats, b: FrameStats): number {
  let sum = 0;
  for (let i = 0; i < a.hist.length; i += 1) sum += Math.abs(a.hist[i] - b.hist[i]);
  return sum / 6;
}

/** 一组帧的主色与平均亮度。 */
function shotColor(frames: readonly FrameStats[]): { rgb: [number, number, number]; brightness: number } {
  const acc = new Float64Array(64 * 4);
  let luma = 0;
  for (const f of frames) {
    for (let i = 0; i < acc.length; i += 1) acc[i] += f.buckets[i];
    luma += f.luma;
  }
  let best = 0;
  for (let k = 1; k < 64; k += 1) if (acc[k * 4] > acc[best * 4]) best = k;
  const w = acc[best * 4] || 1;
  const rgb = [acc[best * 4 + 1] / w, acc[best * 4 + 2] / w, acc[best * 4 + 3] / w].map((v) => Math.round(Math.min(255, Math.max(0, v)))) as [number, number, number];
  return { rgb, brightness: frames.length > 0 ? Math.round((luma / frames.length / 255) * 1000) / 1000 : 0 };
}

/**
 * 由逐帧统计找出镜头切换与镜头（纯函数）。阈值自适应：差异超过 `max(0.35, 中位数 × 3)` 且离上次切换至少 1 秒。
 *
 * @param frames 逐帧统计（按时刻）。
 * @param durationMs 素材时长。
 * @returns 切换与镜头（素材内时刻）。
 */
export function detectShots(frames: readonly FrameStats[], durationMs: number): VideoAnalysisResult {
  if (frames.length === 0) return { cuts: [], shots: [] };
  const diffs = frames.slice(1).map((f, i) => histDiff(frames[i], f));
  const sorted = [...diffs].sort((a, b) => a - b);
  const median = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0;
  const threshold = Math.max(MIN_CUT_DIFF, median * 3);
  const cuts: VideoAnalysisResult["cuts"] = [];
  let last = -Infinity;
  diffs.forEach((d, i) => {
    // 切换发生在两帧之间：取中点
    const at = Math.round((frames[i].atMs + frames[i + 1].atMs) / 2);
    if (d >= threshold && at - last >= MIN_SHOT_MS) {
      cuts.push({ atMs: at, strength: Math.round(Math.min(1, d / 0.7) * 1000) / 1000 });
      last = at;
    }
  });
  const edges = [0, ...cuts.map((c) => c.atMs), Math.max(durationMs, frames.at(-1)!.atMs + 1)];
  const shots: VideoAnalysisResult["shots"] = [];
  for (let i = 0; i + 1 < edges.length; i += 1) {
    const inShot = frames.filter((f) => f.atMs >= edges[i] && f.atMs < edges[i + 1]);
    if (inShot.length === 0) continue;
    shots.push({ startMs: edges[i], endMs: edges[i + 1], ...shotColor(inShot) });
  }
  return { cuts, shots };
}

/**
 * 取样时刻：按帧率均匀取，太长的视频降低帧率（最多 {@link MAX_VIDEO_FRAMES} 帧）。
 *
 * @param durationMs 素材时长。
 * @param fps 帧率。
 * @returns 素材内时刻（毫秒）。
 */
export function sampleTimes(durationMs: number, fps = VIDEO_FPS): number[] {
  if (durationMs <= 0) return [];
  const step = Math.max(1000 / fps, durationMs / MAX_VIDEO_FRAMES);
  const out: number[] = [];
  for (let t = step / 2; t < durationMs; t += step) out.push(Math.round(t));
  return out;
}

/**
 * 分析一段视频。
 *
 * @param source 帧源。
 * @param durationMs 素材时长。
 * @param options 取消信号与进度回调。
 * @returns 切换与镜头。
 * @throws 取帧失败（例如画面不可读）或被取消（`AbortError`）。
 */
export async function analyzeVideo(
  source: FrameSource,
  durationMs: number,
  options: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
): Promise<VideoAnalysisResult> {
  const times = sampleTimes(durationMs);
  const frames: FrameStats[] = [];
  for (const [i, at] of times.entries()) {
    if (options.signal?.aborted) throw new DOMException("cancelled", "AbortError");
    frames.push(frameStats(await source.grab(at), at));
    options.onProgress?.(i + 1, times.length);
  }
  return detectShots(frames, durationMs);
}

/** 缓存里的视频分析。 */
interface CachedVideo extends VideoAnalysisResult {
  version: number;
}

/**
 * 解析缓存的视频分析（版本不对或形状不对时为 `null`）。
 *
 * @param text 缓存的 JSON。
 * @returns 结果。
 */
export function parseVideoCache(text: string | null): VideoAnalysisResult | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as Partial<CachedVideo>;
    if (v.version !== VIDEO_ANALYSIS_VERSION || !Array.isArray(v.cuts) || !Array.isArray(v.shots)) return null;
    const num = (x: unknown) => typeof x === "number" && Number.isFinite(x);
    const cuts = v.cuts.filter((c) => num(c?.atMs) && num(c?.strength));
    const shots = v.shots.filter((s) => num(s?.startMs) && num(s?.endMs) && Array.isArray(s?.rgb) && s.rgb.length === 3 && num(s?.brightness));
    return { cuts, shots };
  } catch {
    return null;
  }
}

/**
 * 序列化成缓存。
 *
 * @param result 结果。
 * @returns JSON。
 */
export function videoCacheText(result: VideoAnalysisResult): string {
  return JSON.stringify({ version: VIDEO_ANALYSIS_VERSION, ...result } satisfies CachedVideo);
}
