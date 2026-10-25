import { useQuery } from "@tanstack/react-query";

import { getFrame } from "../lib/api";
import { useSenderStore } from "../stores/useSenderStore";

/** 帧查询的缓存键前缀；手动设值后失效它即可立刻刷新栅格。 */
export const FRAME_QUERY_KEY = ["signal-checker", "frame"] as const;

/**
 * 读取某个 Universe 当前会发出的 512 通道内容。
 *
 * 发送中直接用后端推送的预览帧（约 9Hz）；未发送时向后端取一次（图案起点或手动数据），
 * 图案、模式或运行状态变化时自动重取。
 *
 * # Arguments
 *
 * * `universe` - 要查看的 Universe；`null` 表示没有可看的。
 *
 * # Returns
 *
 * 512 个通道值；还没取到时为 `undefined`。
 */
export function useUniverseFrame(universe: number | null): number[] | undefined {
  const mode = useSenderStore((s) => s.status?.mode);
  const pattern = useSenderStore((s) => s.status?.pattern);
  const running = useSenderStore((s) => s.status?.running ?? false);
  const preview = useSenderStore((s) => s.preview);

  const query = useQuery({
    queryKey: [...FRAME_QUERY_KEY, universe, mode, pattern, running],
    queryFn: () => getFrame(universe as number),
    enabled: universe !== null,
    staleTime: 0,
  });

  if (running && preview && preview.universe === universe) return preview.data;
  return query.data;
}
