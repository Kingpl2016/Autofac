/** @file 背景媒体的导入：图片在浏览器端缩放并转 WebP，同时算出平均亮度；视频只做类型与大小检查 */
import { MEDIA_LIMITS, meanLuminance } from "@/shared/appearance/background";

/** 图片最长边（px）：再大对背景没有意义，只会增加存储与解码成本 */
export const IMAGE_MAX_EDGE = 1920;
/** WebP 压缩质量 */
const IMAGE_QUALITY = 0.82;
/** 亮度采样的缩略图边长（px） */
const LUMA_SAMPLE = 32;
/** 允许上传的原始图片大小上限（字节），超过就不去解码，避免卡死页面 */
const IMAGE_INPUT_LIMIT = 25 * 1024 * 1024;

/** 导入失败的原因，用于给用户展示明确的提示 */
export type ImportErrorCode = "type" | "size" | "decode" | "unsupported";

/** 导入失败 */
export class MediaImportError extends Error {
  /** 失败原因代码 */
  readonly code: ImportErrorCode;

  /**
   * 创建导入错误。
   *
   * @param code - 原因代码
   */
  constructor(code: ImportErrorCode) {
    super(code);
    this.name = "MediaImportError";
    this.code = code;
  }
}

/** 导入成功的结果 */
export interface ImportedMedia {
  /** 处理后的文件 */
  blob: Blob;
  /** 平均亮度；视频为 null */
  luma: number | null;
  /** 文件大小（字节） */
  size: number;
}

/**
 * 计算缩放后的尺寸：最长边不超过上限，不放大。
 *
 * @param width - 原始宽度
 * @param height - 原始高度
 * @returns 目标宽高
 */
export function fitWithin(width: number, height: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= IMAGE_MAX_EDGE) return { width, height };
  const scale = IMAGE_MAX_EDGE / longest;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/**
 * 把画布导出为 Blob。
 *
 * @param canvas - 画布
 * @returns WebP 文件；浏览器不支持 WebP 编码时回退为 JPEG
 */
function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) reject(new MediaImportError("unsupported"));
        else resolve(blob);
      },
      "image/webp",
      IMAGE_QUALITY,
    );
  });
}

/**
 * 导入图片：解码 → 缩放 → 转 WebP → 采样平均亮度。
 *
 * @param file - 用户选择的图片文件
 * @returns 处理后的图片与平均亮度
 * @throws {MediaImportError} 类型不对、过大、解码失败，或浏览器不支持所需 API
 */
export async function importImage(file: File): Promise<ImportedMedia> {
  if (!file.type.startsWith("image/") || file.type === "image/svg+xml") {
    // SVG 可以内嵌脚本与外部引用，背景不需要矢量图，直接拒绝
    throw new MediaImportError("type");
  }
  if (file.size > IMAGE_INPUT_LIMIT) throw new MediaImportError("size");
  if (typeof createImageBitmap !== "function") throw new MediaImportError("unsupported");

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new MediaImportError("decode");
  }

  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new MediaImportError("unsupported");
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await canvasToBlob(canvas);
    if (blob.size > MEDIA_LIMITS.imageBytes) throw new MediaImportError("size");

    // 缩到很小再读像素，平均亮度足够准确，成本可以忽略
    const sample = document.createElement("canvas");
    sample.width = LUMA_SAMPLE;
    sample.height = LUMA_SAMPLE;
    const sampleContext = sample.getContext("2d", { willReadFrequently: true });
    sampleContext?.drawImage(bitmap, 0, 0, LUMA_SAMPLE, LUMA_SAMPLE);
    const luma = sampleContext
      ? meanLuminance(sampleContext.getImageData(0, 0, LUMA_SAMPLE, LUMA_SAMPLE).data)
      : null;
    return { blob, luma, size: blob.size };
  } finally {
    bitmap.close();
  }
}

/** 允许的视频类型 */
const VIDEO_TYPES: ReadonlySet<string> = new Set(["video/mp4", "video/webm"]);

/**
 * 导入视频：只检查类型与大小，不转码（浏览器端转码不现实）。
 *
 * @param file - 用户选择的视频文件
 * @returns 原样的视频文件；亮度未知
 * @throws {MediaImportError} 类型不是 mp4 / webm，或超过大小上限
 */
export function importVideo(file: File): ImportedMedia {
  if (!VIDEO_TYPES.has(file.type)) throw new MediaImportError("type");
  if (file.size > MEDIA_LIMITS.videoBytes) throw new MediaImportError("size");
  return { blob: file, luma: null, size: file.size };
}
