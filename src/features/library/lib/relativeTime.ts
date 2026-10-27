const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * 相对时间（“5 分钟前”“昨天”），超过一周显示日期。
 *
 * @param ms 时间点（Unix 毫秒）。
 * @param nowMs 当前时间（Unix 毫秒）。
 * @param locale 界面语言（BCP 47）。
 */
export function formatRelativeTime(ms: number, nowMs: number, locale: string): string {
  const diff = ms - nowMs;
  const abs = Math.abs(diff);
  if (abs >= 7 * DAY) return new Date(ms).toLocaleDateString(locale);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (abs < MINUTE) return rtf.format(0, "minute");
  if (abs < HOUR) return rtf.format(Math.round(diff / MINUTE), "minute");
  if (abs < DAY) return rtf.format(Math.round(diff / HOUR), "hour");
  return rtf.format(Math.round(diff / DAY), "day");
}
