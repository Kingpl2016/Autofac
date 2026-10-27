/**
 * 录制活动时间线的纯逻辑：增量合并、换算为概览形状、时间轴分档与录制头位置。
 */

import { base64ToBytes, timeToX } from "./overview";
import type { Activity, ActivityDto, Overview } from "./types";

/**
 * 把一次全量 DTO 解码为活动时间线。
 *
 * @param dto 后端 DTO（应为 `from = 0` 的全量数据）。
 * @returns 解码后的时间线；每行长度补齐 / 截断到 `len`。
 */
export function decodeActivity(dto: ActivityDto): Activity {
  const fit = (b64: string) => {
    const bytes = base64ToBytes(b64);
    if (bytes.length === dto.len) return bytes;
    const out = new Uint8Array(dto.len);
    out.set(bytes.subarray(0, dto.len));
    return out;
  };
  return {
    generation: dto.generation,
    bucketUs: dto.bucketUs,
    len: dto.len,
    universes: dto.universes,
    change: dto.change.map(fit),
    level: dto.level.map(fit),
    partStartsUs: dto.partStartsUs,
  };
}

/** 两个 Universe 列表是否完全一致（同序）。 */
function sameUniverses(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((u, i) => u === b[i]);
}

/**
 * 把一次增量合并进本地时间线。
 *
 * - `from = 0`：全量覆盖（新的录制、后端合并过桶后都会这样推送）。
 * - 代次与 Universe 集合都一致：从 `from` 处覆盖到末尾。
 * - 其它情况（本地为空却收到中段增量、代次不一致、Universe 集合变化）无法合并，返回 `null`，
 *   调用方应改为拉取全量。
 *
 * @param prev 本地时间线；尚未有数据时为 `null`。
 * @param dto 后端推送的增量。
 * @returns 合并后的新时间线（不修改 `prev`），或无法合并时的 `null`。
 */
export function mergeActivity(prev: Activity | null, dto: ActivityDto): Activity | null {
  if (dto.from === 0) return decodeActivity(dto);
  if (
    !prev ||
    prev.generation !== dto.generation ||
    prev.bucketUs !== dto.bucketUs ||
    !sameUniverses(prev.universes, dto.universes) ||
    dto.from > prev.len
  ) {
    return null;
  }
  const splice = (old: Uint8Array, b64: string) => {
    const out = new Uint8Array(dto.len);
    out.set(old.subarray(0, Math.min(dto.from, dto.len)));
    const tail = base64ToBytes(b64);
    out.set(tail.subarray(0, Math.max(0, dto.len - dto.from)), dto.from);
    return out;
  };
  return {
    generation: dto.generation,
    bucketUs: dto.bucketUs,
    len: dto.len,
    universes: prev.universes,
    change: prev.change.map((row, i) => splice(row, dto.change[i] ?? "")),
    level: prev.level.map((row, i) => splice(row, dto.level[i] ?? "")),
    partStartsUs: dto.partStartsUs,
  };
}

/**
 * 把活动时间线换成概览形状，复用回放热力图的折算与绘制。
 *
 * @param a 活动时间线。
 * @returns `buckets = len`、`durationUs = len × bucketUs` 的概览。
 */
export function activityAsOverview(a: Activity): Overview {
  return {
    durationUs: a.len * a.bucketUs,
    buckets: a.len,
    universes: a.universes,
    change: a.change,
    level: a.level,
    frames: 0,
    skippedFrames: 0,
  };
}

/** 时间轴分档（分钟）：超过最后一档后按整小时递增。 */
const AXIS_TIERS_MIN = [1, 5, 10, 30, 60] as const;
const MINUTE_US = 60_000_000;
const HOUR_US = 60 * MINUTE_US;

/**
 * 选择刚好覆盖已录时长的时间轴总长：录制头因此在轴上向右推进，而不是总贴在右端。
 *
 * @param elapsedUs 已录时长（微秒）。
 * @returns 时间轴总长（微秒）：1 / 5 / 10 / 30 / 60 分钟中第一个大于已录时长的档位，
 *   超过 1 小时后为下一个整小时。
 */
export function axisSpanUs(elapsedUs: number): number {
  const t = Math.max(0, elapsedUs);
  for (const m of AXIS_TIERS_MIN) {
    if (t < m * MINUTE_US) return m * MINUTE_US;
  }
  return (Math.floor(t / HOUR_US) + 1) * HOUR_US;
}

/**
 * 录制头在宽度为 `width` 的轴上的横向像素位置。
 *
 * @param elapsedUs 已录时长（微秒）。
 * @param width 轴像素宽度。
 * @param spanUs 轴总长（微秒）。
 */
export function headX(elapsedUs: number, width: number, spanUs: number): number {
  return timeToX(elapsedUs, width, spanUs);
}

/**
 * 已有数据覆盖的像素宽度（画布只画这一段，其后为空轨道）。
 *
 * @param a 活动时间线。
 * @param width 轴像素宽度。
 * @param spanUs 轴总长（微秒）。
 * @returns 0..width 的整数像素宽度。
 */
export function dataWidth(a: Activity | null, width: number, spanUs: number): number {
  if (!a || a.len === 0) return 0;
  return Math.max(0, Math.min(width, Math.round(timeToX(a.len * a.bucketUs, width, spanUs))));
}

/**
 * 把多行强度合成一行（每列取各行最大值），用于顶栏的单行迷你时间线。
 *
 * @param cells `heatmapCells` 的结果。
 * @returns 合成后的单行；没有行时为空数组。
 */
export function collapseRows(cells: Float32Array[]): Float32Array[] {
  if (cells.length === 0) return [];
  const out = new Float32Array(cells[0].length);
  for (const row of cells) {
    for (let c = 0; c < out.length; c += 1) out[c] = Math.max(out[c], row[c] ?? 0);
  }
  return [out];
}
