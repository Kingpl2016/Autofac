import { z } from "zod";
import { create } from "zustand";
import { persist } from "zustand/middleware";

import { persistPrefs } from "@/shared/stores/persistPrefs";

interface AiPrefsState {
  /** 默认使用的 AI 配置 id（可能指向已删除的配置，读取方需回退）。 */
  defaultProfileId: string | null;
  /**
   * 自动写入：AI 的改动不经审阅直接写入工程（可撤销）。
   * 涉及灯具配接、输出设置或大批量删除的改动仍然要确认。
   */
  autoApply: boolean;
  setDefaultProfileId: (id: string | null) => void;
  setAutoApply: (on: boolean) => void;
}

/** 落盘字段。 */
interface Persisted {
  defaultProfileId: string | null;
  autoApply: boolean;
}

/** AI 偏好，经 Tauri Store 持久化到 `ui-prefs.json`（键 `ai`）。 */
export const useAiPrefsStore = create<AiPrefsState>()(
  persist(
    (set) => ({
      defaultProfileId: null,
      autoApply: false,
      setDefaultProfileId: (defaultProfileId) => set({ defaultProfileId }),
      setAutoApply: (autoApply) => set({ autoApply }),
    }),
    persistPrefs<AiPrefsState, Persisted>({
      name: "ai",
      version: 1,
      schema: z.object({
        defaultProfileId: z.string().nullable().catch(null),
        autoApply: z.boolean().catch(false),
      }),
    }),
  ),
);
