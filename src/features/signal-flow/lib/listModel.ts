import type { UniverseSnapshot } from "@/shared/domain/engine";
import { conflictLevel, type ConflictLevel, type MergeModeName } from "@/shared/lib/conflict";
import { compareIp } from "@/shared/lib/ip";
import type { ForwardDestination } from "@/features/forwarding/lib/types";
import {
  PLAYER_SOURCE_ID,
  linkActive,
  linkRate,
  protocolOf,
  resolvesForward,
  universeActive,
  type FlowProtocol,
} from "./activity";

/** 列表里一个 Universe 的来源。 */
export interface RowSource {
  ip: string;
  isPlayer: boolean;
  /** 该来源在此 Universe 上的包速率（pps）。 */
  packetRate: number;
  active: boolean;
}

/** 列表里一个 Universe 的去向。 */
export interface RowDestination {
  id: string;
  name: string;
  enabled: boolean;
  /** 目的地启用且此 Universe 正有信号。 */
  active: boolean;
}

/** “Universe 路径”表的一行：来源 → Universe → 目的地。 */
export interface UniverseRow {
  universe: number;
  active: boolean;
  packetRate: number;
  activeChannels: number;
  conflict: ConflictLevel;
  conflictChannels: number;
  protocol: FlowProtocol;
  sources: RowSource[];
  destinations: RowDestination[];
}

/** 汇总后的来源（跨 Universe）。 */
export interface ListSource {
  ip: string;
  isPlayer: boolean;
  packetRate: number;
  active: boolean;
  universeCount: number;
}

/** “目的地”表的一行。 */
export interface DestinationRow {
  id: string;
  name: string;
  ip: string;
  port: number;
  protocol: "artNet" | "sacn";
  mode: "all" | "selected";
  enabled: boolean;
  universeOffset: number;
  delayMs: number;
  sentRate: number;
  /** 启用且正有包发出。 */
  active: boolean;
  /** 会转发到该目的地的 Universe 数。 */
  universeCount: number;
}

/** 列表视图的数据。 */
export interface FlowList {
  rows: UniverseRow[];
  sources: ListSource[];
  destinations: DestinationRow[];
}

/** 构建列表所需的选项（与 `BuildOptions` 同名字段含义一致）。 */
export interface ListOptions {
  playerActive?: boolean;
  mergeMode?: MergeModeName;
  destStats?: ReadonlyMap<string, { sentRate: number }>;
}

/**
 * 把活跃 Universe 与转发目的地整理成表格数据，供键盘与读屏用户使用。
 *
 * 与节点图共用同一套“有信号”“是否转发”的判定，两种视图的结论一致；
 * 但列表不做聚合——Universe 再多也逐行列出，表格本身就适合承载大量数据。
 *
 * @param universes 活跃 Universe 快照。
 * @param destinations 转发目的地。
 * @param options 选项。
 * @returns Universe 路径行、汇总的来源与目的地行。
 */
export function buildFlowList(
  universes: readonly UniverseSnapshot[],
  destinations: readonly ForwardDestination[],
  options: ListOptions = {},
): FlowList {
  const playerActive = options.playerActive ?? false;
  const mergeMode = options.mergeMode ?? "htp";

  const rows: UniverseRow[] = universes.map((u) => {
    const active = universeActive(u, playerActive);
    return {
      universe: u.universe,
      active,
      packetRate: u.packetRate,
      activeChannels: u.activeChannels,
      conflict: conflictLevel(mergeMode, u.conflictChannels),
      conflictChannels: u.conflictChannels,
      protocol: protocolOf([u.protocol]),
      sources: [...u.sourceIps].sort(compareIp).map((ip) => ({
        ip,
        isPlayer: ip === PLAYER_SOURCE_ID,
        packetRate: linkRate(ip, u),
        active: linkActive(ip, u, playerActive),
      })),
      destinations: destinations
        .filter((d) => resolvesForward(d, u.universe))
        .map((d) => ({ id: d.id, name: d.name, enabled: d.enabled, active: d.enabled && active })),
    };
  });

  const bySource = new Map<string, UniverseSnapshot[]>();
  for (const u of universes) {
    for (const ip of u.sourceIps) {
      const list = bySource.get(ip);
      if (list) list.push(u);
      else bySource.set(ip, [u]);
    }
  }
  const sources: ListSource[] = [...bySource.keys()].sort(compareIp).map((ip) => {
    const list = bySource.get(ip) ?? [];
    return {
      ip,
      isPlayer: ip === PLAYER_SOURCE_ID,
      packetRate: list.reduce((sum, u) => sum + linkRate(ip, u), 0),
      active: list.some((u) => linkActive(ip, u, playerActive)),
      universeCount: list.length,
    };
  });

  const destRows: DestinationRow[] = destinations.map((d) => {
    const sentRate = options.destStats?.get(d.id)?.sentRate ?? 0;
    return {
      id: d.id,
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
      universeCount: universes.filter((u) => resolvesForward(d, u.universe)).length,
    };
  });

  return { rows, sources, destinations: destRows };
}