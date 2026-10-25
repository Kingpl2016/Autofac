import { useQuery, useQueryClient } from "@tanstack/react-query";

import { isTauri } from "@/shared/tauri/invoke";
import { espApi, type EspConfig } from "../lib/api";

const FALLBACK: EspConfig = {
  host: "",
  tcpPort: 1227,
  httpPort: 80,
  connected: false,
};

/** 查询核心板连接状态。 */
export function useEspStatus() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["esp-status"],
    queryFn: espApi.getStatus,
    initialData: isTauri() ? undefined : FALLBACK,
  });
  const refresh = () => client.invalidateQueries({ queryKey: ["esp-status"] });
  return { status: query.data ?? FALLBACK, refresh };
}
