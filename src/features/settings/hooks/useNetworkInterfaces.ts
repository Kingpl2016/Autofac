import { useQuery } from "@tanstack/react-query";

import { listNetworkInterfaces } from "../lib/api";

/**
 * 查询本机网络接口列表。
 */
export function useNetworkInterfaces() {
  return useQuery({
    queryKey: ["network-interfaces"],
    queryFn: listNetworkInterfaces,
    staleTime: 30_000,
  });
}
