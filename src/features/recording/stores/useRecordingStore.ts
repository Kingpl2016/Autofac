import { create } from "zustand";

import { decodeActivity, mergeActivity } from "../lib/recordTimeline";
import {
  EMPTY_STATUS,
  type Activity,
  type ActivityDto,
  type RecordingResult,
  type RecordingStatus,
  type SourceStat,
} from "../lib/types";

interface RecordingState {
  /** 录制实时状态 */
  status: RecordingStatus;
  /** `status` 最近一次更新时的 `performance.now()`（毫秒），顶栏时间码据此在两次推送之间插值 */
  statusAt: number;
  /** 当前来源统计（约 4Hz 更新） */
  sources: SourceStat[];
  /** 最近一次录制的结果（用于结束后的摘要展示） */
  last: RecordingResult | null;
  /** 录制活动时间线（录制停止后保留到下次开始） */
  activity: Activity | null;
  setStatus: (s: RecordingStatus) => void;
  setSources: (s: SourceStat[]) => void;
  setLast: (r: RecordingResult | null) => void;
  /**
   * 合并一次活动增量。
   *
   * @returns 合并成功为 `true`；无法合并（需要拉取全量）为 `false`，此时本地数据保持不变。
   */
  applyActivity: (dto: ActivityDto) => boolean;
  /** 用全量快照替换本地时间线 */
  setActivityFull: (dto: ActivityDto) => void;
}

/**
 * 录制状态 store：由 Tauri 事件填充，录制面板与顶部状态条读取。
 */
export const useRecordingStore = create<RecordingState>((set, get) => ({
  status: EMPTY_STATUS,
  statusAt: 0,
  sources: [],
  last: null,
  activity: null,
  // 新一次录制开始时丢弃上一次的时间线，避免第一批增量到达前显示旧数据
  setStatus: (status) =>
    set((prev) => ({
      status,
      statusAt: performance.now(),
      ...(status.recording && !prev.status.recording ? { activity: null } : {}),
    })),
  setSources: (sources) => set({ sources }),
  setLast: (last) => set({ last }),
  applyActivity: (dto) => {
    const next = mergeActivity(get().activity, dto);
    if (!next) return false;
    set({ activity: next });
    return true;
  },
  setActivityFull: (dto) => set({ activity: decodeActivity(dto) }),
}));
