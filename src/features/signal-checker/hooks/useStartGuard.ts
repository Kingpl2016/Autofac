import { useQueryClient } from "@tanstack/react-query";

import { startReasons, type StartReason } from "../lib/guard";
import { contextQuery, patternsQuery } from "../lib/queries";
import type { SignalConfig } from "../lib/types";
import { useCheckerFormStore } from "../stores/useCheckerFormStore";
import { useGuardStore } from "../stores/useGuardStore";

/**
 * 开始发送前的安全检查。
 *
 * # Returns
 *
 * `evaluate(config)`：取一份**最新**的运行环境（不用缓存——转发表和应用模式可能刚在主窗口里改过）
 * 和图案目录，返回需要用户确认的原因；环境取不到时按"非本机、无转发"保守判断，宁可多问一次。
 */
export function useStartGuard() {
  const client = useQueryClient();

  const evaluate = async (config: SignalConfig): Promise<StartReason[]> => {
    const [context, catalog] = await Promise.all([
      client.fetchQuery({ ...contextQuery, staleTime: 0 }).catch(() => undefined),
      client.fetchQuery(patternsQuery).catch(() => undefined),
    ]);
    const { mode, pattern } = useCheckerFormStore.getState();
    return startReasons({
      config,
      mode,
      flashing: catalog?.find((p) => p.id === pattern)?.isFlashing ?? false,
      context,
      strobeAcknowledged: useGuardStore.getState().strobeAcknowledged,
    });
  };

  return { evaluate };
}
