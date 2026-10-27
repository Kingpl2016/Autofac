import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";

import type { Protocol } from "@/shared/domain/engine";
import { createTauriPersistStorage } from "@/shared/tauri/tauriStorage";
import {
  ALL_PROTOCOLS,
  EMPTY_PRESET,
  MAX_INDEX,
  MAX_TEMPLATE_LENGTH,
  sanitizePreset,
  type RecordingPreset,
} from "../lib/recordingPreset";

interface RecordingPresetState extends RecordingPreset {
  /**
   * 是否启用 sACN（不落盘）。由录制运行时从设置同步过来，
   * 让顶栏按钮与全局快捷键这些拿不到设置查询的入口也能得到同样的过滤条件。
   */
  sacnEnabled: boolean;
  setSacnEnabled: (on: boolean) => void;
  toggleSource: (ip: string) => void;
  setExcludeSources: (on: boolean) => void;
  setUniverseTokens: (tokens: string[]) => void;
  setExtraTokens: (tokens: string[]) => void;
  /** 切换某个协议；至少保留一个 */
  toggleProtocol: (p: Protocol) => void;
  setNameTemplate: (template: string) => void;
  /** 一次录制成功开始后序号加一 */
  advanceIndex: () => void;
  /** 序号回到 1 */
  resetIndex: () => void;
  /** 清除全部过滤条件（恢复为全量采集），名称模板与序号保留 */
  resetFilters: () => void;
}

/** 落盘字段。 */
function pickPreset(s: RecordingPreset): RecordingPreset {
  return {
    sources: s.sources,
    excludeSources: s.excludeSources,
    universeTokens: s.universeTokens,
    extraTokens: s.extraTokens,
    protocols: s.protocols,
    nameTemplate: s.nameTemplate,
    nextIndex: s.nextIndex,
  };
}

/**
 * 当前录制预设，经 Tauri Store 插件持久化到 `ui-prefs.json`（键 `recordingPreset`）。
 * 录制页、顶栏录制按钮与全局快捷键都按这一份预设开始录制。
 */
export const useRecordingPresetStore = create<RecordingPresetState>()(
  persist<RecordingPresetState, [], [], RecordingPreset>(
    (set) => ({
      ...EMPTY_PRESET,
      sacnEnabled: false,
      setSacnEnabled: (sacnEnabled) => set({ sacnEnabled }),
      toggleSource: (ip) =>
        set((s) => ({
          sources: s.sources.includes(ip) ? s.sources.filter((x) => x !== ip) : [...s.sources, ip],
        })),
      setExcludeSources: (excludeSources) => set({ excludeSources }),
      setUniverseTokens: (universeTokens) => set({ universeTokens }),
      setExtraTokens: (extraTokens) => set({ extraTokens }),
      toggleProtocol: (p) =>
        set((s) => {
          const next = s.protocols.includes(p)
            ? s.protocols.filter((x) => x !== p)
            : ALL_PROTOCOLS.filter((x) => x === p || s.protocols.includes(x));
          return next.length > 0 ? { protocols: next } : {};
        }),
      setNameTemplate: (template) => set({ nameTemplate: template.slice(0, MAX_TEMPLATE_LENGTH) }),
      advanceIndex: () => set((s) => ({ nextIndex: s.nextIndex >= MAX_INDEX ? 1 : s.nextIndex + 1 })),
      resetIndex: () => set({ nextIndex: 1 }),
      resetFilters: () =>
        set({
          sources: [],
          excludeSources: false,
          universeTokens: [],
          extraTokens: [],
          protocols: [...ALL_PROTOCOLS],
        }),
    }),
    {
      name: "recordingPreset",
      version: 1,
      storage: createTauriPersistStorage<RecordingPreset>(),
      partialize: pickPreset,
      // 没有已保存数据（首次运行 / 读取失败）时保持当前值
      merge: (persisted, current) =>
        persisted == null
          ? current
          : { ...current, ...sanitizePreset(persisted, pickPreset(current)) },
    },
  ),
);

/**
 * 读取当前预设（非响应式，供无界面上下文使用）。
 *
 * @returns 预设与当前的 sACN 开关。
 */
export function getRecordingPreset(): { preset: RecordingPreset; sacnEnabled: boolean } {
  const s = useRecordingPresetStore.getState();
  return { preset: pickPreset(s), sacnEnabled: s.sacnEnabled };
}

/**
 * 订阅当前预设（浅比较，只有预设字段变化才重渲染）。
 *
 * @returns 预设。
 */
export function useRecordingPreset(): RecordingPreset {
  return useRecordingPresetStore(useShallow(pickPreset));
}
