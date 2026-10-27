import type { Peaks } from "./mediaApi";

/** 一个像素列要画的竖线：`min` / `max` 为 -127~127 的振幅。 */
export interface Column {
  min: number;
  max: number;
}

/**
 * 把峰值数据重采样成屏幕像素列。
 *
 * 每个像素列覆盖 `msPerPx` 毫秒，取其中所有峰值桶的最小 / 最大值；素材范围之外的列为空（`null`）。
 * 放大到一个桶跨过多个像素时，相邻像素列共用同一个桶。
 *
 * @param peaks 后端计算的峰值。
 * @param startMs 第一个像素列对应的素材内时刻（毫秒，可为负：素材还没开始）。
 * @param msPerPx 每个像素代表的毫秒数。
 * @param count 像素列数。
 * @returns 长度为 `count` 的数组；没有数据的列为 `null`。
 */
export function peakColumns(
  peaks: Pick<Peaks, "perSecond" | "peaks">,
  startMs: number,
  msPerPx: number,
  count: number,
): (Column | null)[] {
  const buckets = Math.floor(peaks.peaks.length / 2);
  const bucketMs = 1000 / peaks.perSecond;
  const out: (Column | null)[] = [];
  for (let x = 0; x < count; x += 1) {
    const from = startMs + x * msPerPx;
    const to = from + msPerPx;
    const first = Math.max(0, Math.floor(from / bucketMs));
    const last = Math.min(buckets - 1, Math.max(first, Math.ceil(to / bucketMs) - 1));
    if (to <= 0 || first >= buckets) {
      out.push(null);
      continue;
    }
    let min = 127;
    let max = -127;
    for (let b = first; b <= last; b += 1) {
      if (peaks.peaks[b * 2] < min) min = peaks.peaks[b * 2];
      if (peaks.peaks[b * 2 + 1] > max) max = peaks.peaks[b * 2 + 1];
    }
    out.push({ min, max });
  }
  return out;
}
