import { create } from "zustand";

import {
  EMPTY_STATUS,
  type RecordingResult,
  type RecordingStatus,
  type SourceStat,
} from "../lib/types";

interface RecordingState {
  /** 录制实时状态 */
  status: RecordingStatus;
  /** 当前来源统计（约 4Hz 更新） */
  sources: SourceStat[];
  /** 最近一次录制的结果（用于结束后的摘要展示） */
  last: RecordingResult | null;
  setStatus: (s: RecordingStatus) => void;
  setSources: (s: SourceStat[]) => void;
  setLast: (r: RecordingResult | null) => void;
}

/**
 * 录制状态 store：由 Tauri 事件填充，录制面板与顶部状态条读取。
 */
export const useRecordingStore = create<RecordingState>((set) => ({
  status: EMPTY_STATUS,
  sources: [],
  last: null,
  setStatus: (status) => set({ status }),
  setSources: (sources) => set({ sources }),
  setLast: (last) => set({ last }),
}));
