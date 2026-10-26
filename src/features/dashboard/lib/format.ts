/** Dashboard 展示用的格式化辅助。 */

import { trimFraction, type ValueWithUnit } from "@/shared/lib/format";

// 包速率格式化已提升到共享库，这里再导出以保持既有引用路径可用
export { formatPacketRate, type ValueWithUnit } from "@/shared/lib/format";

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

/**
 * 格式化进程内存：不足 1 GB 用 MB（取整），否则用 GB（保留 1 位小数）。
 *
 * @param bytes 字节数；`0`、负数与非有限值视为"暂无数据"。
 * @returns 数值与单位；暂无数据时返回 `{ value: "—", unit: "" }`。
 */
export function formatMemory(bytes: number): ValueWithUnit {
  if (!Number.isFinite(bytes) || bytes <= 0) return { value: "—", unit: "" };
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return { value: String(Math.max(1, Math.round(mb))), unit: "MB" };
  return { value: trimFraction(mb / 1024, 1), unit: "GB" };
}
