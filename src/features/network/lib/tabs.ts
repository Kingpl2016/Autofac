/** 页面一级 Tab。 */
export type NetworkTab = "files" | "control" | "config" | "diag" | "firmware";

/** 全部 Tab（显示顺序）。 */
export const NETWORK_TABS: readonly NetworkTab[] = ["files", "control", "config", "diag", "firmware"];

/** 默认 Tab（不写进地址栏）。 */
export const DEFAULT_TAB: NetworkTab = "files";

/**
 * 解析 URL 里的 Tab，非法值回退到 `files`。
 *
 * 兼容旧链接：以前“指令操作”是一个 Tab（`tab=commands`），里面再用 `sub` 分出
 * 控制 / 配置 / 诊断 / 日志；现在它们是一级 Tab，日志并入诊断。
 *
 * # Arguments
 *
 * * `tab` - `tab` 查询参数。
 * * `sub` - 旧版 `sub` 查询参数（只在 `tab=commands` 时有意义）。
 *
 * # Returns
 *
 * 当前应显示的 Tab。
 */
export function parseTab(tab: string | null, sub: string | null = null): NetworkTab {
  if (tab === "commands") {
    if (sub === "config") return "config";
    if (sub === "diag" || sub === "logs") return "diag";
    return "control";
  }
  return NETWORK_TABS.includes(tab as NetworkTab) ? (tab as NetworkTab) : DEFAULT_TAB;
}

/**
 * 地址栏里是否还留着旧版参数（需要改写成新格式）。
 *
 * # Arguments
 *
 * * `tab` - `tab` 查询参数。
 * * `sub` - `sub` 查询参数。
 */
export function isLegacyTabParam(tab: string | null, sub: string | null): boolean {
  return tab === "commands" || sub !== null;
}
