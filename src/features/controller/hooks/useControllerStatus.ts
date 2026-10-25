import { useQuery, useQueryClient } from "@tanstack/react-query";

import { isTauri } from "@/shared/tauri/invoke";
import { controllerApi, type ControllerConfig } from "../lib/api";

const FALLBACK: ControllerConfig = {
  host: "",
  tcpPort: 1227,
  httpPort: 80,
  connected: false,
};

/** 查询核心板连接状态。 */
export function useControllerStatus() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["controller-status"],
    queryFn: controllerApi.getStatus,
    initialData: isTauri() ? undefined : FALLBACK,
  });
  const refresh = () => client.invalidateQueries({ queryKey: ["controller-status"] });
  return { status: query.data ?? FALLBACK, refresh };
}
