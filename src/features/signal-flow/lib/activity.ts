import type { Protocol, UniverseSnapshot } from "@/shared/domain/engine";
import type { ForwardDestination } from "@/features/forwarding";

/** 回放源在图中使用的伪 IP（真实 IP 不会是这个值）。 */
export const PLAYER_SOURCE_ID = "__player__";

/** 节点上显示的协议：单一协议或两者混合。 */
export type FlowProtocol = "artNet" | "sacn" | "mixed";

/** 该 Universe 是否来自回放源。 */
export function isPlayerUniverse(u: UniverseSnapshot): boolean {
  return u.sourceIps.includes(PLAYER_SOURCE_ID);
}

/**
 * Universe 是否有信号：包速率大于 0；回放的虚拟 Universe 没有速率，看是否正在播放。
 *
 * @param u Universe 快照。
 * @param playerActive 回放是否正在播放。
 */
export function universeActive(u: UniverseSnapshot, playerActive: boolean): boolean {
  return u.packetRate > 0 || (playerActive && isPlayerUniverse(u));
}

/**
 * 某个来源在某个 Universe 上是否有信号。
 *
 * @param ip 来源 IP（回放伪源为 {@link PLAYER_SOURCE_ID}）。
 * @param u Universe 快照。
 * @param playerActive 回放是否正在播放。
 */
export function linkActive(ip: string, u: UniverseSnapshot, playerActive: boolean): boolean {
  if (ip === PLAYER_SOURCE_ID) return playerActive;
  // 没有逐源统计时（旧快照）退化为整个 Universe 的速率
  const s = u.sources.find((x) => x.ip === ip);
  return s ? s.packetRate > 0 : u.sources.length === 0 && u.packetRate > 0;
}

/**
 * 某个来源在某个 Universe 上的包速率（pps）；没有逐源统计时为 0。
 *
 * @param ip 来源 IP。
 * @param u Universe 快照。
 */
export function linkRate(ip: string, u: UniverseSnapshot): number {
  return u.sources.find((x) => x.ip === ip)?.packetRate ?? 0;
}

/**
 * 不考虑 enabled 的路由解析（镜像后端）：目的地是否会转发该 Universe。
 *
 * @param dest 转发目的地。
 * @param universe 源 Universe 编号。
 */
export function resolvesForward(dest: ForwardDestination, universe: number): boolean {
  const ov = dest.overrides.find((o) => o.sourceUniverse === universe);
  if (dest.mode === "all") return ov?.action !== "exclude";
  return ov?.action === "forward";
}

/**
 * 由一组协议得出节点上显示的协议；未知协议按 Art-Net 处理。
 *
 * @param list 协议列表。
 */
export function protocolOf(list: readonly (Protocol | null)[]): FlowProtocol {
  const set = new Set(list.map((p) => (p === "sacn" ? "sacn" : "artNet")));
  if (set.size > 1) return "mixed";
  return set.has("sacn") ? "sacn" : "artNet";
}