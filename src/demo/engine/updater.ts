import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";
import { sleep, type World } from "./world";

/** 下载进度的推送间隔（毫秒）。 */
const CHUNK_EVERY_MS = 120;
/** 下载完成后到“安装完成”之间的停顿，让“正在安装”状态可见。 */
const INSTALL_MS = 1200;

/**
 * 创建“检查更新”的演示实现，返回形态与真实 `Update` 一致的对象：
 * 带更新说明、发布日期，`downloadAndInstall` 会按总时长推送 Started / Progress / Finished。
 *
 * 真实更新端点还是占位值，检查必然失败；演示模式下改为总是发现一个新版本，
 * 这样“关于”页的检查、下载进度和安装三个阶段都能看到。
 *
 * # Arguments
 *
 * * `world` - 共享的演示世界。
 *
 * # Returns
 *
 * 检查更新函数。
 */
export function createUpdateChecker(world: World): () => Promise<Update | null> {
  const seed = world.data.update;

  const downloadAndInstall = async (onEvent?: (e: DownloadEvent) => void): Promise<void> => {
    const chunks = Math.max(1, Math.round((seed.downloadSeconds * 1000) / CHUNK_EVERY_MS));
    const chunkLength = Math.ceil(seed.totalBytes / chunks);
    onEvent?.({ event: "Started", data: { contentLength: seed.totalBytes } });
    for (let i = 0; i < chunks; i += 1) {
      await sleep(CHUNK_EVERY_MS);
      onEvent?.({ event: "Progress", data: { chunkLength } });
    }
    onEvent?.({ event: "Finished" });
    await sleep(INSTALL_MS);
  };

  return async () => {
    await sleep(seed.checkDelayMs);
    const update = {
      available: true,
      currentVersion: seed.currentVersion,
      version: seed.version,
      date: seed.date,
      body: seed.body,
      rawJson: {},
      downloadAndInstall,
      download: downloadAndInstall,
      install: () => Promise.resolve(),
      close: () => Promise.resolve(),
    };
    // 真实的 Update 是持有 Rust 端资源的类实例；演示里只需要界面用到的字段与方法
    return update as unknown as Update;
  };
}
