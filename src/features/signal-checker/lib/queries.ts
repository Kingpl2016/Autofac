import { queryOptions } from "@tanstack/react-query";

import { getContext, listPatterns } from "./api";

/** 信号检测器的查询键前缀。 */
const ROOT = "signal-checker";

/** 查询键（组件里不要手写字面量数组）。 */
export const checkerKeys = {
  context: [ROOT, "context"] as const,
  patterns: [ROOT, "patterns"] as const,
  targets: [ROOT, "targets"] as const,
  frame: [ROOT, "frame"] as const,
  validate: [ROOT, "validate"] as const,
};

/** 图案目录：随软件版本固定，取一次即可。 */
export const patternsQuery = queryOptions({
  queryKey: checkerKeys.patterns,
  queryFn: listPatterns,
  staleTime: Number.POSITIVE_INFINITY,
});

/**
 * 运行环境快照（应用模式、接收网卡、转发表、本机地址）。会在主窗口里被改动，
 * 所以 2 秒后视为过期，窗口重新获得焦点时重取，并每 10 秒兜底刷新。
 */
export const contextQuery = queryOptions({
  queryKey: checkerKeys.context,
  queryFn: getContext,
  staleTime: 2000,
  refetchInterval: 10_000,
  retry: false,
});
