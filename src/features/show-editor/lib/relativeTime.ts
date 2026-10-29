import { formatRelativeTime } from "@/shared/lib/relativeTime";

/**
 * 最近文件的相对时间（“3 分钟前”“昨天”“2 周前”），最远到“x 年前”，一分钟以内显示“现在”。
 *
 * @param at 时间戳（毫秒）。
 * @param now 当前时间戳（毫秒）。
 * @param locale 语言。
 * @returns 文字。
 */
export function relativeTime(at: number, now: number, locale: string): string {
  return formatRelativeTime(at, now, locale, { maxUnit: "year", nowUnit: "second" });
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
