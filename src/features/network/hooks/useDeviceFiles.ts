import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { netdevListFiles } from "../lib/api";
import { netKeys } from "../lib/queryKeys";
import type { NetFile } from "../lib/types";

const EMPTY: NetFile[] = [];

/**
 * 读取设备 SD 卡文件列表。不轮询（文件只在用户操作后变化），窗口重新聚焦时自动刷新。
 *
 * # Arguments
 *
 * * `id` - 设备 id；为空时不请求。
 * * `enabled` - 额外开关，设备离线 / 需要 Token 时关闭。
 *
 * # Returns
 *
 * 文件列表、加载 / 错误状态与 `refresh`。
 */
export function useDeviceFiles(id: string | null, enabled: boolean) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: netKeys.files(id),
    queryFn: () => netdevListFiles(id as string),
    enabled: id !== null && enabled,
    retry: false,
  });
  const refresh = useCallback(
    () => client.invalidateQueries({ queryKey: netKeys.files(id) }),
    [client, id],
  );
  return {
    files: query.data ?? EMPTY,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    refresh,
  };
}
