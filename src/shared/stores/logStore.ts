import { create } from "zustand";

/** 日志级别 */
export type LogLevel = "info" | "warn" | "error";

/** 单条系统日志 */
export interface LogEntry {
  /** 自增序号 */
  id: number;
  /** 级别 */
  level: LogLevel;
  /** Unix 毫秒时间戳 */
  ts: number;
  /** 文本 */
  message: string;
}

/** 环形缓冲最大保留条数 */
const MAX_ENTRIES = 500;

interface LogState {
  entries: LogEntry[];
  /** 追加一条日志 */
  append: (level: LogLevel, message: string) => void;
  /** 清空日志 */
  clear: () => void;
}

let seq = 0;

/**
 * 系统日志 store：Dashboard 与底部状态条共享，容量上限 {@link MAX_ENTRIES}。
 */
export const useLogStore = create<LogState>((set) => ({
  entries: [],
  append: (level, message) =>
    set((s) => {
      const next = [
        ...s.entries,
        { id: ++seq, level, ts: Date.now(), message },
      ];
      return { entries: next.slice(-MAX_ENTRIES) };
    }),
  clear: () => set({ entries: [] }),
}));
