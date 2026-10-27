import { invoke } from "@/shared/tauri/invoke";

/** 后端 `media_probe` 的结果。 */
export interface MediaInfo {
  kind: "audio" | "video";
  /** 时长（毫秒）；无音轨的视频为 `null`，由前端从元数据补上 */
  durationMs: number | null;
  hasAudio: boolean;
  sampleRate: number | null;
  channels: number | null;
}

/** 波形峰值：每个桶两个值 `[最小, 最大]`（-127~127），按桶顺序平铺。 */
export interface Peaks {
  perSecond: number;
  durationMs: number;
  peaks: number[];
}

/** 后端错误码。 */
export const MEDIA_ERR = {
  notFound: "not_found",
  unsupportedExtension: "unsupported_extension",
  unsupported: "unsupported",
  io: "io",
  decode: "decode",
} as const;

/** 默认的波形精度：每秒桶数。 */
export const PEAKS_PER_SECOND = 50;

/**
 * 探测素材的类型、时长与音轨信息。
 *
 * @param path 素材文件路径。
 */
export function mediaProbe(path: string): Promise<MediaInfo> {
  return invoke<MediaInfo>("media_probe", { path });
}

/**
 * 放行 asset 协议对这个素材文件的访问（之后才能用 `<audio>` / `<video>` 播放）。
 *
 * @param path 素材文件路径。
 */
export function mediaAuthorize(path: string): Promise<void> {
  return invoke<void>("media_authorize", { path });
}

/**
 * 计算素材的波形峰值（后端有磁盘缓存）。
 *
 * @param path 素材文件路径。
 * @param perSecond 每秒桶数。
 */
export function mediaPeaks(path: string, perSecond = PEAKS_PER_SECOND): Promise<Peaks> {
  return invoke<Peaks>("media_peaks", { path, perSecond });
}
