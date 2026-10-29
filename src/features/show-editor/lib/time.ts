import { formatHms, pad2 } from "@/shared/lib/format";
import { OUTPUT_FPS } from "./project";

/**
 * 毫秒转时间码 `mm:ss.ff`（`ff` 为帧，按 30 FPS）；一小时以上显示 `h:mm:ss.ff`。
 *
 * @param ms 毫秒，负数按 0 处理。
 * @returns 时间码字符串。
 */
export function formatTimecode(ms: number): string {
  const safe = Math.max(0, Math.floor(ms));
  const frames = Math.floor(((safe % 1000) / 1000) * OUTPUT_FPS);
  return `${formatHms(Math.floor(safe / 1000), true)}.${pad2(frames)}`;
}

/**
 * 解析时间码（`mm:ss.ff` / `h:mm:ss.ff` / `ss.ff` / 纯数字秒）为毫秒。
 *
 * @param text 用户输入。
 * @returns 毫秒；无法解析时为 `null`。
 */
export function parseTimecode(text: string): number | null {
  const parts = text.trim().split(":");
  if (parts.length === 0 || parts.length > 3 || parts.some((p) => p === "")) return null;
  const last = parts[parts.length - 1];
  const pieces = last.split(".");
  if (pieces.length > 2) return null;
  const [secText, frameText] = pieces;
  if (!/^\d+$/.test(secText) || (frameText !== undefined && !/^\d{1,2}$/.test(frameText))) return null;
  const head = parts.slice(0, -1);
  if (head.some((p) => !/^\d+$/.test(p))) return null;
  const nums = [...head.map(Number), Number(secText)];
  const seconds = nums.reduce((acc, n) => acc * 60 + n, 0);
  const frames = frameText === undefined ? 0 : Number(frameText.padEnd(2, "0"));
  if (frames >= OUTPUT_FPS) return null;
  return Math.round(seconds * 1000 + (frames / OUTPUT_FPS) * 1000);
}

/**
 * 把毫秒对齐到最近的帧边界（30 FPS）。
 *
 * @param ms 毫秒。
 * @returns 对齐后的毫秒（取整）。
 */
export function snapToFrame(ms: number): number {
  const frameMs = 1000 / OUTPUT_FPS;
  return Math.round(Math.round(ms / frameMs) * frameMs);
}
