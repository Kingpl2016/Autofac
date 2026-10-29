import type { Edge, Node } from "@xyflow/react";

import type { UniverseSnapshot } from "@/shared/domain/engine";
import { conflictLevel, type ConflictLevel, type MergeModeName } from "@/shared/lib/conflict";
import { compareIp } from "@/shared/lib/ip";
import type { ForwardDestination } from "@/features/forwarding";
import {
  PLAYER_SOURCE_ID,
  linkActive,
  linkRate,
  protocolOf,
  resolvesForward,
  universeActive,
  type FlowProtocol,
} from "./activity";

/** 列 x 坐标。 */
export const COL_X = { source: 0, universe: 380, destination: 760 };
/** 行间距。 */
export const ROW_H = 96;
const TOP = 16;


/** 源节点数据。 */
export interface SourceNodeData extends Record<string, unknown> {
  ip: string;
  universeCount: number;
  /** 该来源在所有 Universe 上的包速率合计（pps）。 */
  packetRate: number;
  protocol: FlowProtocol;
  /** 是否正有信号。 */
  active: boolean;
}
/** 回放源节点数据。 */
export interface PlayerNodeData extends Record<string, unknown> {
  name: string;
  universeCount: number;
  active: boolean;
}
/** Universe 节点数据（含聚合态）。 */
export interface UniverseNodeData extends Record<string, unknown> {
  universe: number;
  sourceCount: number;
  packetRate: number;
  activeChannels: number;
  conflictChannels: number;
  conflict: ConflictLevel;
  protocol: FlowProtocol;
  active: boolean;
  aggregate?: boolean;
  /** 聚合态：被合并的 Universe 总数。 */
  totalUniverses?: number;
  /** 聚合态：其中有信号的 Universe 数。 */
  activeUniverses?: number;
}
/** 目的地节点数据。 */
export interface DestinationNodeData extends Record<string, unknown> {
  name: string;
  ip: string;
  port: number;
  protocol: "artNet" | "sacn";
  mode: "all" | "selected";
  enabled: boolean;
  universeOffset: number;
  /** 默认延迟（毫秒），0 表示不延迟。 */
  delayMs: number;
  /** 实际发出的包速率（pps），来自输出统计。 */
  sentRate: number;
  /** 启用且正有包发出。 */
  active: boolean;
}
/** 边数据。 */
export interface FlowEdgeData extends Record<string, unknown> {
  /** 边上正有信号流动。 */
  active: boolean;
  /** 目的地被停用（无论有无信号都画成虚线）。 */
  disabled: boolean;
}

/** 构图选项。 */
export interface BuildOptions {
  /** Universe 数达到该值时切换为聚合显示。 */
  simplifyThreshold: number;
  /** 回放节目名；源里出现回放伪 IP 时用它显示“回放源”节点。 */
  playerName?: string;
  /** 回放是否正在播放：回放的虚拟 Universe 没有速率，靠它判定“有信号”。 */
  playerActive?: boolean;
  /** 当前合并模式，决定冲突级别。 */
  mergeMode?: MergeModeName;
  /** 各目的地的运行时统计（键为目的地 id）。 */
  destStats?: ReadonlyMap<string, { sentRate: number }>;
}

/** 构图结果。 */
export interface FlowGraph {
  nodes: Node[];
  edges: Edge[];
  simplified: boolean;
}


/**
 * 由活跃 Universe 快照与转发目的地派生信号流图。
 *
 * “有信号”的判定：来源 / Universe 看包速率是否大于 0（回放源看是否正在播放），
 * 目的地看输出统计里的发送速率；边上有信号取决于其上游是否有信号且目的地启用。
 *
 * @param universes 活跃 Universe 快照。
 * @param destinations 转发目的地。
 * @param options 构图选项。
 * @returns React Flow 的 nodes 与 edges，以及是否处于聚合态。
 */
