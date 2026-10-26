import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { netdevList, netdevRemove, netdevSave, netdevSetToken } from "../lib/api";
import { netKeys } from "../lib/queryKeys";
import type { NetDevice, NetDeviceInput } from "../lib/types";

const EMPTY: NetDevice[] = [];

/**
 * 已保存设备列表及增删改操作（操作成功后自动刷新列表）。
 *
 * # Returns
 *
 * 设备列表、加载状态与 `save` / `remove` / `setToken` 三个操作。
 */
export function useNetDevices() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: netKeys.devices, queryFn: netdevList });
  const refresh = useCallback(
    () => client.invalidateQueries({ queryKey: netKeys.devices }),
    [client],
  );

  const save = useCallback(
    async (input: NetDeviceInput) => {
      const saved = await netdevSave(input);
      await refresh();
      return saved;
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      await netdevRemove(id);
      client.removeQueries({ queryKey: netKeys.status(id) });
      await refresh();
    },
    [client, refresh],
  );

  const setToken = useCallback(
    async (id: string, token: string) => {
      await netdevSetToken(id, token);
      await refresh();
    },
    [refresh],
  );

  return {
    devices: query.data ?? EMPTY,
    isLoading: query.isLoading,
    refresh,
    save,
    remove,
    setToken,
  };
}
