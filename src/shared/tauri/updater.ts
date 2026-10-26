import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";

import { getDemoBackend } from "./demoBridge";

export type { DownloadEvent, Update };

/**
 * 向配置的更新端点查询是否有可用更新。
 *
 * 端点与签名公钥在 `tauri.conf.json` 的 `plugins.updater` 中配置；未配置或签名
 * 校验失败时底层会抛出错误，由调用方（关于页）捕获并提示。
 *
 * # Returns
 *
 * 有可用更新时返回 [`Update`]（可调用 `downloadAndInstall`）；已是最新返回 `null`。
 */
export function checkForUpdate(): Promise<Update | null> {
  const demo = getDemoBackend();
  return demo ? demo.checkForUpdate() : check();
}