export function buildGraph(
  universes: readonly UniverseSnapshot[],
  destinations: readonly ForwardDestination[],
  options: BuildOptions,
): FlowGraph {
  const { simplifyThreshold, playerName = "", playerActive = false, destStats } = options;
  const mergeMode = options.mergeMode ?? "htp";
  const simplified = universes.length >= simplifyThreshold;
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  const isActive = (u: UniverseSnapshot) => universeActive(u, playerActive);
  const isLinkActive = (ip: string, u: UniverseSnapshot) => linkActive(ip, u, playerActive);

  // 源节点（唯一 IP）
  const sourceUniverses = new Map<string, UniverseSnapshot[]>();
  for (const u of universes) {
    for (const ip of u.sourceIps) {
      const list = sourceUniverses.get(ip);
      if (list) list.push(u);
      else sourceUniverses.set(ip, [u]);
    }
  }
  const sourceIps = [...sourceUniverses.keys()].sort(compareIp);
  sourceIps.forEach((ip, i) => {
    const list = sourceUniverses.get(ip) ?? [];
    const active = list.some((u) => isLinkActive(ip, u));
    const isPlayer = ip === PLAYER_SOURCE_ID;
    nodes.push({
      id: `src:${ip}`,
      type: isPlayer ? "player" : "source",
      position: { x: COL_X.source, y: TOP + i * ROW_H },
      data: isPlayer
        ? ({ name: playerName, universeCount: list.length, active } satisfies PlayerNodeData)
        : ({
            ip,
            universeCount: list.length,
            packetRate: list.reduce((sum, u) => sum + linkRate(ip, u), 0),
            protocol: protocolOf(list.map((u) => u.protocol)),
            active,
          } satisfies SourceNodeData),
    });
  });

  const destNode = (d: ForwardDestination, i: number): Node => {
    const sentRate = destStats?.get(d.id)?.sentRate ?? 0;
    return {
      id: `dst:${d.id}`,
      type: "destination",
      position: { x: COL_X.destination, y: TOP + i * ROW_H },
      data: {
        name: d.name,
        ip: d.targetIp,
        port: d.port,
        protocol: d.protocol,
        mode: d.mode,
        enabled: d.enabled,
        universeOffset: d.universeOffset,
        delayMs: d.defaultDelayMs,
        sentRate,
        active: d.enabled && sentRate > 0,
      } satisfies DestinationNodeData,
    };
  };

  if (simplified) {
    // 聚合 Universe 节点
    const aggId = "uni:agg";
    const activeUniverses = universes.filter(isActive).length;
    nodes.push({
      id: aggId,
      type: "universe",
      position: { x: COL_X.universe, y: TOP + Math.max(0, (sourceIps.length - 1) / 2) * ROW_H },
      data: {
        universe: 0,
        sourceCount: sourceIps.length,
        packetRate: universes.reduce((sum, u) => sum + u.packetRate, 0),
        activeChannels: universes.reduce((sum, u) => sum + u.activeChannels, 0),
        conflictChannels: 0,
        conflict: "none",
        protocol: protocolOf(universes.map((u) => u.protocol)),
        active: activeUniverses > 0,
        aggregate: true,
        totalUniverses: universes.length,
        activeUniverses,
      } satisfies UniverseNodeData,
    });
    for (const ip of sourceIps) {
      const list = sourceUniverses.get(ip) ?? [];
      edges.push(flowEdge(`src:${ip}`, aggId, list.some((u) => isLinkActive(ip, u)), false));
    }
    destinations.forEach((d, i) => {
      nodes.push(destNode(d, i));
      const forwarded = universes.filter((u) => resolvesForward(d, u.universe));
      if (forwarded.length > 0) {
        const active = d.enabled && forwarded.some(isActive);
        edges.push(flowEdge(aggId, `dst:${d.id}`, active, !d.enabled));
      }
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
      data: {
        universe: u.universe,
        sourceCount: u.sourceCount,
        packetRate: u.packetRate,
        activeChannels: u.activeChannels,
        conflictChannels: u.conflictChannels,
        conflict: conflictLevel(mergeMode, u.conflictChannels),
        protocol: protocolOf([u.protocol]),
        active: isActive(u),
      } satisfies UniverseNodeData,
    });
    for (const ip of u.sourceIps) {
      edges.push(flowEdge(`src:${ip}`, uid, isLinkActive(ip, u), false));
    }
  });

  destinations.forEach((d, i) => {
    nodes.push(destNode(d, i));
    for (const u of universes) {
      if (resolvesForward(d, u.universe)) {
        edges.push(
          flowEdge(`uni:${u.universe}`, `dst:${d.id}`, d.enabled && isActive(u), !d.enabled),
        );
      }
    }
  });

  return { nodes, edges, simplified };
}

function flowEdge(source: string, target: string, active: boolean, disabled: boolean): Edge {
  return {
    id: `${source}->${target}`,
    source,
    target,
    type: "flow",
    data: { active, disabled } satisfies FlowEdgeData,
  };
}