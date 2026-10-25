import { upload, download } from "@tauri-apps/plugin-upload";

/** 上传 / 下载进度载荷。 */
export interface UploadProgress {
  /** 本次分块传输的字节数（非累计）。 */
  progress: number;
  /** 累计已传输字节数。 */
  progressTotal: number;
  /** 传输总字节数；下载时来自 `Content-Length`，缺失为 `0`。 */
  total: number;
  /** 近似传输速度（字节/秒）。 */
  transferSpeed: number;
}

/** 进度回调类型。 */
export type UploadProgressHandler = (progress: UploadProgress) => void;

/**
 * 把本地文件以原始请求体 HTTP 上传到远端（默认 POST）。
 *
 * # Arguments
 *
 * * `url` - 目标 URL。
 * * `filePath` - 本地文件绝对路径。
 * * `onProgress` - 可选进度回调。
 * * `headers` - 可选请求头。
 *
 * # Returns
 *
 * 响应体文本。
 */
export function uploadFile(
  url: string,
  filePath: string,
  onProgress?: UploadProgressHandler,
  headers?: Map<string, string>,
): Promise<string> {
  return upload(url, filePath, onProgress, headers);
}

/**
 * 从远端 HTTP 下载到本地文件（默认 GET）。
 *
 * # Arguments
 *
 * * `url` - 源 URL。
 * * `filePath` - 保存到的本地文件绝对路径（父目录须已存在）。
 * * `onProgress` - 可选进度回调。
 * * `headers` - 可选请求头。
 *
 * # Returns
 *
 * 下载完成的 Promise。
 */
export function downloadFile(
  url: string,
  filePath: string,
  onProgress?: UploadProgressHandler,
  headers?: Map<string, string>,
): Promise<void> {
  return download(url, filePath, onProgress, headers);
}
