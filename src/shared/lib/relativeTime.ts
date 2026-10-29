/** 相对时间（“3 分钟前”“昨天”），基于 `Intl.RelativeTimeFormat`。 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 一周的毫秒数。 */
export const WEEK_MS = 7 * DAY;

/** 可用的单位，从小到大（月、年按 30 天、365 天近似）。 */
const UNITS = [
  ["second", SECOND],
  ["minute", MINUTE],
  ["hour", HOUR],
  ["day", DAY],
  ["week", WEEK_MS],
  ["month", 30 * DAY],
  ["year", 365 * DAY],
] as const;

/** 相对时间用到的单位。 */
export type RelativeUnit = (typeof UNITS)[number][0];

/** `formatRelativeTime` 的选项。 */
export interface RelativeTimeOptions {
  /** 最小单位。默认 `minute`。 */
  minUnit?: RelativeUnit;
  /** 最大单位。默认 `day`。 */
  maxUnit?: RelativeUnit;
  /** 差值不到一个最小单位时，用哪个单位的 `format(0, unit)` 表达“现在”。默认与最小单位相同。 */
  nowUnit?: RelativeUnit;
  /** 差值达到该毫秒数时改为显示本地日期；省略时一直显示相对时间。 */
  dateAfterMs?: number;
  /**
   * 取整方式：
   * - `threshold`（默认）：取不超过差值的最大单位再四舍五入（59.6 分钟显示“60 分钟前”）；
   * - `cascade`：从最小单位起逐级四舍五入并进位（59.6 分钟显示“1 小时前”）。
   */
  rounding?: "threshold" | "cascade";
}

/**
 * 相对时间文字（`numeric: "auto"`，会出现“昨天”“明天”）。
 *
 * @param atMs 时间点（毫秒）。
 * @param nowMs 当前时间（毫秒，与 `atMs` 同一时间基准）。
 * @param locale 语言（BCP 47）。
 * @param options 单位范围、“现在”的表达、改用日期的阈值与取整方式。
 * @returns 本地化文字。
 */
export function formatRelativeTime(
  atMs: number,
  nowMs: number,
  locale: string,
  { minUnit = "minute", maxUnit = "day", nowUnit, dateAfterMs, rounding = "threshold" }: RelativeTimeOptions = {},
): string {
  const diff = atMs - nowMs;
  const abs = Math.abs(diff);
  if (dateAfterMs !== undefined && abs >= dateAfterMs) return new Date(atMs).toLocaleDateString(locale);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const first = UNITS.findIndex(([u]) => u === minUnit);
  const last = UNITS.findIndex(([u]) => u === maxUnit);

  if (rounding === "cascade") {
    let i = first;
    let value = Math.round(abs / UNITS[i][1]);
    while (i < last) {
      const ratio = UNITS[i + 1][1] / UNITS[i][1];
      if (value < ratio) break;
      value = Math.round(value / ratio);
      i += 1;
    }
    return rtf.format(diff < 0 ? -value : value, UNITS[i][0]);
  }

  for (let i = last; i >= first; i -= 1) {
    const [unit, ms] = UNITS[i];
    if (abs >= ms) return rtf.format(Math.round(diff / ms), unit);
  }
  return rtf.format(0, nowUnit ?? minUnit);
}
