import { useQuery } from "@tanstack/react-query";

import { isTauri } from "@/shared/tauri/invoke";
import { playerOverview } from "../lib/api";
import type { Overview } from "../lib/types";

/**
 * 读取节目的时间线概览（后端按需生成并缓存到 sidecar）。
 *
 * 概览只依赖文件内容，因此以路径为键长期缓存；换节目自动重新请求。
 *
 * @param path 节目路径；为空时不请求。
 */
export function useOverview(path: string) {
  return useQuery<Overview>({
    queryKey: ["player-overview", path],
    queryFn: () => playerOverview(path),
    enabled: isTauri() && path !== "",
    staleTime: Infinity,
    gcTime: 5 * 60 * 1000,
    retry: false,
  });
}
