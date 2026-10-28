/** 相对时间的分段（秒）。 */
const UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

/**
 * 相对时间文字（“3 分钟前”“昨天”）。一分钟以内显示“刚刚”一类的文字（由 `Intl` 的 `numeric: "auto"` 给出）。
 *
 * @param at 时间戳（毫秒）。
 * @param now 当前时间戳（毫秒）。
 * @param locale 语言。
 * @returns 文字。
 */
export function relativeTime(at: number, now: number, locale: string): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const diff = Math.round((at - now) / 1000);
  for (const [unit, sec] of UNITS) {
    if (Math.abs(diff) >= sec) return rtf.format(Math.round(diff / sec), unit);
  }
  return rtf.format(0, "second");
}

/**
 * 路径所在的文件夹（显示用）。
 *
 * @param path 文件路径。
 * @returns 文件夹路径；没有分隔符时为空串。
 */
export function folderOf(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i > 0 ? path.slice(0, i) : "";
}
