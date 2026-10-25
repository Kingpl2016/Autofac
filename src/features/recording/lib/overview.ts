import type { Overview, OverviewDto } from "./types";

/**
 * 把 Base64 字符串解码为字节数组。
 *
 * @param b64 标准 Base64 文本。
 * @returns 字节数组；输入非法时返回空数组。
 */
export function base64ToBytes(b64: string): Uint8Array {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return new Uint8Array(0);
  }
}

/**
 * 解码后端返回的概览（矩阵由 Base64 字符串还原为字节行）。
 *
 * @param dto 后端 DTO。
 */
export function decodeOverview(dto: OverviewDto): Overview {
  return {
    durationUs: dto.durationUs,
    buckets: dto.buckets,
    universes: dto.universes,
    change: dto.change.map(base64ToBytes),
    level: dto.level.map(base64ToBytes),
    frames: dto.frames,
    skippedFrames: dto.skippedFrames,
  };
}

/**
 * 把概览单元格映射为 0..1 的显示强度：电平决定亮度，变化强度叠加提亮。
 *
 * @param level 该桶最大电平 0..255。
 * @param change 该桶变化强度 0..255。
 */
export function cellIntensity(level: number, change: number): number {
  const base = (level / 255) * 0.7;
  const bump = (change / 255) * 0.3;
  return Math.min(1, base + bump);
}

/**
 * 把画布上的横向像素位置换算为节目时间（微秒）。
 *
 * @param x 像素位置（相对画布左边缘）。
 * @param width 画布像素宽度。
 * @param durationUs 节目总时长。
 */
export function xToTimeUs(x: number, width: number, durationUs: number): number {
  if (width <= 0 || durationUs <= 0) return 0;
  const ratio = Math.min(1, Math.max(0, x / width));
  return Math.round(ratio * durationUs);
}

/**
 * 把节目时间换算为画布横向像素位置。
 *
 * @param timeUs 节目时间（微秒）。
 * @param width 画布像素宽度。
 * @param durationUs 节目总时长。
 */
export function timeToX(timeUs: number, width: number, durationUs: number): number {
  if (durationUs <= 0) return 0;
  return (Math.min(durationUs, Math.max(0, timeUs)) / durationUs) * width;
}
