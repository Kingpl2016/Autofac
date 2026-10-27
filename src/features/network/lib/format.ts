const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/**
 * 把字节数格式化为易读文本，如 `1.5 MB`。
 *
 * @param bytes 字节数；负数与非有限值按 0 处理。
 * @returns 带单位的字符串，`B` 级取整，其余保留一位小数。
 */
export function formatBytes(bytes: number): string {
  let value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? Math.round(value) : value.toFixed(1)} ${UNITS[unit]}`;
}

/**
 * 把毫秒格式化为时间码：`m:ss`，一小时以上为 `h:mm:ss`。
 *
 * @param ms 毫秒；负数与非有限值按 0 处理。
 * @returns 时间码字符串。
 */
export function formatClock(ms: number): string {
  const total = Math.floor((Number.isFinite(ms) && ms > 0 ? ms : 0) / 1000);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/**
 * 把传输速度格式化为 `x.x MB/s`。
 *
 * @param bps 字节/秒。
 * @returns 带单位的速度文本。
 */
export function formatSpeed(bps: number): string {
  return `${formatBytes(bps)}/s`;
}

/**
 * 计算传输百分比。
 *
 * @param done 已传输字节。
 * @param total 总字节；为 0 表示未知。
 * @returns 0~100 的整数；总量未知返回 `null`。
 */
export function percentOf(done: number, total: number): number | null {
  if (!Number.isFinite(total) || total <= 0) return null;
  return Math.max(0, Math.min(100, Math.floor((done / total) * 100)));
}

/** “距今多久”的粒度。 */
export type AgoUnit = "now" | "sec" | "min" | "hour" | "day";

/**
 * 把时间差拆成“数值 + 单位”，由界面层翻译成“3 秒前 / 12 分钟前”。
 *
 * @param elapsedMs 距今的毫秒数；负数按 0 处理。
 * @returns 5 秒内为 `now`，其余取最大的整单位（向下取整）。
 */
export function agoParts(elapsedMs: number): { unit: AgoUnit; value: number } {
  const s = Math.floor((Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0) / 1000);
  if (s < 5) return { unit: "now", value: 0 };
  if (s < 60) return { unit: "sec", value: s };
  if (s < 3600) return { unit: "min", value: Math.floor(s / 60) };
  if (s < 86_400) return { unit: "hour", value: Math.floor(s / 3600) };
  return { unit: "day", value: Math.floor(s / 86_400) };
}

/**
 * 把时间戳格式化为本地的 `HH:mm`（24 小时制）。
 *
 * @param ts 毫秒时间戳。
 * @returns 例如 `09:05`。
 */
export function formatHourMinute(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
