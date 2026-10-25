import { create } from "zustand";
import { persist } from "zustand/middleware";

import { createTauriPersistStorage } from "@/shared/tauri/tauriStorage";
import { DEFAULT_DRAFT, type Draft } from "../lib/draft";
import {
  PATTERN_IDS,
  type PatternId,
  type SendMode,
  type SignalProtocol,
} from "../lib/types";

/** 检测器偏好落盘文件：与主应用的 `ui-prefs.json` 分开，两个窗口不会同写一个文件。 */
const FILE = "signal-checker.json";

/** 倍速档位。 */
export const SPEED_STEPS = [0.25, 0.5, 1, 2, 4] as const;

interface FormState {
  /** 连接区草稿（未应用） */
  draft: Draft;
  mode: SendMode;
  pattern: PatternId;
  /** 倍速 */
  speed: number;
  setDraft: (patch: Partial<Draft>) => void;
  setMode: (mode: SendMode) => void;
  setPattern: (pattern: PatternId) => void;
  setSpeed: (speed: number) => void;
}

/** 落盘的字段。 */
export interface FormData {
  draft: Draft;
  mode: SendMode;
  pattern: PatternId;
  speed: number;
}

const PROTOCOLS: readonly SignalProtocol[] = ["artNet", "sacn"];

/** 表单的出厂默认值。 */
export const DEFAULTS: FormData = {
  draft: DEFAULT_DRAFT,
  mode: "auto",
  pattern: "sine",
  speed: 1,
};

/**
 * 校验并规整从磁盘读回的数据：任何字段不合法都回落到当前值，
 * 避免旧版本文件或被手改的文件让窗口进入无效状态。
 *
 * # Arguments
 *
 * * `raw` - 磁盘上读到的未知数据。
 * * `current` - 当前内存中的值（作为非法字段的回退）。
 *
 * # Returns
 *
 * 一定合法的 [`FormData`]。
 */
export function sanitizeFormData(raw: unknown, current: FormData): FormData {
  const r = (raw ?? {}) as Partial<Record<keyof FormData, unknown>>;
  const d = (r.draft ?? {}) as Partial<Record<keyof Draft, unknown>>;
  const str = (v: unknown, fallback: string) => (typeof v === "string" ? v : fallback);
  return {
    draft: {
      targetIp: str(d.targetIp, current.draft.targetIp),
      port: str(d.port, current.draft.port),
      protocol: PROTOCOLS.includes(d.protocol as SignalProtocol)
        ? (d.protocol as SignalProtocol)
        : current.draft.protocol,
      universes: str(d.universes, current.draft.universes),
    },
    mode: r.mode === "auto" || r.mode === "manual" ? r.mode : current.mode,
    pattern: PATTERN_IDS.includes(r.pattern as PatternId) ? (r.pattern as PatternId) : current.pattern,
    speed:
      typeof r.speed === "number" && (SPEED_STEPS as readonly number[]).includes(r.speed)
        ? r.speed
        : current.speed,
  };
}

/**
 * 信号检测器的表单状态（连接草稿、模式、图案、倍速），经 Tauri Store 持久化到 `signal-checker.json`。
 */
export const useCheckerFormStore = create<FormState>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      setDraft: (patch) => set((s) => ({ draft: { ...s.draft, ...patch } })),
      setMode: (mode) => set({ mode }),
      setPattern: (pattern) => set({ pattern }),
      setSpeed: (speed) => set({ speed }),
    }),
    {
      name: "form",
      version: 1,
      storage: createTauriPersistStorage<FormData>(FILE),
      partialize: ({ draft, mode, pattern, speed }) => ({ draft, mode, pattern, speed }),
      merge: (persisted, current) =>
        persisted == null ? current : { ...current, ...sanitizeFormData(persisted, current) },
    },
  ),
);
