import { create } from "zustand";
import { persist } from "zustand/middleware";

import { createTauriPersistStorage } from "@/shared/tauri/tauriStorage";

/** 最近文件最多记几个。 */
export const MAX_RECENT = 10;

/** 一个最近打开 / 保存过的节目。 */
export interface RecentFile {
  /** 路径：节目库里的 `.artrec`，或库外的 `.artshow` */
  path: string;
  kind: "library" | "external";
  /** 显示名（节目名，没有时取文件名） */
  name: string;
  /** 最近一次打开 / 保存的时间（毫秒时间戳） */
  openedAt: number;
}

/** 落盘的数据。 */
export interface RecentFilesData {
  items: RecentFile[];
}

interface RecentFilesState extends RecentFilesData {
  /**
   * 记一次打开 / 保存：同一路径移到最前，超过上限时丢掉最旧的。
   *
   * @param item 节目。
   */
  record: (item: RecentFile) => void;
  /**
   * 从列表里移除一项（例如文件已不存在）。
   *
   * @param path 路径。
   */
  remove: (path: string) => void;
  /** 清空列表。 */
  clear: () => void;
}

/**
 * 路径比较用的键（Windows 路径不区分大小写，分隔符统一）。
 *
 * @param path 路径。
 * @returns 规整后的键。
 */
export function recentKey(path: string): string {
  return path.trim().replaceAll("\\", "/").toLowerCase();
}

/**
 * 把一项放到列表最前（去重并截断）。
 *
 * @param items 现有列表（新的在前）。
 * @param item 新的一项。
 * @returns 新列表。
 */
export function pushRecent(items: readonly RecentFile[], item: RecentFile): RecentFile[] {
  const key = recentKey(item.path);
  return [item, ...items.filter((x) => recentKey(x.path) !== key)].slice(0, MAX_RECENT);
}

/**
 * 校验从磁盘读回的列表：字段不对的项丢弃，按时间从新到旧排列并截断。
 *
 * @param raw 磁盘上读到的未知数据。
 * @returns 一定合法的列表。
 */
export function sanitizeRecent(raw: unknown): RecentFilesData {
  const list = (raw as { items?: unknown } | null)?.items;
  if (!Array.isArray(list)) return { items: [] };
  const items = list.filter(
    (x): x is RecentFile =>
      !!x &&
      typeof x === "object" &&
      typeof (x as RecentFile).path === "string" &&
      (x as RecentFile).path.trim() !== "" &&
      ((x as RecentFile).kind === "library" || (x as RecentFile).kind === "external") &&
      typeof (x as RecentFile).name === "string" &&
      typeof (x as RecentFile).openedAt === "number" &&
      Number.isFinite((x as RecentFile).openedAt),
  );
  const sorted = [...items].sort((a, b) => b.openedAt - a.openedAt);
  return { items: sorted.reduce<RecentFile[]>((acc, x) => (acc.some((y) => recentKey(y.path) === recentKey(x.path)) ? acc : [...acc, x]), []).slice(0, MAX_RECENT) };
}

/**
 * 最近文件（文件菜单与空节目的预览区用），落盘到界面偏好文件（键 `editor-recent`）。
 */
export const useRecentFilesStore = create<RecentFilesState>()(
  persist(
    (set) => ({
      items: [],
      record: (item) => set((s) => ({ items: pushRecent(s.items, item) })),
      remove: (path) => set((s) => ({ items: s.items.filter((x) => recentKey(x.path) !== recentKey(path)) })),
      clear: () => set({ items: [] }),
    }),
    {
      name: "editor-recent",
      version: 1,
      storage: createTauriPersistStorage<RecentFilesData>(),
      partialize: ({ items }) => ({ items }),
      merge: (persisted, current) => (persisted == null ? current : { ...current, ...sanitizeRecent(persisted) }),
    },
  ),
);

/**
 * 路径里的文件名（不含扩展名），用作没有节目名时的显示名。
 *
 * @param path 路径。
 * @returns 文件名主干。
 */
export function fileStem(path: string): string {
  const base = path.replaceAll("\\", "/").split("/").pop() ?? path;
  return base.replace(/\.(artrec|artshow)(\.show)?$/i, "") || base;
}
