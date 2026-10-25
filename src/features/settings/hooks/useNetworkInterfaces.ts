import { useQuery } from "@tanstack/react-query";

import { isTauri } from "@/shared/tauri/invoke";
import { listNetworkInterfaces } from "../lib/api";
import type { NetworkInterface } from "../lib/types";

const FALLBACK: NetworkInterface[] = [
  { name: "全部接口", ip: "0.0.0.0", isLoopback: false },
];

/**
 * 查询本机网络接口列表（非 Tauri 环境返回回退项）。
 */
export function useNetworkInterfaces() {
  return useQuery({
    queryKey: ["network-interfaces"],
    queryFn: listNetworkInterfaces,
    initialData: isTauri() ? undefined : FALLBACK,
    staleTime: 30_000,
  });
}
