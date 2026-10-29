import { z } from "zod";
import { create } from "zustand";
import { persist } from "zustand/middleware";

import { persistPrefs, prefsSanitizer } from "@/shared/stores/persistPrefs";

/** 信号流页的展示形式：节点图或列表。 */
export type FlowViewMode = "graph" | "list";

/** 落盘的偏好字段。 */
export interface SignalFlowPrefsData {
  /** Universe 数达到该值时聚合显示。 */
  simplifyThreshold: number;
  view: FlowViewMode;
}

interface SignalFlowPrefsState extends SignalFlowPrefsData {
  setSimplifyThreshold: (n: number) => void;
  setView: (view: FlowViewMode) => void;
}

/** 简化阈值的默认值与取值范围。 */
export const DEFAULT_SIMPLIFY_THRESHOLD = 50;
export const MIN_SIMPLIFY_THRESHOLD = 1;
export const MAX_SIMPLIFY_THRESHOLD = 9999;

/**
 * 把输入规整为合法的简化阈值：取整并限制在 1 到 9999；非数值回落默认值。
 *
 * @param n 用户输入或磁盘上读到的值。
 * @returns 合法阈值。
 */
export function clampThreshold(n: unknown): number {
  const v = typeof n === "number" ? Math.round(n) : Number.NaN;
  if (!Number.isFinite(v)) return DEFAULT_SIMPLIFY_THRESHOLD;
  return Math.min(MAX_SIMPLIFY_THRESHOLD, Math.max(MIN_SIMPLIFY_THRESHOLD, v));
}

/** 偏好默认值。 */
export const DEFAULT_SIGNAL_FLOW_PREFS: SignalFlowPrefsData = {
  simplifyThreshold: DEFAULT_SIMPLIFY_THRESHOLD,
  view: "graph",
};

/** 落盘字段与兜底规则。 */
const schema = z.object({
  simplifyThreshold: z.number().catch(DEFAULT_SIMPLIFY_THRESHOLD).transform(clampThreshold),
  view: z.enum(["graph", "list"]).catch(DEFAULT_SIGNAL_FLOW_PREFS.view),
}) satisfies z.ZodType<SignalFlowPrefsData>;

/** 校验并规整从磁盘读回的偏好：不合法的字段回落到默认值。 */
export const sanitizeSignalFlowPrefs = prefsSanitizer(schema);

/**
 * 信号流页的可保存偏好（简化阈值、图 / 列表视图），经 Tauri Store 插件落盘到 `ui-prefs.json`。
 */
export const useSignalFlowPrefs = create<SignalFlowPrefsState>()(
  persist(
    (set) => ({
      ...DEFAULT_SIGNAL_FLOW_PREFS,
      setSimplifyThreshold: (n) => set({ simplifyThreshold: clampThreshold(n) }),
      setView: (view) => set({ view }),
    }),
    persistPrefs<SignalFlowPrefsState, SignalFlowPrefsData>({ name: "signalFlow", version: 1, schema }),
  ),
);
