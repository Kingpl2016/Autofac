/** 设备发现展示用的格式化辅助。 */
import { intlLocale } from "@/shared/lib/locale";
import { formatRelativeTime } from "@/shared/lib/relativeTime";

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
  // 时钟回退（lastSeen 晚于 now）时按“现在”处理
  return formatRelativeTime(Math.min(lastSeenMs, nowMs), nowMs, intlLocale(language), {
    minUnit: "second",
    maxUnit: "day",
    rounding: "cascade",
  });
}

/**
 * 把设备的“最后在线”逻辑时间换算成本地时钟时间。
 *
 * 后端的 `lastSeenMs` 是相对应用启动的逻辑时间，所以用“现在的本地时间减去间隔”得到
 * 大致的绝对时刻，仅用于详情里的参考展示。
 *
 * @param lastSeenMs 设备最后活动的逻辑时间（毫秒）。
 * @param nowMs 当前逻辑时间（毫秒），与 `lastSeenMs` 同一基准。
 * @returns 对应的本地 `Date`；时钟回退时按“刚刚”处理。
 */
export function lastSeenAsClock(lastSeenMs: number, nowMs: number): Date {
  return new Date(Date.now() - Math.max(0, nowMs - lastSeenMs));
}
