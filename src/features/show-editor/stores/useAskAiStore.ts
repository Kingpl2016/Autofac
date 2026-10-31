import { create } from "zustand";

import type { AskScope } from "../ai/askScope";

/**
 * 时间线上的“问 AI”弹层：打开的位置（屏幕坐标）与范围。右键时先记下指针位置，菜单里选“问 AI…”时在那里打开。
 */
interface AskAiState {
  open: boolean;
  /** 弹层锚点（屏幕坐标） */
  x: number;
  y: number;
  scope: AskScope | null;
  /** 打开后直接发出的话（“让 AI 细化”建议时）；发出后清除 */
  prompt: string | null;
  /** 每次打开递增（弹层内容按它重建） */
  seq: number;
  /** 最近一次右键的位置 */
  pointer: { x: number; y: number };
  /**
   * 记下右键的位置。
   *
   * @param x 屏幕横坐标。
   * @param y 屏幕纵坐标。
   */
  setPointer: (x: number, y: number) => void;
  /**
   * 打开弹层。
   *
   * @param scope 范围。
   * @param at 锚点；省略时用最近一次右键的位置。
   * @param prompt 打开后直接发出的话。
   */
  openAt: (scope: AskScope, at?: { x: number; y: number }, prompt?: string) => void;
  /** 取走要直接发出的话（只取一次）。 */
  takePrompt: () => string | null;
  /** 关闭弹层。 */
  close: () => void;
}

/** 问 AI 弹层的状态。 */
export const useAskAiStore = create<AskAiState>((set, get) => ({
  open: false,
  x: 0,
  y: 0,
  scope: null,
  prompt: null,
  seq: 0,
  pointer: { x: 0, y: 0 },
  setPointer: (x, y) => set({ pointer: { x, y } }),
  openAt: (scope, at, prompt) => {
    const p = at ?? get().pointer;
    set((s) => ({ open: true, scope, x: p.x, y: p.y, prompt: prompt ?? null, seq: s.seq + 1 }));
  },
  takePrompt: () => {
    const p = get().prompt;
    if (p !== null) set({ prompt: null });
    return p;
  },
  close: () => set({ open: false, prompt: null }),
}));
