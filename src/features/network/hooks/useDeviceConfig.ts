import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { netdevGetConfig, netdevPutConfig } from "../lib/api";
import { netKeys } from "../lib/queryKeys";
import type { ConfigPatch, ConfigResult, DeviceConfig } from "../lib/types";

/**
 * 读取设备配置，并提供写入补丁的方法（成功后刷新缓存）。
 *
 * 配置变化很少，不做轮询；是否启用由 `enabled` 控制（设备离线时不请求）。
 *
 * # Arguments
 *
 * * `id` - 设备 id；为空时不请求。
 * * `enabled` - 额外开关。
 *
 * # Returns
 *
 * 配置、加载状态、错误与 `save` / `refetch`。
 */
export function useDeviceConfig(id: string | null, enabled = true) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: netKeys.config(id),
    queryFn: () => netdevGetConfig(id as string),
    enabled: id !== null && enabled,
    retry: false,
    staleTime: 30_000,
  });

  const save = useCallback(
    async (patch: ConfigPatch): Promise<ConfigResult> => {
      const result = await netdevPutConfig(id as string, patch);
      await client.invalidateQueries({ queryKey: netKeys.config(id) });
      return result;
    },
    [client, id],
  );

  return {
    config: (query.data ?? null) as DeviceConfig | null,
    isLoading: query.isLoading,
    error: query.error,
    save,
    refetch: () => void query.refetch(),
  };
}
