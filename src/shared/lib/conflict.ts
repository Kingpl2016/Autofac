/** 合并模式（与设置里的 `merge.mode` 一致）。 */
export type MergeModeName = "htp" | "ltp" | "priority";

/** 冲突级别：`info` 为正常合并（HTP），`warning` 为会丢数据的合并。 */
export type ConflictLevel = "none" | "info" | "warning";

/**
 * 按合并模式判断冲突级别。
 *
 * HTP 下多个来源取值不同是正常的“取最大”，只作提示；LTP / Priority 下
 * 取值不同意味着其中一方的数据被覆盖，需要警示。
 *
 * @param mode 当前合并模式。
 * @param conflictChannels 取值不一致的通道数。
 * @returns 冲突级别。
 */
export function conflictLevel(mode: MergeModeName, conflictChannels: number): ConflictLevel {
  if (conflictChannels <= 0) return "none";
  return mode === "htp" ? "info" : "warning";
}