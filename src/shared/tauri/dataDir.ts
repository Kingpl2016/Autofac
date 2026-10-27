import { invoke } from "./invoke";

/** 后端 `data_dir_info` 的结果。 */
export interface DataDirInfo {
  /** 数据根目录（软件目录下的 `data`，或软件目录没有写权限时退回的系统应用数据目录） */
  path: string;
  /** 是否因为软件目录没有写权限而退回了系统目录 */
  fallbackUsed: boolean;
}

let cached: Promise<DataDirInfo | null> | null = null;

/**
 * 查询应用数据根目录（整个应用运行期间不变，结果被缓存）。
 *
 * 没有 Tauri 后端（测试、网页预览）或查询失败时返回 `null`，调用方应退回到相对路径。
 *
 * @returns 数据目录信息，或 `null`。
 */
export function getDataDir(): Promise<DataDirInfo | null> {
  cached ??= (async () => {
    try {
      return await invoke<DataDirInfo>("data_dir_info");
    } catch {
      return null;
    }
  })();
  return cached;
}

/**
 * 数据目录下某个文件的完整路径。
 *
 * 前端的 JSON 持久化（Tauri Store）据此把文件放进与后端相同的数据目录。
 *
 * @param file 文件名（不含目录）。
 * @returns 绝对路径；取不到数据目录时原样返回文件名（由插件按它自己的默认位置处理）。
 */
export async function dataFilePath(file: string): Promise<string> {
  const dir = await getDataDir();
  if (!dir) return file;
  const sep = dir.path.includes("\\") ? "\\" : "/";
  return `${dir.path.replace(/[\\/]+$/, "")}${sep}${file}`;
}

/** 清除缓存（仅测试使用）。 */
export function resetDataDirCache(): void {
  cached = null;
}