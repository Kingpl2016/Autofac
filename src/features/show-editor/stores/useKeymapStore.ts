import { create } from "zustand";
import { persist } from "zustand/middleware";

import { createTauriPersistStorage } from "@/shared/tauri/tauriStorage";
import { parseChord, type KeymapOverrides } from "../lib/commands";

/** 落盘的快捷键自定义。 */
export interface KeymapData {
  overrides: Record<string, string[]>;
}

interface KeymapState extends KeymapData {
  /**
   * 设置某个命令的快捷键（空数组表示不用快捷键）。
   *
   * @param commandId 命令 id。
   * @param chords 快捷键列表。
   */
  setKeys: (commandId: string, chords: string[]) => void;
  /**
   * 恢复某个命令（省略时为全部）的默认快捷键。
   *
   * @param commandId 命令 id。
   */
  reset: (commandId?: string) => void;
}

/**
 * 校验并规整从磁盘读回的自定义：非法的 chord 丢弃。
 *
 * @param raw 磁盘上读到的未知数据。
 * @returns 一定合法的自定义。
 */
export function sanitizeKeymap(raw: unknown): KeymapData {
  const overrides: Record<string, string[]> = {};
  const source = (raw as { overrides?: unknown } | null)?.overrides;
  if (source && typeof source === "object") {
    for (const [id, keys] of Object.entries(source as Record<string, unknown>)) {
      if (!Array.isArray(keys)) continue;
      overrides[id] = keys.filter((k): k is string => typeof k === "string").map(parseChord).filter(Boolean);
    }
  }
  return { overrides };
}

/**
 * 编辑器快捷键的用户自定义（默认方案见各命令的 `keys`，与剪映一致），落盘到界面偏好文件。
 */
export const useKeymapStore = create<KeymapState>()(
  persist(
    (set) => ({
      overrides: {},
      setKeys: (commandId, chords) =>
        set((s) => ({ overrides: { ...s.overrides, [commandId]: chords.map(parseChord).filter(Boolean) } })),
      reset: (commandId) =>
        set((s) => {
          if (!commandId) return { overrides: {} };
          const { [commandId]: _gone, ...rest } = s.overrides;
          void _gone;
          return { overrides: rest };
        }),
    }),
    {
      name: "editor-keymap",
      version: 1,
      storage: createTauriPersistStorage<KeymapData>(),
      partialize: ({ overrides }) => ({ overrides }),
      merge: (persisted, current) => (persisted == null ? current : { ...current, ...sanitizeKeymap(persisted) }),
    },
  ),
);

/**
 * 当前的快捷键自定义（非 React 场景读取）。
 *
 * @returns 自定义表。
 */
export function currentOverrides(): KeymapOverrides {
  return useKeymapStore.getState().overrides;
}
