import { useMemo } from "react";
import { create } from "zustand";

import { errorMessage } from "@/shared/lib/errors";
import { skillsDelete, skillsImport, skillsList, skillsRead, skillsRestore, type SkillInfo, type TrashEntry } from "../lib/skillsApi";
import { useAiPrefsStore } from "./useAiPrefsStore";

/**
 * 用户技能（运行时状态）：列表与各技能的 `SKILL.md` 全文（按需读入，AI 调用前读好）。
 * 启用 / 停用记在 AI 偏好里（`disabledSkills`），技能文件本身在 `data/skills`。
 */

/** 最多读入多少个技能的全文。 */
const MAX_LOADED = 50;

interface SkillState {
  status: "idle" | "loading" | "ready" | "error";
  items: SkillInfo[];
  /** 技能名 → `SKILL.md` 全文 */
  texts: Record<string, string>;
  error: string | null;
  /** 读入列表与全文（已读过时重新读）。 */
  load: () => Promise<void>;
  /**
   * 导入技能包。
   *
   * @param path 路径（zip / 文件夹 / SKILL.md）。
   * @param replace 替换同名技能。
   * @returns 导入的技能。
   * @throws 后端错误码。
   */
  importPath: (path: string, replace?: boolean) => Promise<SkillInfo>;
  /**
   * 删除技能（进回收站）。
   *
   * @param name 技能名。
   * @returns 回收站条目（撤销用）。
   */
  remove: (name: string) => Promise<TrashEntry>;
  /**
   * 从回收站恢复。
   *
   * @param trashId 条目 id。
   */
  restore: (trashId: string) => Promise<SkillInfo>;
}

/** 用户技能。 */
export const useSkillStore = create<SkillState>((set, get) => ({
  status: "idle",
  items: [],
  texts: {},
  error: null,
  load: async () => {
    set({ status: "loading", error: null });
    try {
      const items = await skillsList();
      const entries = await Promise.all(
        items.slice(0, MAX_LOADED).map(async (s) => [s.name, await skillsRead(s.name).catch(() => "")] as const),
      );
      set({ status: "ready", items, texts: Object.fromEntries(entries.filter(([, text]) => text)) });
    } catch (e) {
      set({ status: "error", error: errorMessage(e) });
    }
  },
  importPath: async (path, replace = false) => {
    const info = await skillsImport(path, replace);
    // 新导入的默认启用
    useAiPrefsStore.getState().setSkillEnabled(info.name, true);
    await get().load();
    return info;
  },
  remove: async (name) => {
    const entry = await skillsDelete(name);
    await get().load();
    return entry;
  },
  restore: async (trashId) => {
    const info = await skillsRestore(trashId);
    await get().load();
    return info;
  },
}));

/**
 * 确保用户技能已读入（没有 Tauri 运行时时静默失败）。
 */
export async function ensureSkills(): Promise<void> {
  if (useSkillStore.getState().status === "idle") await useSkillStore.getState().load();
}

/** 启用的用户技能：名称、描述、标题、触发词与全文。 */
export function enabledSkills(): { info: SkillInfo; text: string }[] {
  const { items, texts } = useSkillStore.getState();
  const disabled = new Set(useAiPrefsStore.getState().disabledSkills);
  return items.filter((s) => !disabled.has(s.name) && texts[s.name]).map((info) => ({ info, text: texts[info.name] }));
}

/**
 * 启用的用户技能列表（随导入、删除、启停更新；只有列表信息，不含全文）。
 *
 * @returns 启用的技能。
 */
export function useEnabledSkillInfos(): SkillInfo[] {
  const items = useSkillStore((s) => s.items);
  const disabled = useAiPrefsStore((s) => s.disabledSkills);
  return useMemo(() => items.filter((s) => !disabled.includes(s.name)), [items, disabled]);
}
