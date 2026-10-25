import { create } from "zustand";

interface GuardState {
  /** 本会话是否已确认过频闪的光敏风险（只在内存里，窗口关闭后重新确认） */
  strobeAcknowledged: boolean;
  acknowledgeStrobe: () => void;
}

/**
 * 发送前确认的会话记忆。刻意不持久化：每次打开检测器都应重新提醒一次光敏风险。
 */
export const useGuardStore = create<GuardState>((set) => ({
  strobeAcknowledged: false,
  acknowledgeStrobe: () => set({ strobeAcknowledged: true }),
}));
