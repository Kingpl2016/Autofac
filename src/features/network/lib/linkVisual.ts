import type { StatusDotShape, StatusDotTone } from "@/shared/components/StatusDot";
import type { LinkState } from "./access";

/**
 * 连接状态 → 指示点与文案键。形状区分严重度：圆 = 正常、三角 = 需处理、方块 = 不可用、圆环 = 进行中。
 */
export const LINK_VISUAL: Record<LinkState, { tone: StatusDotTone; shape: StatusDotShape; label: string }> = {
  online: { tone: "success", shape: "circle", label: "network.rail.online" },
  needToken: { tone: "warning", shape: "triangle", label: "network.rail.needToken" },
  offline: { tone: "muted", shape: "square", label: "network.rail.offline" },
  checking: { tone: "muted", shape: "spinner", label: "network.rail.checking" },
  rebooting: { tone: "warning", shape: "spinner", label: "network.rail.rebooting" },
};
