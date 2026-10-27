/** 运行时长按量级选出的展示粒度。 */
export type UptimeUnit = "seconds" | "minutes" | "hours" | "days";

/** 拆分后的运行时长：`unit` 决定展示哪两段，其余段只用于提示。 */
export interface UptimeParts {
  unit: UptimeUnit;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

/**
 * 把运行秒数拆成适合人读的粒度：不足 1 分钟只给秒，不足 1 小时给"分 + 秒"，
 * 不足 1 天给"小时 + 分"，更久给"天 + 小时"。越久越不关心零头，也就不会每秒都在跳。
 *
 * # Arguments
 *
 * * `sec` - 运行秒数；负数、`NaN` 按 0 处理，小数向下取整。
 *
 * # Returns
 *
 * 粒度与各段数值（各段均已按进位取余，`days` 不封顶）。
 */
export function splitUptime(sec: number): UptimeParts {
  const total = Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : 0;
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const unit: UptimeUnit = days > 0 ? "days" : hours > 0 ? "hours" : minutes > 0 ? "minutes" : "seconds";
  return { unit, days, hours, minutes, seconds };
}

/**
 * 将秒数格式化为 `h:mm:ss` 或 `mm:ss`。
 *
 * @param sec 秒数。
 * @returns 可读时长字符串。
 */
export function formatUptime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
