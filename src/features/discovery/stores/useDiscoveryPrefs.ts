import { z } from "zod";
import { create } from "zustand";
import { persist } from "zustand/middleware";

import { persistPrefs, prefsSanitizer } from "@/shared/stores/persistPrefs";
import {
  DEFAULT_SORT,
  type CategoryFilter,
  type SortDir,
  type SortKey,
  type StatusFilter,
} from "../lib/filters";

/** 落盘的偏好字段（搜索词与选中设备是临时状态，不保存）。 */
export interface DiscoveryPrefsData {
  category: CategoryFilter;
  status: StatusFilter;
  sort: { key: SortKey; dir: SortDir };
  /** 是否显示 MAC 列（窗口太窄或打开详情面板时仍会自动隐藏）。 */
  showMac: boolean;
}

interface DiscoveryPrefsState extends DiscoveryPrefsData {
  setCategory: (category: CategoryFilter) => void;
  setStatus: (status: StatusFilter) => void;
  setSort: (sort: { key: SortKey; dir: SortDir }) => void;
  setShowMac: (show: boolean) => void;
  /** 清除分类与状态筛选（保留排序）。 */
  clearFilters: () => void;
}

const CATEGORIES = ["all", "artNet", "sacn", "cluster", "computer", "network"] as const satisfies readonly CategoryFilter[];
const STATUSES = ["all", "online", "offline"] as const satisfies readonly StatusFilter[];
const SORT_KEYS = ["name", "ip", "status", "category", "ports"] as const satisfies readonly SortKey[];
const SORT_DIRS = ["asc", "desc"] as const satisfies readonly SortDir[];

/** 偏好默认值。 */
export const DEFAULT_PREFS: DiscoveryPrefsData = {
  category: "all",
  status: "all",
  sort: DEFAULT_SORT,
  showMac: true,
};

/** 落盘字段与兜底规则：任何字段不合法都回落默认值，避免旧版本文件或被手改的文件让页面进入无效状态。 */
const schema = z.object({
  category: z.enum(CATEGORIES).catch(DEFAULT_PREFS.category),
  status: z.enum(STATUSES).catch(DEFAULT_PREFS.status),
  sort: z
    .object({
      key: z.enum(SORT_KEYS).catch(DEFAULT_PREFS.sort.key),
      dir: z.enum(SORT_DIRS).catch(DEFAULT_PREFS.sort.dir),
    })
    .catch(DEFAULT_PREFS.sort),
  showMac: z.boolean().catch(DEFAULT_PREFS.showMac),
}) satisfies z.ZodType<DiscoveryPrefsData>;

/** 校验并规整从磁盘读回的偏好。 */
export const sanitizePrefs = prefsSanitizer(schema);

/**
 * 设备发现页的可保存偏好（分类 / 在线状态 / 排序 / MAC 列），经 Tauri Store 插件落盘到 `ui-prefs.json`。
 */
export const useDiscoveryPrefs = create<DiscoveryPrefsState>()(
  persist(
    (set) => ({
      ...DEFAULT_PREFS,
      setCategory: (category) => set({ category }),
      setStatus: (status) => set({ status }),
      setSort: (sort) => set({ sort }),
      setShowMac: (showMac) => set({ showMac }),
      clearFilters: () => set({ category: "all", status: "all" }),
    }),
    persistPrefs<DiscoveryPrefsState, DiscoveryPrefsData>({ name: "discovery", version: 1, schema }),
  ),
);
