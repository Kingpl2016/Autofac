import { create } from "zustand";

/** 最近一次扫描的结果摘要（仅内存保存，用于状态条）。 */
export interface LastScan {
  /** 完成时间（epoch 毫秒） */
  at: number;
  /** 本次扫描有响应的 Art-Net 节点数 */
  responded: number;
  /** 扫描结束时已知的 Art-Net 节点总数 */
  total: number;
  /** 本次扫描新发现的设备数 */
  added: number;
}

interface ScanSessionState {
  scanning: boolean;
  last: LastScan | null;
  /** 用户是否已关闭“无节点响应”的排查提示 */
  noReplyDismissed: boolean;
  begin: () => void;
  finish: (last: LastScan) => void;
  abort: () => void;
  dismissNoReply: () => void;
}

/**
 * 扫描会话状态。放在 store 而不是组件里，这样扫描过程中切换页面再回来，
 * 按钮的“扫描中”状态与上次结果仍然正确。不落盘。
 */
export const useScanSession = create<ScanSessionState>((set) => ({
  scanning: false,
  last: null,
  noReplyDismissed: false,
  begin: () => set({ scanning: true, noReplyDismissed: false }),
  finish: (last) => set({ scanning: false, last }),
  abort: () => set({ scanning: false }),
  dismissNoReply: () => set({ noReplyDismissed: true }),
}));
