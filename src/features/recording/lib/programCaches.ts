import type { QueryClient } from "@tanstack/react-query";

import { RECORDINGS_QUERY_KEY } from "./api";

/** 时间线概览查询键前缀（`[前缀, 路径]`）。 */
export const OVERVIEW_QUERY_KEY = "player-overview";

/**
 * 节目库内容变化后刷新相关缓存：列表总是重新拉取；给出路径时丢弃该节目的概览缓存
 * （概览按路径长期缓存，原地替换节目后同一路径的旧概览已经不对）。
 *
 * @param client 查询客户端。
 * @param paths 内容被替换的节目路径。
 */
export function invalidateProgramCaches(client: QueryClient, ...paths: string[]): Promise<void> {
  for (const path of paths) client.removeQueries({ queryKey: [OVERVIEW_QUERY_KEY, path] });
  return client.invalidateQueries({ queryKey: RECORDINGS_QUERY_KEY });
}
