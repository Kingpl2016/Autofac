/** 跨页面共用的数值 / 时长格式化。 */

/**
 * 千分位整数：`12340` → `12,340`。
 *
 * @param n 数值；非有限值按 0 处理，小数四舍五入。
 * @returns 带千分位的字符串。
 */
export function formatCount(n: number): string {
  const v = Number.isFinite(n) ? Math.round(n) : 0;
  return new Intl.NumberFormat("en-US").format(v);
}

/**
 * 把毫秒时长格式化为紧凑文本：`850ms`、`3.2s`、`42s`、`2m 5s`、`1h 3m`。
 *
 * @param ms 毫秒数；负数与非有限值按 0 处理。
 * @returns 紧凑时长字符串。
 */
export function formatDuration(ms: number): string {
  const v = Number.isFinite(ms) && ms > 0 ? ms : 0;
  if (v < 1000) return `${Math.round(v)}ms`;
  if (v < 10_000) return `${(v / 1000).toFixed(1)}s`;
  if (v < 60_000) return `${Math.round(v / 1000)}s`;
  const totalSec = Math.round(v / 1000);
  if (totalSec < 3600) return `${Math.floor(totalSec / 60)}m ${totalSec % 60}s`;
  return `${Math.floor(totalSec / 3600)}h ${Math.floor((totalSec % 3600) / 60)}m`;
}
/** 带单位的格式化结果：数值与单位分开，便于卡片用不同字号渲染。 */
export interface ValueWithUnit {
  /** 数值部分，如 `1.2k`、`84`。 */
  value: string;
  /** 单位部分，如 `pps`、`MB`；无数据时为空串。 */
  unit: string;
}

/** 去掉小数末尾的 `.0`。 */
export function trimFraction(n: number, digits: number): string {
  return n.toFixed(digits).replace(/\.0+$/, "");
}

/**
 * 格式化包速率：不足 1000 显示整数，达到 1000 起用 `k` 缩写。
 *
 * @param pps 每秒包数；负数与非有限值按 0 处理。
 * @returns 数值与固定单位 `pps`。
 */
export function formatPacketRate(pps: number): ValueWithUnit {
  const n = Number.isFinite(pps) && pps > 0 ? pps : 0;
  if (n < 1000) return { value: String(Math.round(n)), unit: "pps" };
  return { value: `${trimFraction(n / 1000, 1)}k`, unit: "pps" };
}