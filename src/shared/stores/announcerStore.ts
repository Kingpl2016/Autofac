import { create } from "zustand";

interface AnnouncerState {
  /** 当前要播报给读屏软件的文案 */
  message: string;
  /** 递增序号：连续两次播报相同文案时，仍能让读屏重新朗读 */
  seq: number;
  /** 播报一条文案 */
  announce: (message: string) => void;
}

/**
 * 全局礼貌播报（`aria-live="polite"`）的数据源。
 *
 * 用于键盘快捷键、自动切换节目、模式切换完成等“焦点没有移动但状态变了”的场合。
 * 由 `LiveAnnouncer` 渲染成唯一的 `role="status"` 区域，避免每个组件各自成为 live region。
 */
export const useAnnouncerStore = create<AnnouncerState>((set) => ({
  message: "",
  seq: 0,
  announce: (message) => set((s) => ({ message, seq: s.seq + 1 })),
}));

/**
 * 向读屏软件播报一条状态变化（不移动焦点、不打断当前朗读）。
 *
 * @param message 本地化后的播报文案。
 */
export function announce(message: string): void {
  useAnnouncerStore.getState().announce(message);
}
