import type { UniverseSnapshot } from "@/shared/domain/engine";
import type { ForwardDestination } from "@/features/forwarding/lib/types";
import type { PlaybackStatus } from "@/features/recording";
import { PLAYER_SOURCE_ID } from "./graphModel";

/** 回放直发目标在图中使用的目的地 ID。 */
export const PLAYER_DIRECT_ID = "player-direct";

/**
 * 回放期间的 Universe 快照：实时接收已暂停，图上改为展示节目里的 Universe，
 * 它们的唯一来源是回放源节点。
 *
 * @param status 回放状态。
 */
export function playerUniverses(status: PlaybackStatus): UniverseSnapshot[] {
  return status.universes.map((universe) => ({
    universe,
    protocol: "artNet",
    sourceIps: [PLAYER_SOURCE_ID],
    sourceCount: 1,
    activeChannels: 0,
    conflictChannels: 0,
    totalPackets: 0,
  }));
}

/**
 * 回放期间的目的地：走转发表时沿用转发表；直发时只显示该直发目标。
 *
 * @param status 回放状态。
 * @param forwarding 转发表里的目的地。
 */
export function playerDestinations(
  status: PlaybackStatus,
  forwarding: ForwardDestination[],
): ForwardDestination[] {
  if (status.target.kind !== "direct") return forwarding;
  return [
    {
      id: PLAYER_DIRECT_ID,
      name: status.target.ip,
      targetIp: status.target.ip,
      protocol: status.target.protocol,
      port: status.target.port,
      mode: "all",
      universeOffset: 0,
      defaultDelayMs: 0,
      description: "",
      enabled: true,
      overrides: [],
    },
  ];
}
