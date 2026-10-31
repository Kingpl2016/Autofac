import type { AudioAnalysis } from "@/bindings/AudioAnalysis";
import type { BeatAnalysis } from "@/bindings/BeatAnalysis";
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
  noBeat: "no_beat",
  cancelled: "cancelled",
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

/** 舞台背景图允许的扩展名（与后端 `IMAGE_EXTENSIONS` 一致）。 */
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg"] as const;

/**
 * 放行 asset 协议对一张舞台背景图的访问（之后才能在画布上绘制）。
 *
 * @param path 图片路径。
 */
export function stageImageAuthorize(path: string): Promise<void> {
  return invoke<void>("stage_image_authorize", { path });
}

export type { AudioAnalysis } from "@/bindings/AudioAnalysis";
export type { BarFeature } from "@/bindings/BarFeature";
export type { BeatAnalysis } from "@/bindings/BeatAnalysis";
export type { EventKind as MusicEventKind } from "@/bindings/EventKind";

/** 音乐结构分析的版本（与后端 `ANALYSIS_VERSION` 一致；不一致的结果当作过期）。 */
export const ANALYSIS_VERSION = 1;

/** 灵敏度的范围与默认值（与后端一致）。 */
export const SENSITIVITY = { min: 0.5, max: 2, default: 1 } as const;

/** 段落标签置信度低于这个值时不据此推断段落角色（与后端 `MIN_LABEL_CONFIDENCE` 一致）。 */
export const MIN_LABEL_CONFIDENCE = 0.5;

/**
 * 音乐结构分析：节拍、每小节特征、段落结构标签与事件（后端有磁盘缓存）。
 *
 * @param path 素材文件路径。
 * @param sensitivity 灵敏度 0.5~2。
 * @param requestId 请求 id（`mediaCancel` 用它取消）。
 * @returns 分析结果（素材内时刻）。
 * @throws 后端错误码：`not_found` / `unsupported` / `decode` / `no_beat` / `cancelled`。
 */
export function mediaAnalyze(path: string, sensitivity: number, requestId?: string, cachedOnly = false): Promise<AudioAnalysis> {
  return invoke<AudioAnalysis>("media_analyze", { path, sensitivity, requestId: requestId ?? null, cachedOnly });
}

/**
 * 取消进行中的分析或截取。
 *
 * @param requestId 请求 id。
 */
export function mediaCancel(requestId: string): Promise<void> {
  return invoke<void>("media_cancel", { requestId });
}

/**
 * 截取若干段音频（16 kHz 单声道 WAV，Base64），发给支持音频输入的模型前调用；调用方要先征得用户同意。
 *
 * @param path 素材文件路径。
 * @param ranges 片段（素材内毫秒，最多 16 段，每段最长 20 秒）。
 * @param requestId 请求 id。
 * @returns 与 `ranges` 对应的 Base64；落在音轨外的为空串。
 */
export function mediaExcerpt(path: string, ranges: readonly { startMs: number; lengthMs: number }[], requestId?: string): Promise<string[]> {
  return invoke<string[]>("media_excerpt", { path, ranges, requestId: requestId ?? null });
}

/**
 * 读取前端算出的素材分析缓存（素材修改后自然失效）。
 *
 * @param path 素材路径。
 * @param kind 缓存种类。
 * @returns JSON 文本；没有缓存时为 `null`。
 */
export function mediaCacheGet(path: string, kind: "video"): Promise<string | null> {
  return invoke<string | null>("media_cache_get", { path, kind });
}

/**
 * 写入前端算出的素材分析缓存（JSON，最多 2 MiB）。
 *
 * @param path 素材路径。
 * @param kind 缓存种类。
 * @param data JSON 文本。
 */
export function mediaCachePut(path: string, kind: "video", data: string): Promise<void> {
  return invoke<void>("media_cache_put", { path, kind, data });
}

/**
 * 分析素材的节拍：速度、强拍、逐拍时刻与按能量划分的段落（后端有磁盘缓存）。
 *
 * @param path 素材文件路径。
 * @returns 分析结果。
 * @throws 后端错误码：`not_found` / `unsupported` / `decode` / `no_beat`。
 */
export function mediaAnalyzeBeats(path: string): Promise<BeatAnalysis> {
  return invoke<BeatAnalysis>("media_analyze_beats", { path });
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
