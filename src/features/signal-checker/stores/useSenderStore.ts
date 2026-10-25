import { create } from "zustand";

import type { PreviewEvent, SendErrorEvent, SenderStatus } from "../lib/types";

/** 一条待展示的发送错误；`id` 递增，用来区分"同一条文案再次出现"。 */
export interface ShownError extends SendErrorEvent {
  id: number;
}

interface SenderState {
  /** 发送器状态（收到第一次状态前为 `null`） */
  status: SenderStatus | null;
  /** 当前显示的发送错误 */
  error: ShownError | null;
  /** 最近一次预览帧 */
  preview: PreviewEvent | null;
  setStatus: (status: SenderStatus) => void;
  /** 记录一条新的发送错误（会替换正在显示的那条） */
  pushError: (error: SendErrorEvent) => void;
  /** 关闭错误条；传入 `id` 时只关闭对应那一条，避免定时器误关新的错误 */
  clearError: (id?: number) => void;
  setPreview: (preview: PreviewEvent | null) => void;
}

let nextErrorId = 1;

/**
 * 发送器的运行时状态（来自后端事件，不持久化）。
 */
export const useSenderStore = create<SenderState>((set) => ({
  status: null,
  error: null,
  preview: null,
  setStatus: (status) => set({ status }),
  pushError: (error) => set({ error: { ...error, id: nextErrorId++ } }),
  clearError: (id) =>
    set((s) => (id === undefined || s.error?.id === id ? { error: null } : s)),
  setPreview: (preview) => set({ preview }),
}));
