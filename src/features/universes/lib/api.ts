import { invoke } from "@/shared/tauri/invoke";

/**
 * 同步“正在查看”的 Universe 集合到后端（决定后端推送哪些通道数据）。
 *
 * # Arguments
 *
 * * `universes` - 当前正在查看的 Universe 列表。
 *
 * # Returns
 *
 * 同步完成的 Promise。
 */
export function setViewedUniverses(universes: number[]): Promise<void> {
  return invoke<void>("set_viewed_universes", { universes });
}
