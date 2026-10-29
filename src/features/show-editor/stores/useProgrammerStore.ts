import { create } from "zustand";

import type { Look } from "../lib/project";

/** 编程器撤销栈的上限（步）。 */
export const PROGRAMMER_HISTORY_LIMIT = 100;

/** 编程器内容：灯具或像素引用 → 外观（只写“参与”的层）。 */
type Values = Record<string, Look>;

interface ProgrammerState {
  /** 编程器内容：灯具 id → 外观（只写“参与”的层） */
  values: Values;
  /** 实时输出：编程器覆盖整个节目推给后端（灯会立刻亮成编程器的样子） */
  live: boolean;
  /**
   * 高亮（grandMA3 的 Highlight）：选中的灯临时满亮白光，不写进编程器内容。
   * 预览里总是生效；只有实时输出打开时才输出到灯。
   */
  highlight: boolean;
  /** 撤销栈（旧 → 新） */
  past: Values[];
  /** 重做栈（最近撤销的在最后） */
  future: Values[];
  /**
   * 整体替换编程器内容（进编程器自己的撤销栈）。
   *
   * @param values 新内容。
   */
  setValues: (values: Values) => void;
  /**
   * 开关实时输出。
   *
   * @param live 是否实时输出。
   */
  setLive: (live: boolean) => void;
  /**
   * 开关高亮。
   *
   * @param on 是否高亮。
   */
  setHighlight: (on: boolean) => void;
  /** 清空编程器内容（可撤销），并关闭实时输出与高亮。 */
  clear: () => void;
  /** 撤销编程器的上一步。 */
  undo: () => void;
  /** 重做编程器被撤销的一步。 */
  redo: () => void;
  /** 回到初始状态（切换工程时：内容、撤销栈、实时输出、高亮全部清掉）。 */
  reset: () => void;
}

/**
 * 把当前内容压进撤销栈（超过上限时丢掉最旧的）。
 *
 * @param past 撤销栈。
 * @param values 当前内容。
 * @returns 新的撤销栈。
 */
function pushPast(past: readonly Values[], values: Values): Values[] {
  const next = [...past, values];
  return next.length > PROGRAMMER_HISTORY_LIMIT ? next.slice(next.length - PROGRAMMER_HISTORY_LIMIT) : next;
}

/**
 * 编程器状态：不属于工程，不进工程的撤销历史，也不保存；切换工程时由调用方 `reset`。
 * 编程器有自己的撤销栈（`undo` / `redo`），与工程的撤销互不影响。
 */
export const useProgrammerStore = create<ProgrammerState>((set) => ({
  values: {},
  live: false,
  highlight: false,
  past: [],
  future: [],
  setValues: (values) =>
    set((s) => (values === s.values ? s : { values, past: pushPast(s.past, s.values), future: [] })),
  setLive: (live) => set({ live }),
  setHighlight: (highlight) => set({ highlight }),
  clear: () =>
    set((s) => ({
      values: {},
      live: false,
      highlight: false,
      ...(Object.keys(s.values).length > 0 ? { past: pushPast(s.past, s.values), future: [] } : {}),
    })),
  undo: () =>
    set((s) => {
      const prev = s.past.at(-1);
      if (!prev) return s;
      return { values: prev, past: s.past.slice(0, -1), future: [...s.future, s.values] };
    }),
  redo: () =>
    set((s) => {
      const next = s.future.at(-1);
      if (!next) return s;
      return { values: next, future: s.future.slice(0, -1), past: pushPast(s.past, s.values) };
    }),
  reset: () => set({ values: {}, live: false, highlight: false, past: [], future: [] }),
}));
