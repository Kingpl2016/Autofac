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

/**
 * 解析“跳转到”的输入（点播放头时间码后输入）：
 *
 * - 时间码：`1:23.10`、`1:02:03`、`83`（秒）；
 * - 带单位：`83s`、`1.5s`、`1500ms`、`12f`（帧）；
 * - 相对当前位置：前面加 `+` / `-`，例如 `+2s`、`-10f`、`+0:30`。
 *
 * @param text 用户输入。
 * @param currentMs 当前播放头（相对跳转用）。
 * @returns 目标毫秒（不小于 0）；无法解析时为 `null`。
 */
export function parseJumpTime(text: string, currentMs: number): number | null {
  const raw = text.trim().toLowerCase().replace(/\s+/g, "");
  if (raw === "") return null;
  const sign = raw.startsWith("+") ? 1 : raw.startsWith("-") ? -1 : 0;
  const body = sign === 0 ? raw : raw.slice(1);
  let ms: number | null;
  const unit = /^(\d+(?:\.\d+)?)(ms|s|f)$/.exec(body);
  if (unit) {
    const n = Number(unit[1]);
    ms = unit[2] === "ms" ? n : unit[2] === "s" ? n * 1000 : (n / OUTPUT_FPS) * 1000;
  } else {
    ms = parseTimecode(body);
  }
  if (ms === null || !Number.isFinite(ms)) return null;
  const target = sign === 0 ? ms : currentMs + sign * ms;
  return Math.max(0, Math.round(target));
}
