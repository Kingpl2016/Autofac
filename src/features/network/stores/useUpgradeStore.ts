import { create } from "zustand";

import { netdevOtaUpload, netdevStatus } from "../lib/api";
import { percentOf } from "../lib/format";
import type { FirmwareInfo } from "../lib/types";
import { runUpgrade, type UpgradeTarget } from "../lib/upgrade";
import { useDeviceSessionStore } from "./useDeviceSessionStore";
import { useTransferStore } from "./useTransferStore";

/** 升级流程所处阶段。 */
export type UpgradeStage = "idle" | "running" | "finished";

/** 待升级设备的描述。 */
export interface UpgradeTargetInput {
  id: string;
  name: string;
  fromVersion: string | null;
}

interface UpgradeState {
  stage: UpgradeStage;
  /** 已通过预检的固件 */
  firmware: FirmwareInfo | null;
  /** 固件本地路径 */
  path: string | null;
  targets: UpgradeTarget[];
  stopRequested: boolean;
  /** 选定（并已通过预检的）固件。 */
  setFirmware: (info: FirmwareInfo | null, path: string | null) => void;
  /** 开始升级；流程由 store 驱动，切换页面 / Tab 不会中断。 */
  start: (targets: UpgradeTargetInput[]) => Promise<void>;
  /** 取消尚未开始的设备（当前设备会跑完）。 */
  requestStop: () => void;
  /** 回到初始状态（保留固件选择）。 */
  reset: () => void;
}

/**
 * 固件升级的全局状态与驱动。
 *
 * 升级耗时较长且包含重启等待，所以放在全局 store 里而不是组件状态：
 * 用户切到别的 Tab 或页面，流程照常继续，回来时进度还在。
 */
export const useUpgradeStore = create<UpgradeState>()((set, get) => ({
  stage: "idle",
  firmware: null,
  path: null,
  targets: [],
  stopRequested: false,

  setFirmware: (firmware, path) => set({ firmware, path }),

  start: async (inputs) => {
    const { firmware, path, stage } = get();
    if (!firmware || !path || stage === "running" || inputs.length === 0) return;
    set({
      stage: "running",
      stopRequested: false,
      targets: inputs.map((t) => ({
        id: t.id,
        name: t.name,
        phase: "queued",
        percent: null,
        error: null,
        fromVersion: t.fromVersion,
      })),
    });

    await runUpgrade({
      targets: inputs,
      expectedVersion: firmware.version,
      shouldStop: () => get().stopRequested,
      update: (id, patch) =>
        set((s) => ({ targets: s.targets.map((t) => (t.id === id ? { ...t, ...patch } : t)) })),
      deps: {
        upload: (id, onPercent) =>
          useTransferStore.getState().run(
            { kind: "ota", deviceId: id, label: firmware.fileName },
            (onProgress) =>
              netdevOtaUpload(id, path, (p) => {
                onProgress(p);
                const pct = percentOf(p.done, p.total);
                if (pct !== null) onPercent(pct);
              }),
          ),
        status: netdevStatus,
        sleep: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
        now: () => Date.now(),
        markRebooting: (id) => useDeviceSessionStore.getState().markRebooting(id),
      },
    });

    set({ stage: "finished" });
  },

  requestStop: () => set({ stopRequested: true }),

  reset: () => set({ stage: "idle", targets: [], stopRequested: false }),
}));
