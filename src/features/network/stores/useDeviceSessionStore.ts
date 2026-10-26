import { create } from "zustand";

/** 重启跟踪：从下发重启到设备重新上线。 */
export interface RebootEntry {
  /** 超过该时刻（毫秒时间戳）不再等待。 */
  until: number;
  /** 是否已观察到设备掉线（只有掉线后再上线才算重启完成）。 */
  sawOffline: boolean;
}

interface DeviceSessionState {
  /** 设备 id → 重启跟踪。 */
  rebooting: Record<string, RebootEntry>;
  /** 设备 id → 用户选择"仍然尝试写操作"（设备没配置 Token 时的只读模式覆盖）。 */
  forceWrite: Record<string, boolean>;
  /** 标记设备开始重启。 */
  markRebooting: (id: string, waitMs?: number) => void;
  /** 记录观察到设备掉线。 */
  markSawOffline: (id: string) => void;
  /** 结束重启跟踪。 */
  clearRebooting: (id: string) => void;
  /** 切换"仍然尝试写操作"。 */
  setForceWrite: (id: string, force: boolean) => void;
}

/** 默认的重启等待上限（毫秒）。 */
export const DEFAULT_REBOOT_WAIT_MS = 90_000;

/**
 * 仅存活于本次运行的设备会话状态（不持久化）：重启跟踪与只读覆盖。
 */
export const useDeviceSessionStore = create<DeviceSessionState>()((set) => ({
  rebooting: {},
  forceWrite: {},
  markRebooting: (id, waitMs = DEFAULT_REBOOT_WAIT_MS) =>
    set((s) => ({
      rebooting: { ...s.rebooting, [id]: { until: Date.now() + waitMs, sawOffline: false } },
    })),
  markSawOffline: (id) =>
    set((s) => {
      const e = s.rebooting[id];
      if (!e || e.sawOffline) return s;
      return { rebooting: { ...s.rebooting, [id]: { ...e, sawOffline: true } } };
    }),
  clearRebooting: (id) =>
    set((s) => {
      if (!(id in s.rebooting)) return s;
      const next = { ...s.rebooting };
      delete next[id];
      return { rebooting: next };
    }),
  setForceWrite: (id, force) => set((s) => ({ forceWrite: { ...s.forceWrite, [id]: force } })),
}));
