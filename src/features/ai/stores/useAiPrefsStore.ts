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
  /** 停用的用户技能（技能名）。 */
  disabledSkills: string[];
  /** 不再逐次确认的外部（MCP）工具（给模型的工具名 `mcp__服务器__工具`）。 */
  mcpAlwaysAllow: string[];
  setDefaultProfileId: (id: string | null) => void;
  /**
   * 设置一个外部工具是否总是允许。
   *
   * @param name 工具名。
   * @param on 是否总是允许。
   */
  setMcpAlwaysAllow: (name: string, on: boolean) => void;
  setAutoApply: (on: boolean) => void;
  /**
   * 启用 / 停用一个用户技能。
   *
   * @param name 技能名。
   * @param on 是否启用。
   */
  setSkillEnabled: (name: string, on: boolean) => void;
  /** 恢复默认（自动写入关闭、全部技能启用、外部工具都要逐次确认；默认配置保留）。 */
  resetPrefs: () => void;
}

/** 落盘字段。 */
interface Persisted {
  defaultProfileId: string | null;
  autoApply: boolean;
  disabledSkills: string[];
  mcpAlwaysAllow: string[];
}

/** AI 偏好，经 Tauri Store 持久化到 `ui-prefs.json`（键 `ai`）。 */
export const useAiPrefsStore = create<AiPrefsState>()(
  persist(
    (set, get) => ({
      defaultProfileId: null,
      autoApply: false,
      disabledSkills: [],
      mcpAlwaysAllow: [],
      setMcpAlwaysAllow: (name, on) => {
        const rest = get().mcpAlwaysAllow.filter((n) => n !== name);
        set({ mcpAlwaysAllow: on ? [...rest, name] : rest });
      },
      setDefaultProfileId: (defaultProfileId) => set({ defaultProfileId }),
      setAutoApply: (autoApply) => set({ autoApply }),
      setSkillEnabled: (name, on) => {
        const rest = get().disabledSkills.filter((n) => n !== name);
        set({ disabledSkills: on ? rest : [...rest, name] });
      },
      resetPrefs: () => set({ autoApply: false, disabledSkills: [], mcpAlwaysAllow: [] }),
    }),
    persistPrefs<AiPrefsState, Persisted>({
      name: "ai",
      version: 1,
      schema: z.object({
        defaultProfileId: z.string().nullable().catch(null),
        autoApply: z.boolean().catch(false),
        // 后加的字段：旧数据没有时取默认值
        disabledSkills: z.array(z.string().max(64)).max(500).catch([]),
        mcpAlwaysAllow: z.array(z.string().max(64)).max(200).catch([]),
      }),
    }),
  ),
);
