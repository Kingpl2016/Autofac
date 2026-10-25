import { useQuery } from "@tanstack/react-query";

import { getContext } from "../lib/api";

/** 运行环境快照的缓存键。 */
export const CONTEXT_QUERY_KEY = ["signal-checker", "context"] as const;

/**
 * 运行环境快照（应用模式、接收网卡、转发表、本机地址）。
 *
 * 这些信息会在主窗口里被改动（切换模式、编辑转发表、改接收网卡），所以窗口重新获得焦点时重取，
 * 并且每 10 秒兜底刷新一次。取不到时为 `undefined`，调用方按"信息未知"处理。
 */
export function useCheckerContext() {
  return useQuery({
    queryKey: CONTEXT_QUERY_KEY,
    queryFn: getContext,
    staleTime: 2000,
    refetchInterval: 10_000,
    retry: false,
  });
}
