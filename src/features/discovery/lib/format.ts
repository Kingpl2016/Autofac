/** 设备发现展示用的格式化辅助。 */

/**
 * 将“最后在线”格式化为本地化的相对时间（如“3 分钟前”）。
 *
 * 后端的 `lastSeenMs` 是相对应用启动的逻辑时间（毫秒），不是 epoch，
 * 所以必须用同一时间基准的 `nowMs`（引擎运行时长）来计算间隔。
 *
 * @param lastSeenMs 设备最后活动的逻辑时间（毫秒）。
 * @param nowMs 当前逻辑时间（毫秒），与 `lastSeenMs` 同一基准。
 * @param language 当前界面语言（`zh` / `en`）。
 * @returns 本地化的相对时间字符串。
 */
export function formatLastSeen(
  lastSeenMs: number,
  nowMs: number,
  language: string,
): string {
  const locale = language.startsWith("zh") ? "zh-CN" : "en";
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const sec = Math.max(0, Math.round((nowMs - lastSeenMs) / 1000));

  if (sec < 60) return rtf.format(-sec, "second");
  const min = Math.round(sec / 60);
  if (min < 60) return rtf.format(-min, "minute");
  const hr = Math.round(min / 60);
  if (hr < 24) return rtf.format(-hr, "hour");
  return rtf.format(-Math.round(hr / 24), "day");
}
