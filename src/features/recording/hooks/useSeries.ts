import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { playerSeries } from "../lib/api";
import type { ChannelSeries } from "../lib/types";

interface UseSeriesParams {
  /** 节目路径 */
  path: string;
  /** Universe 编号；为 null 时不请求 */
  universe: number | null;
  /** 通道号（0 起） */
  channels: number[];
  /** 区间起点（微秒） */
  t0Us: number;
  /** 区间终点（微秒） */
  t1Us: number;
  /** 最大点数 */
  maxPoints: number;
}

/**
 * 查询选定通道的降采样曲线。
 *
 * 参数变化时保留上一次结果直到新结果到达，拖动窗口或改通道时曲线不会闪烁。
 */
export function useSeries(p: UseSeriesParams) {
  const enabled =
    p.path !== "" && p.universe !== null && p.channels.length > 0 && p.maxPoints > 0;
  return useQuery<ChannelSeries[]>({
    queryKey: [
      "player-series",
      p.path,
      p.universe,
      p.channels.join(","),
      p.t0Us,
      p.t1Us,
      p.maxPoints,
    ],
    queryFn: () =>
      playerSeries({
        path: p.path,
        universe: p.universe ?? 0,
        channels: p.channels,
        t0Us: p.t0Us,
        t1Us: p.t1Us,
        maxPoints: p.maxPoints,
      }),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: false,
  });
}
