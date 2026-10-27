import { useQuery } from "@tanstack/react-query";

import { netdevPlayer, netdevStatus } from "../lib/api";
import { toNetError, type NetError } from "../lib/errors";
import { netKeys, PLAYER_POLL_MS, REBOOT_POLL_MS, STATUS_POLL_MS } from "../lib/queryKeys";
import type { DeviceStatus, PlayerStatus } from "../lib/types";

/** 设备在线判定：最近一次请求成功。 */
export interface DeviceStatusResult {
  status: DeviceStatus | null;
  /** 最近一次请求是否成功 */
  online: boolean;
  /** 最近一次失败的错误（成功后清空） */
  error: NetError | null;
  isLoading: boolean;
  refetch: () => void;
  /** 最近一次成功取到状态的时间（毫秒时间戳）；从未成功为 `null` */
  updatedAt?: number | null;
}

/**
 * 轮询设备状态（页面在后台时 react-query 自动暂停）。
 *
 * # Arguments
 *
 * * `id` - 设备 id；为空时不请求。
 * * `fast` - 等待设备重启回来时用更短的间隔探测。
 *
 * # Returns
 *
 * 状态快照、在线与否及最近错误。
 */
export function useDeviceStatus(id: string | null, fast = false): DeviceStatusResult {
  const query = useQuery({
    queryKey: netKeys.status(id),
    queryFn: () => netdevStatus(id as string),
    enabled: id !== null,
    refetchInterval: fast ? REBOOT_POLL_MS : STATUS_POLL_MS,
    retry: false,
    staleTime: 2000,
  });
  return {
    status: query.data ?? null,
    online: query.isSuccess,
    error: query.isError ? toNetError(query.error) : null,
    isLoading: query.isLoading,
    refetch: () => void query.refetch(),
    updatedAt: query.data ? query.dataUpdatedAt : null,
  };
}

/**
 * 轮询播放器状态（默认 1 秒）。
 *
 * # Arguments
 *
 * * `id` - 设备 id；为空时不请求。
 * * `enabled` - 额外开关，例如仅当指令 Tab 可见时才轮询。
 *
 * # Returns
 *
 * 播放器状态，尚未取得时为 `null`。
 */
export function usePlayer(id: string | null, enabled = true): PlayerStatus | null {
  const query = useQuery({
    queryKey: netKeys.player(id),
    queryFn: () => netdevPlayer(id as string),
    enabled: id !== null && enabled,
    refetchInterval: PLAYER_POLL_MS,
    retry: false,
  });
  return query.data ?? null;
}
