import { aiHistoryLibraryPath, aiHistoryRead, aiHistoryWrite } from "./api";

/**
 * 数据目录里的一个记忆文件（`ai-history/<名字>.ai.json`，复用对话记录的读写命令与路径校验）。
 *
 * 写入按调用顺序排队，后写的覆盖先写的；读写失败时静默（记忆是锦上添花，不影响对话）。
 */
export interface MemoryFile {
  /**
   * 读出文件内容。
   *
   * @returns 解析后的 JSON；文件不存在或读取失败时为 `null`。
   */
  read: () => Promise<unknown>;
  /**
   * 写入（排队）。
   *
   * @param data 要写的数据（会序列化成 JSON）。
   * @returns 这次写入完成（或失败）后兑现。
   */
  write: (data: unknown) => Promise<void>;
}

/**
 * 打开数据目录里的一个记忆文件。
 *
 * @param entry 文件名（不含 `.ai.json`；只允许字母、数字、`-`、`_`、`.`）。
 * @returns 读写接口。
 */
export function memoryFile(entry: string): MemoryFile {
  let path: Promise<string> | null = null;
  let chain: Promise<void> = Promise.resolve();
  const resolvePath = () => {
    path ??= aiHistoryLibraryPath(entry).catch((e: unknown) => {
      // 失败时下次重新取
      path = null;
      throw e;
    });
    return path;
  };
  return {
    read: async () => {
      try {
        const text = await aiHistoryRead(await resolvePath());
        return text ? (JSON.parse(text) as unknown) : null;
      } catch {
        return null;
      }
    },
    write: (data) => {
      const text = JSON.stringify(data);
      chain = chain.then(async () => aiHistoryWrite(await resolvePath(), text)).catch(() => undefined);
      return chain;
    },
  };
}
