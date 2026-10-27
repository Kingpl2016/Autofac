import type { MediaRef, ShowProject } from "./project";

/** 支持导入的扩展名（小写，与后端 `SUPPORTED_EXTENSIONS` 一致）。 */
export const MEDIA_EXTENSIONS = [
  "mp3",
  "wav",
  "flac",
  "aac",
  "m4a",
  "ogg",
  "oga",
  "mp4",
  "m4v",
  "mov",
  "webm",
  "mkv",
] as const;

/** 视频容器的扩展名。 */
const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set(["mp4", "m4v", "mov", "webm", "mkv"]);

/**
 * 取路径的扩展名（小写，不含点）。
 *
 * @param path 文件路径（Windows 或 POSIX 风格都行）。
 * @returns 扩展名；没有时为空串。
 */
export function extensionOf(path: string): string {
  const name = fileNameOf(path);
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/**
 * 取路径里的文件名。
 *
 * @param path 文件路径。
 * @returns 最后一段（含扩展名）。
 */
export function fileNameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

/**
 * 路径的扩展名是否是支持的音视频类型。
 *
 * @param path 文件路径。
 */
export function isMediaPath(path: string): boolean {
  return (MEDIA_EXTENSIONS as readonly string[]).includes(extensionOf(path));
}

/**
 * 按扩展名判断素材类型。
 *
 * @param path 文件路径。
 */
export function kindOfPath(path: string): MediaRef["kind"] {
  return VIDEO_EXTENSIONS.has(extensionOf(path)) ? "video" : "audio";
}

/**
 * 素材在时间线上的结束时刻。
 *
 * @param media 素材引用。
 */
export function mediaEndMs(media: Pick<MediaRef, "offsetMs" | "durationMs">): number {
  return media.offsetMs + media.durationMs;
}

/**
 * 主素材：驱动播放同步与波形显示的那个。优先第一个音频，其次第一个视频。
 *
 * @param project 工程（只读）。
 * @returns 主素材；没有素材时为 `undefined`。
 */
export function primaryMedia(project: Pick<ShowProject, "media">): MediaRef | undefined {
  return project.media.find((m) => m.kind === "audio") ?? project.media[0];
}
