import { create } from "zustand";
import { persist } from "zustand/middleware";

import { createTauriPersistStorage } from "@/shared/tauri/tauriStorage";
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
}

interface DiscoveryPrefsState extends DiscoveryPrefsData {
  setCategory: (category: CategoryFilter) => void;
  setStatus: (status: StatusFilter) => void;
  setSort: (sort: { key: SortKey; dir: SortDir }) => void;
  /** 清除分类与状态筛选（保留排序）。 */
  clearFilters: () => void;
}

const CATEGORIES: readonly CategoryFilter[] = [
  "all",
  "artNet",
  "sacn",
  "cluster",
  "computer",
  "network",
];
const STATUSES: readonly StatusFilter[] = ["all", "online", "offline"];
const SORT_KEYS: readonly SortKey[] = ["name", "ip", "status", "category", "ports"];
const SORT_DIRS: readonly SortDir[] = ["asc", "desc"];

/** 偏好默认值。 */
export const DEFAULT_PREFS: DiscoveryPrefsData = {
  category: "all",
  status: "all",
  sort: DEFAULT_SORT,
};

/**
 * 校验并规整从磁盘读回的偏好：任何字段不合法都回落到默认值，
 * 避免旧版本文件或被手改的文件让页面进入无效状态。
 *
 * @param raw 磁盘上读到的未知数据。
 * @returns 一定合法的偏好数据。
 */
export function sanitizePrefs(raw: unknown): DiscoveryPrefsData {
  const r = (raw ?? {}) as Partial<Record<keyof DiscoveryPrefsData, unknown>>;
  const sort = (r.sort ?? {}) as { key?: unknown; dir?: unknown };
  return {
    category: CATEGORIES.includes(r.category as CategoryFilter)
      ? (r.category as CategoryFilter)
      : DEFAULT_PREFS.category,
    status: STATUSES.includes(r.status as StatusFilter)
      ? (r.status as StatusFilter)
      : DEFAULT_PREFS.status,
    sort: {
      key: SORT_KEYS.includes(sort.key as SortKey)
        ? (sort.key as SortKey)
        : DEFAULT_PREFS.sort.key,
      dir: SORT_DIRS.includes(sort.dir as SortDir)
        ? (sort.dir as SortDir)
        : DEFAULT_PREFS.sort.dir,
    },
  };
}

/**
 * 设备发现页的可保存偏好（分类 / 在线状态 / 排序），经 Tauri Store 插件落盘到
 * `ui-prefs.json`；非 Tauri 环境回退 `localStorage`。
 */
export const useDiscoveryPrefs = create<DiscoveryPrefsState>()(
  persist(
    (set) => ({
      ...DEFAULT_PREFS,
      setCategory: (category) => set({ category }),
      setStatus: (status) => set({ status }),
      setSort: (sort) => set({ sort }),
      clearFilters: () => set({ category: "all", status: "all" }),
    }),
    {
      name: "discovery",
      version: 1,
      storage: createTauriPersistStorage<DiscoveryPrefsData>(),
      partialize: ({ category, status, sort }) => ({ category, status, sort }),
      // 没有已保存的数据（首次运行 / 读取失败）时保持当前值，不被默认值覆盖
      merge: (persisted, current) =>
        persisted == null ? current : { ...current, ...sanitizePrefs(persisted) },
    },
  ),
);
