import type { StatusTone } from "@/shared/components/StatusPill";
import type { OutputState } from "@/shared/domain/engine";

/**
 * 输出状态对应的状态胶囊色调。
 *
 * @param state 输出总体状态。
 * @returns `StatusPill` 的色调。
 */
export function outputTone(state: OutputState): StatusTone {
  switch (state) {
    case "sending":
      return "ready";
    case "dropping":
      return "warning";
    case "error":
      return "error";
    default:
      return "idle";
  }
}