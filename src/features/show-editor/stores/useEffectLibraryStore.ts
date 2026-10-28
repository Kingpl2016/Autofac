import { create } from "zustand";

import { templateErrorCode } from "../lib/cueTemplateApi";
import { readUserEffects, writeUserEffects } from "../lib/effectApi";
import { BUILTIN_EFFECTS, mergeEffects, parseEffectText, serializeEffects, type EffectDef, type EffectIssue } from "../lib/effectLibrary";

/** 加载状态。 */
export type EffectLoadStatus = "idle" | "loading" | "ready" | "error";

interface EffectLibraryState {
  /** 用户特效（来自 `data/effects.json`） */
  user: EffectDef[];
  status: EffectLoadStatus;
  /** 读写失败的错误码 */
  error: string | null;
  /** 用户文件里被跳过的条目 */
  issues: EffectIssue[];
  /** 读取（或重新读取）用户特效文件。 */
  load: () => Promise<void>;
  /**
   * 替换用户特效并写回文件。写入失败时界面保持原样并记下错误。
   *
   * @param next 新的用户特效列表。
   * @returns 是否写入成功。
   */
  saveUser: (next: EffectDef[]) => Promise<boolean>;
}

/**
 * 特效库：内置特效（随软件发布）+ 用户特效（数据目录里的配置文件）。读不到用户文件时只有内置特效。
 */
export const useEffectLibraryStore = create<EffectLibraryState>((set, get) => ({
  user: [],
  status: "idle",
  error: null,
  issues: [],
  load: async () => {
    set({ status: "loading" });
    try {
      const text = await readUserEffects();
      const parsed = text === null ? { effects: [], issues: [] } : parseEffectText(text);
      set({ user: parsed.effects, issues: parsed.issues, status: "ready", error: null });
    } catch (e) {
      set({ status: "error", error: templateErrorCode(e) });
    }
  },
  saveUser: async (next) => {
    const prev = get().user;
    set({ user: next, error: null });
    try {
      await writeUserEffects(serializeEffects(next));
      return true;
    } catch (e) {
      set({ user: prev, error: templateErrorCode(e) });
      return false;
    }
  },
}));

/**
 * 当前可用的全部特效（内置 + 用户，同 `id` 时用户的覆盖内置的）。
 *
 * @param s 状态。
 * @returns 合并后的列表。
 */
export function allEffects(s: Pick<EffectLibraryState, "user">): EffectDef[] {
  return mergeEffects(BUILTIN_EFFECTS, s.user);
}
