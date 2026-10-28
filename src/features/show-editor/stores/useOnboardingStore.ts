import { create } from "zustand";
import { persist } from "zustand/middleware";

import { createTauriPersistStorage } from "@/shared/tauri/tauriStorage";

/** 导览内容的版本：导览有大改动时加一，已看过旧版的用户会再看一次。 */
export const TOUR_VERSION = 1;

/** 落盘的数据。 */
export interface OnboardingData {
  /** 已看完（或跳过）的导览版本；0 为没看过 */
  tourVersion: number;
  /** 已点“知道了”的局部提示 */
  dismissedHints: string[];
}

interface OnboardingState extends OnboardingData {
  /** 已从磁盘读回（读回前不能判断是不是第一次进来） */
  hydrated: boolean;
  /** 导览正在进行（局部提示让路） */
  tourRunning: boolean;
  /**
   * 标记导览正在进行 / 已结束。
   *
   * @param running 是否进行中。
   */
  setTourRunning: (running: boolean) => void;
  /** 记为已看过当前版本的导览。 */
  completeTour: () => void;
  /**
   * 记住一条局部提示已关闭。
   *
   * @param id 提示 id。
   */
  dismissHint: (id: string) => void;
  /** 重置：下次进入编辑器重新播放导览，全部局部提示重新出现。 */
  reset: () => void;
}

/**
 * 校验读回的数据：版本取非负整数，提示 id 只保留字符串。
 *
 * @param raw 磁盘上读到的未知数据。
 * @returns 一定合法的数据。
 */
export function sanitizeOnboarding(raw: unknown): OnboardingData {
  const r = (raw ?? {}) as Partial<Record<keyof OnboardingData, unknown>>;
  const v = typeof r.tourVersion === "number" && Number.isInteger(r.tourVersion) && r.tourVersion >= 0 ? r.tourVersion : 0;
  const ids = Array.isArray(r.dismissedHints) ? r.dismissedHints.filter((x): x is string => typeof x === "string") : [];
  return { tourVersion: v, dismissedHints: [...new Set(ids)] };
}

/**
 * 编辑器的上手引导状态（导览是否看过、哪些局部提示已关闭），落盘到界面偏好文件（键 `editor-onboarding`）。
 */
export const useOnboardingStore = create<OnboardingState>()(
  persist(
    (set) => ({
      tourVersion: 0,
      dismissedHints: [],
      hydrated: false,
      tourRunning: false,
      setTourRunning: (tourRunning) => set({ tourRunning }),
      completeTour: () => set({ tourVersion: TOUR_VERSION, tourRunning: false }),
      dismissHint: (id) => set((s) => (s.dismissedHints.includes(id) ? s : { dismissedHints: [...s.dismissedHints, id] })),
      reset: () => set({ tourVersion: 0, dismissedHints: [] }),
    }),
    {
      name: "editor-onboarding",
      version: 1,
      storage: createTauriPersistStorage<OnboardingData>(),
      partialize: ({ tourVersion, dismissedHints }) => ({ tourVersion, dismissedHints }),
      merge: (persisted, current) => (persisted == null ? current : { ...current, ...sanitizeOnboarding(persisted) }),
      // 读回成功或失败都算读完（失败时按第一次进来处理）
      onRehydrateStorage: () => () => useOnboardingStore.setState({ hydrated: true }),
    },
  ),
);

/**
 * 是否已看过当前版本的导览。
 *
 * @param s 状态。
 * @returns 看过时为 `true`。
 */
export const tourSeen = (s: Pick<OnboardingData, "tourVersion">) => s.tourVersion >= TOUR_VERSION;
