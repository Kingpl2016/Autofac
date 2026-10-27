import type { ChannelSeries, OverviewDto, SeriesPoint } from "@/features/recording/lib/types";
import { bytesToBase64 } from "../lib/base64";
import { renderSegments, toSegments } from "../lib/patterns";
import { sourceTimeSec, type ProgramRecord } from "./library";
import { fail } from "./world";

/** 概览默认桶数 / 允许范围（对应后端 `DEFAULT_BUCKETS` 与钳制范围）。 */
export const DEFAULT_BUCKETS = 480;
const MIN_BUCKETS = 32;
const MAX_BUCKETS = 2048;
/** 曲线单次最多通道数与点数。 */
const MAX_SERIES_CHANNELS = 16;
const MAX_SERIES_POINTS = 1200;
/** 每个桶 / 每个点内的采样次数，用来捕捉桶内的最大值、最小值与变化。 */
const SAMPLES_PER_BUCKET = 3;

/** 按 `path + buckets` 缓存，同一节目反复打开不重复计算。 */
const overviewCache = new Map<string, OverviewDto>();

/**
 * 生成节目的时间线概览：每个 Universe 一行，每个时间桶记录最大电平与变化强度。
 *
 * 数据来自节目里描述的图案，不是随机数，所以同一节目每次看到的热力图完全一致，
 * 分段切换（Cue）、频闪等都会在时间线上留下对应的痕迹。
 *
 * # Arguments
 *
 * * `program` - 节目记录。
 * * `buckets` - 期望桶数；省略用默认值，并钳制到允许范围。
 *
 * # Returns
 *
 * 概览 DTO（矩阵为 Base64 字符串，与后端一致）。
 */
export function buildOverview(program: ProgramRecord, buckets?: number): OverviewDto {
  const want = Math.min(MAX_BUCKETS, Math.max(MIN_BUCKETS, Math.round(buckets ?? DEFAULT_BUCKETS)));
  const key = `${program.entry.path}|${want}`;
  const cached = overviewCache.get(key);
  if (cached) return cached;

  const level: string[] = [];
  const change: string[] = [];
  for (const u of program.universes) {
    const segments = toSegments(u);
    const lv = new Uint8Array(want);
    const ch = new Uint8Array(want);
    let prev: number[] | null = null;
    for (let b = 0; b < want; b += 1) {
      let peak = 0;
      let delta = 0;
      for (let k = 0; k < SAMPLES_PER_BUCKET; k += 1) {
        const t = ((b + (k + 0.5) / SAMPLES_PER_BUCKET) / want) * program.durationSec;
        const frame = renderSegments(segments, sourceTimeSec(program, t));
        for (let i = 0; i < frame.length; i += 1) {
          if (frame[i] > peak) peak = frame[i];
          if (prev) {
            const d = Math.abs(frame[i] - prev[i]);
            if (d > delta) delta = d;
          }
        }
        prev = frame;
      }
      lv[b] = peak;
      ch[b] = delta;
    }
    level.push(bytesToBase64(lv));
    change.push(bytesToBase64(ch));
  }

  const dto: OverviewDto = {
    version: 1,
    durationUs: program.entry.durationUs,
    buckets: want,
    universes: program.universes.map((u) => u.universe),
    change,
    level,
    frames: program.entry.frames,
    skippedFrames: program.corruptFrames,
    fileBytes: program.entry.bytes,
  };
  overviewCache.set(key, dto);
  return dto;
}

/**
 * 丢弃某个节目的概览缓存（节目内容被替换后调用，与后端删除 `.ovw` 对应）。
 *
 * # Arguments
 *
 * * `path` - 节目路径。
 */
export function forgetOverview(path: string): void {
  for (const key of [...overviewCache.keys()]) {
    if (key.startsWith(`${path}|`)) overviewCache.delete(key);
  }
}

/** 曲线查询参数（已由命令层解析）。 */
export interface SeriesRequest {
  universe: number;
  channels: number[];
  t0Us: number;
  t1Us: number;
  maxPoints: number;
}

/**
 * 查询选定通道在时间区间内的降采样曲线。
 *
 * 每个点覆盖一小段时间，记录这段时间内的最小 / 最大值，所以尖峰和渐变在缩小后依然可见。
 *
 * # Arguments
 *
 * * `program` - 节目记录。
 * * `q` - 查询参数。
 *
 * # Returns
 *
 * 每个通道一条曲线，点按时间升序。
 *
 * # Errors
 *
 * 节目里没有该 Universe 时以 `unknown_universe` 失败；通道过多时以描述文本失败。
 */
export function buildSeries(program: ProgramRecord, q: SeriesRequest): ChannelSeries[] {
  const u = program.universes.find((x) => x.universe === q.universe);
  if (!u) fail("unknown_universe");
  if (q.channels.length > MAX_SERIES_CHANNELS) fail(`最多同时查看 ${MAX_SERIES_CHANNELS} 个通道`);

  const segments = toSegments(u);
  const points = Math.max(1, Math.min(MAX_SERIES_POINTS, Math.round(q.maxPoints)));
  const t0 = Math.max(0, q.t0Us);
  const t1 = Math.max(t0, Math.min(q.t1Us, program.entry.durationUs));
  const span = t1 - t0;

  const series: ChannelSeries[] = q.channels.map((channel) => ({ channel, points: [] as SeriesPoint[] }));
  for (let i = 0; i < points; i += 1) {
    const a = t0 + (span * i) / points;
    const width = span / points;
    const mins = new Array<number>(series.length).fill(255);
    const maxs = new Array<number>(series.length).fill(0);
    for (let k = 0; k < SAMPLES_PER_BUCKET; k += 1) {
      const tSec = (a + (width * (k + 0.5)) / SAMPLES_PER_BUCKET) / 1_000_000;
      const frame = renderSegments(segments, sourceTimeSec(program, tSec));
      series.forEach((s, idx) => {
        const v = frame[s.channel] ?? 0;
        if (v < mins[idx]) mins[idx] = v;
        if (v > maxs[idx]) maxs[idx] = v;
      });
    }
    series.forEach((s, idx) => {
      s.points.push({ tUs: Math.round(a), min: mins[idx], max: maxs[idx] });
    });
  }
  return series;
}
