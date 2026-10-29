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
  const v = nonNegative(ms);
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

/** 非有限值与负数按 0 处理。 */
function nonNegative(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 按 1024 进位缩放字节数，返回缩放后的值与单位下标。
 *
 * @param bytes 字节数（已规整为非负）。
 * @param maxUnit 最大单位下标。
 */
function scale1024(bytes: number, maxUnit: number): { value: number; unit: number } {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < maxUnit) {
    value /= 1024;
    unit += 1;
  }
  return { value, unit };
}

const KB_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;
const IEC_UNITS = ["B", "KiB", "MiB", "GiB"] as const;

/**
 * 字节数（1024 进位，单位写作 KB / MB）：`1.5 MB`。用于下载、上传、传输速度等界面。
 *
 * @param bytes 字节数；负数与非有限值按 0 处理。
 * @returns `B` 级取整，其余保留一位小数。
 */
export function formatBytes(bytes: number): string {
  const { value, unit } = scale1024(nonNegative(bytes), KB_UNITS.length - 1);
  return `${unit === 0 ? Math.round(value) : value.toFixed(1)} ${KB_UNITS[unit]}`;
}

/**
 * 字节数（1024 进位，IEC 单位 KiB / MiB）：`1.5 MiB`、`150 MiB`。用于节目文件大小。
 *
 * @param bytes 字节数；负数与非有限值按 0 处理。
 * @returns `B` 级取整；其余不足 100 保留一位小数，100 起取整。
 */
export function formatBytesIec(bytes: number): string {
  const { value, unit } = scale1024(nonNegative(bytes), IEC_UNITS.length - 1);
  if (unit === 0) return `${Math.round(value)} B`;
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${IEC_UNITS[unit]}`;
}

/** 两位补零。 */
export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * 整秒数格式化为钟表式时长：`m:ss`，一小时以上为 `h:mm:ss`。
 * 各处的时间码在此基础上追加自己的小数部分（十分之一秒、毫秒或帧）。
 *
 * @param totalSec 秒数；负数与非有限值按 0 处理，小数向下取整。
 * @param padMinutes 不足一小时时分钟也补成两位（`03:20`）。
 * @returns 时长文本。
 */
export function formatHms(totalSec: number, padMinutes = false): string {
  const total = Math.floor(nonNegative(totalSec));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  if (h > 0) return `${h}:${pad2(m)}:${pad2(s)}`;
  return `${padMinutes ? pad2(m) : m}:${pad2(s)}`;
}

/**
 * 格式化包速率：不足 1000 显示整数，达到 1000 起用 `k` 缩写。
 *
 * @param pps 每秒包数；负数与非有限值按 0 处理。
 * @returns 数值与固定单位 `pps`。
 */
export function formatPacketRate(pps: number): ValueWithUnit {
  const n = nonNegative(pps);
  if (n < 1000) return { value: String(Math.round(n)), unit: "pps" };
  return { value: `${trimFraction(n / 1000, 1)}k`, unit: "pps" };
}