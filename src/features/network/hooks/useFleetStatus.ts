import { useQueries } from "@tanstack/react-query";

import { deriveLinkState, type LinkState } from "../lib/access";
import { netdevStatus } from "../lib/api";
import { toNetError, type NetError } from "../lib/errors";
import { netKeys, REBOOT_POLL_MS, STATUS_POLL_MS } from "../lib/queryKeys";
import type { DeviceStatus, NetDevice } from "../lib/types";
import { useDeviceSessionStore } from "../stores/useDeviceSessionStore";

/** 单台设备在机群视图里的快照。 */
export interface FleetEntry {
  link: LinkState;
  /** 最后一次成功取到的状态（离线后保留旧值） */
  status: DeviceStatus | null;
  error: NetError | null;
  /** 最近一次成功的时间；从未成功为 `null` */
  lastOkAt: number | null;
}

/**
 * 轮询全部已保存设备的状态（与单台设备的 `useDeviceStatus` 共用同一查询键，react-query 自动去重）。
 *
 * # Arguments
 *
 * * `devices` - 已保存设备。
 *
 * # Returns
 *
 * 设备 id → 快照。
 */
export function useFleetStatus(devices: readonly NetDevice[]): Map<string, FleetEntry> {
  const rebooting = useDeviceSessionStore((s) => s.rebooting);
  const results = useQueries({
    queries: devices.map((d) => ({
      queryKey: netKeys.status(d.id),
      queryFn: () => netdevStatus(d.id),
      refetchInterval: d.id in rebooting ? REBOOT_POLL_MS : STATUS_POLL_MS,
      retry: false,
      staleTime: 2000,
    })),
  });

  const map = new Map<string, FleetEntry>();
  devices.forEach((d, i) => {
    const q = results[i];
    const error = q?.isError ? toNetError(q.error) : null;
    map.set(d.id, {
      link: deriveLinkState({
        rebooting: d.id in rebooting,
        online: q?.isSuccess ?? false,
        errorCode: error?.code ?? null,
        loading: q?.isLoading ?? true,
      }),
      status: q?.data ?? null,
      error,
      lastOkAt: q?.data ? q.dataUpdatedAt : null,
    });
  });
  return map;
}
