import { create } from "zustand";

import type { Peaks } from "../lib/mediaApi";

/** 一个素材在本机上的运行时状态（不进工程、不进撤销历史）。 */
export interface MediaRuntime {
  /** 对应的文件路径：工程里的路径变化（重新链接）后，旧状态作废。 */
  path: string;
  /**
   * - `loading`：正在放行并计算波形；
   * - `ready`：可以播放；
   * - `missing`：文件不存在（被移动或删除），需要重新链接；
   * - `error`：文件在，但无法使用（格式不支持等）。
   */
  status: "loading" | "ready" | "missing" | "error";
  /** webview 可用的播放地址（`asset:` 协议）；`ready` 时才有 */
  url?: string;
  /** 当前系统的 webview 无法播放这种格式（仍可显示波形，但播放时不会出声 / 出画面） */
  unplayable?: boolean;
  /** 波形峰值；没有音轨或计算失败时为空 */
  peaks?: Peaks;
  /** 失败原因（后端错误码） */
  error?: string;
}

interface MediaStoreState {
  items: Record<string, MediaRuntime>;
  /**
   * 写入一个素材的运行时状态。
   *
   * @param id 素材 id。
   * @param runtime 新状态。
   */
  set: (id: string, runtime: MediaRuntime) => void;
  /**
   * 只保留这些 id 的状态，其余清除。
   *
   * @param ids 仍在工程里的素材 id。
   */
  retain: (ids: ReadonlySet<string>) => void;
  /** 清空（离开编辑器时）。 */
  reset: () => void;
}

/** 素材运行时状态：放行结果、播放地址、波形。 */
export const useMediaStore = create<MediaStoreState>((set) => ({
  items: {},
  set: (id, runtime) => set((s) => ({ items: { ...s.items, [id]: runtime } })),
  retain: (ids) =>
    set((s) => {
      const keys = Object.keys(s.items);
      if (keys.every((k) => ids.has(k))) return s;
      return { items: Object.fromEntries(Object.entries(s.items).filter(([k]) => ids.has(k))) };
    }),
  reset: () => set({ items: {} }),
}));
