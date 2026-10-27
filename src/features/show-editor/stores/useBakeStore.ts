import { create } from "zustand";

/** 后端 `show:bake` 事件载荷：保存后在后台把工程烘焙成 `.artrec` 的进度与结果。 */
export interface BakeEvent {
  /** 节目的 `.artrec` 路径 */
  path: string;
  status: "running" | "done" | "failed" | "skipped";
  /** 0~1 */
  progress: number;
  frames: number | null;
  bytes: number | null;
  /** 失败 / 跳过的原因：`nothing_to_bake`、`in_use`、`invalid_project` 或系统描述 */
  reason: string | null;
}

/** 事件名。 */
export const SHOW_BAKE_EVENT = "show:bake";

interface BakeStoreState {
  /** 正在烘焙的节目（路径 → 进度）。 */
  running: Record<string, number>;
  /**
   * 吸收一条事件。
   *
   * @param event 后端推送的烘焙事件。
   */
  apply: (event: BakeEvent) => void;
  /** 清空（离开编辑器时）。 */
  reset: () => void;
}

/** 后台烘焙的进行中状态；结果（完成 / 失败）由事件监听器以 toast 报告，不在这里保留。 */
export const useBakeStore = create<BakeStoreState>((set) => ({
  running: {},
  apply: (event) =>
    set((s) => {
      const running = { ...s.running };
      if (event.status === "running") running[event.path] = event.progress;
      else delete running[event.path];
      return { running };
    }),
  reset: () => set({ running: {} }),
}));
