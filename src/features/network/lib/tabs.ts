/** 页面 Tab。 */
export type NetworkTab = "files" | "commands" | "firmware";

const TABS: readonly NetworkTab[] = ["files", "commands", "firmware"];

/**
 * 解析 URL 里的 Tab，非法值回退到 `files`。
 *
 * # Arguments
 *
 * * `raw` - `tab` 查询参数。
 */
export function parseTab(raw: string | null): NetworkTab {
  return TABS.includes(raw as NetworkTab) ? (raw as NetworkTab) : "files";
}

/** 指令操作的子分段。 */
export type CommandsSub = "control" | "config" | "diag" | "logs";

const SUBS: readonly CommandsSub[] = ["control", "config", "diag", "logs"];

/**
 * 解析 URL 里的指令子分段，非法值回退到 `control`。
 *
 * # Arguments
 *
 * * `raw` - `sub` 查询参数。
 */
export function parseSub(raw: string | null): CommandsSub {
  return SUBS.includes(raw as CommandsSub) ? (raw as CommandsSub) : "control";
}
