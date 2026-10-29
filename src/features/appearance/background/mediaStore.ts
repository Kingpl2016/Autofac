/** @file 背景媒体（图片、视频）的 IndexedDB 存取：设置里只有元数据，文件本身存在这里 */

/** 媒体类型：每种类型只保留一份，上传新文件会替换旧文件，不会越攒越多 */
export type MediaKind = "image" | "video";

/** 存储后端 */
interface MediaBackend {
  /** 读取文件，不存在时为 undefined */
  get: (key: string) => Promise<Blob | undefined>;
  /** 写入文件 */
  set: (key: string, blob: Blob) => Promise<void>;
  /** 删除文件 */
  del: (key: string) => Promise<void>;
}

/** idb-keyval 按需动态加载，没有用到背景媒体的用户不会下载它 */
const backend: MediaBackend = {
  get: async (key) => (await import("idb-keyval")).get<Blob>(key),
  set: async (key, blob) => (await import("idb-keyval")).set(key, blob),
  del: async (key) => (await import("idb-keyval")).del(key),
};

/**
 * 计算某类媒体在 IndexedDB 里的键。
 *
 * @param kind - 媒体类型
 * @returns 存储键
 */
function keyOf(kind: MediaKind): string {
  return `appearance-bg:${kind}`;
}

/**
 * 保存媒体文件；失败（如隐私模式下 IndexedDB 不可用、配额不足）时抛出，由调用方提示。
 *
 * @param kind - 媒体类型
 * @param blob - 文件内容
 */
export async function saveMedia(kind: MediaKind, blob: Blob): Promise<void> {
  await backend.set(keyOf(kind), blob);
}

/**
 * 读取媒体文件。
 *
 * @param kind - 媒体类型
 * @returns 文件；不存在或读取失败时为 undefined
 */
export async function loadMedia(kind: MediaKind): Promise<Blob | undefined> {
  try {
    return await backend.get(keyOf(kind));
  } catch {
    return undefined;
  }
}

/**
 * 删除媒体文件，失败时忽略（残留的文件不影响功能，下次上传会覆盖）。
 *
 * @param kind - 媒体类型
 */
export async function deleteMedia(kind: MediaKind): Promise<void> {
  try {
    await backend.del(keyOf(kind));
  } catch {
    // 删除失败不影响使用
  }
}
