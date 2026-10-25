import type { Edge, Node } from "@xyflow/react";

import type { UniverseSnapshot } from "@/shared/domain/engine";
import type { ForwardDestination } from "@/features/forwarding/lib/types";

/** 列 x 坐标。 */
const COL_X = { source: 0, universe: 360, destination: 720 };
/** 行间距。 */
const ROW_H = 92;
const TOP = 16;

/** 回放源在图中使用的伪 IP（真实 IP 不会是这个值）。 */
export const PLAYER_SOURCE_ID = "__player__";

/** 源节点数据。 */
export interface SourceNodeData extends Record<string, unknown> {
  ip: string;
  universeCount: number;
}
/** 回放源节点数据。 */
export interface PlayerNodeData extends Record<string, unknown> {
  name: string;
  universeCount: number;
}
/** Universe 节点数据。 */
export interface UniverseNodeData extends Record<string, unknown> {
  universe: number;
  sourceCount: number;
  aggregate?: boolean;
  totalUniverses?: number;
}
/** 目的地节点数据。 */
export interface DestinationNodeData extends Record<string, unknown> {
  name: string;
  ip: string;
  protocol: string;
  mode: string;
  enabled: boolean;
}

/** 不考虑 enabled 的路由解析（镜像后端），返回目标 universe 或 null。 */
function resolvesForward(dest: ForwardDestination, universe: number): boolean {
  const ov = dest.overrides.find((o) => o.sourceUniverse === universe);
  if (dest.mode === "all") return ov?.action !== "exclude";
  return ov?.action === "forward";
}

/**
 * 由活跃 Universe 快照与转发目的地派生信号流图。
 *
 * @param universes 活跃 Universe 快照。
 * @param destinations 转发目的地。
 * @param simplifyThreshold Universe 数达到此值切换聚合模式。
 * @param animated 边是否动画（reduced-motion 时为 false）。
 * @param playerName 回放节目名；源里出现回放伪 IP 时用它显示"回放源"节点。
 * @returns React Flow 的 nodes 与 edges。
 */
export function buildGraph(
  universes: UniverseSnapshot[],
  destinations: ForwardDestination[],
  simplifyThreshold: number,
  animated: boolean,
  playerName = "",
): { nodes: Node[]; edges: Edge[]; simplified: boolean } {
  const simplified = universes.length >= simplifyThreshold;
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  // 源节点（唯一 IP）
  const sourceUniverses = new Map<string, Set<number>>();
  for (const u of universes) {
    for (const ip of u.sourceIps) {
      if (!sourceUniverses.has(ip)) sourceUniverses.set(ip, new Set());
      sourceUniverses.get(ip)!.add(u.universe);
    }
  }
  const sourceIps = [...sourceUniverses.keys()].sort();
  sourceIps.forEach((ip, i) => {
    const isPlayer = ip === PLAYER_SOURCE_ID;
    nodes.push({
      id: `src:${ip}`,
      type: isPlayer ? "player" : "source",
      position: { x: COL_X.source, y: TOP + i * ROW_H },
      data: isPlayer
        ? ({
            name: playerName,
            universeCount: sourceUniverses.get(ip)!.size,
          } satisfies PlayerNodeData)
        : ({ ip, universeCount: sourceUniverses.get(ip)!.size } satisfies SourceNodeData),
    });
  });

  if (simplified) {
    // 聚合 Universe 节点
    const aggId = "uni:agg";
    nodes.push({
      id: aggId,
      type: "universe",
      position: { x: COL_X.universe, y: TOP + Math.max(0, (sourceIps.length - 1) / 2) * ROW_H },
      data: {
        universe: 0,
        sourceCount: sourceIps.length,
        aggregate: true,
        totalUniverses: universes.length,
      } satisfies UniverseNodeData,
    });
    for (const ip of sourceIps) {
      edges.push(flowEdge(`src:${ip}`, aggId, true, animated));
    }
    destinations.forEach((d, i) => {
      nodes.push(destNode(d, i));
      const anyForward = universes.some((u) => resolvesForward(d, u.universe));
      if (anyForward) edges.push(flowEdge(aggId, `dst:${d.id}`, d.enabled, animated));
    });
    return { nodes, edges, simplified };
  }

  // 展开 Universe 节点
  universes.forEach((u, i) => {
    const uid = `uni:${u.universe}`;
    nodes.push({
      id: uid,
      type: "universe",
      position: { x: COL_X.universe, y: TOP + i * ROW_H },
      data: { universe: u.universe, sourceCount: u.sourceCount } satisfies UniverseNodeData,
    });
    for (const ip of u.sourceIps) {
      edges.push(flowEdge(`src:${ip}`, uid, true, animated));
    }
  });

  destinations.forEach((d, i) => {
    nodes.push(destNode(d, i));
    for (const u of universes) {
      if (resolvesForward(d, u.universe)) {
        edges.push(flowEdge(`uni:${u.universe}`, `dst:${d.id}`, d.enabled, animated));
      }
    }
  });

  return { nodes, edges, simplified };
}

function destNode(d: ForwardDestination, i: number): Node {
  return {
    id: `dst:${d.id}`,
    type: "destination",
    position: { x: COL_X.destination, y: TOP + i * ROW_H },
    data: {
      name: d.name,
      ip: d.targetIp,
      protocol: d.protocol,
      mode: d.mode,
      enabled: d.enabled,
    } satisfies DestinationNodeData,
  };
}

function flowEdge(source: string, target: string, enabled: boolean, animated: boolean): Edge {
  return {
    id: `${source}->${target}`,
    source,
    target,
    animated: enabled && animated,
    style: enabled
      ? { stroke: "var(--primary)", strokeWidth: 1.5 }
      : { stroke: "var(--muted-foreground)", strokeWidth: 1.5, strokeDasharray: "4 4" },
  };
}
