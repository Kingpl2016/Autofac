import { useQuery } from "@tanstack/react-query";

import { getAppInfo } from "../lib/api";

/**
 * 查询应用元信息。版本、系统等在进程生命周期内不会变化，因此永不过期、不重试。
 */
export function useAppInfo() {
  return useQuery({
    queryKey: ["app-info"],
    queryFn: getAppInfo,
    staleTime: Infinity,
    retry: false,
  });
}
