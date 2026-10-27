import { create } from "zustand";

import type { Look } from "../lib/project";

interface ProgrammerState {
  /** 编程器内容：灯具 id → 外观（只写“参与”的层） */
  values: Record<string, Look>;
  /** 实时输出：编程器覆盖整个节目推给后端（灯会立刻亮成编程器的样子） */
  live: boolean;
  /**
   * 整体替换编程器内容。
   *
   * @param values 新内容。
   */
  setValues: (values: Record<string, Look>) => void;
  /**
   * 开关实时输出。
   *
   * @param live 是否实时输出。
   */
  setLive: (live: boolean) => void;
  /** 清空编程器（并关闭实时输出）。 */
  clear: () => void;
}

/**
 * 编程器状态：不属于工程，不进撤销历史，也不保存；切换工程时由调用方清空。
 */
export const useProgrammerStore = create<ProgrammerState>((set) => ({
  values: {},
  live: false,
  setValues: (values) => set({ values }),
  setLive: (live) => set({ live }),
  clear: () => set({ values: {}, live: false }),
}));
