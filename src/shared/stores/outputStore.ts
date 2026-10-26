import { create } from "zustand";

import type { OutputPayload } from "@/shared/domain/engine";

interface OutputStoreState {
  /** 最近一次 `engine:output` 载荷；尚未收到为 null。 */
  output: OutputPayload | null;
  /** 最近一次收到事件的本地时间戳（毫秒，`Date.now()`），用于判断数据是否过期。 */
  receivedAt: number | null;
  /** 写入最新载荷并记录接收时间。 */
  setOutput: (p: OutputPayload) => void;
}

/**
 * 输出统计 store：由 `engine:output` 事件填充，仪表盘与转发页读取。
 */
export const useOutputStore = create<OutputStoreState>((set) => ({
  output: null,
  receivedAt: null,
  setOutput: (output) => set({ output, receivedAt: Date.now() }),
}));