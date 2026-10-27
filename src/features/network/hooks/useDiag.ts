import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { netdevDiag } from "../lib/api";
import { pushSample, toSample, type DiagSample } from "../lib/diag";
import { netKeys } from "../lib/queryKeys";

/** 诊断轮询间隔（毫秒）。 */
const DIAG_POLL_MS = 2000;

/**
 * 轮询设备诊断并累积最近的采样点（用于迷你折线）。
 *
 * 轮询只在 `enabled` 为真时进行（诊断分段可见 + 设备可读）；页面在后台时 react-query 自动暂停。
 *
 * # Arguments
 *
 * * `id` - 设备 id；为空时不请求。
 * * `enabled` - 额外开关。
 *
 * # Returns
 *
 * 最新诊断、采样历史、错误与手动刷新。
 */
export function useDiag(id: string | null, enabled: boolean) {
  const query = useQuery({
    queryKey: netKeys.diag(id),
    queryFn: () => netdevDiag(id as string),
    enabled: id !== null && enabled,
    refetchInterval: DIAG_POLL_MS,
    retry: false,
  });

  // 在渲染期按数据更新时间累积采样：React 推荐的"由 props/查询结果派生状态"写法，
  // 比在 effect 里 setState 少一次多余渲染。
  const [hist, setHist] = useState<{ stamp: number; samples: DiagSample[] }>({ stamp: 0, samples: [] });
  if (query.data && query.dataUpdatedAt !== hist.stamp) {
    setHist({
      stamp: query.dataUpdatedAt,
      samples: pushSample(hist.samples, toSample(query.data, query.dataUpdatedAt)),
    });
  }

  return {
    diag: query.data ?? null,
    samples: hist.samples,
    error: query.error,
    isLoading: query.isLoading,
    refetch: () => void query.refetch(),
    /** 最近一次成功取到诊断的时间；没有为 `null` */
    updatedAt: query.data ? query.dataUpdatedAt : null,
  };
}
