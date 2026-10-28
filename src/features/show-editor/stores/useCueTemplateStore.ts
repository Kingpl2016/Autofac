import { create } from "zustand";

import { readUserTemplates, templateErrorCode, writeUserTemplates } from "../lib/cueTemplateApi";
import {
  BUILTIN_TEMPLATES,
  mergeTemplates,
  parseTemplateText,
  serializeTemplates,
  type CueTemplate,
  type TemplateIssue,
} from "../lib/cueTemplates";

/** 加载状态。 */
export type TemplateLoadStatus = "idle" | "loading" | "ready" | "error";

interface CueTemplateState {
  /** 用户模板（来自 `data/cue-templates.json`） */
  user: CueTemplate[];
  status: TemplateLoadStatus;
  /** 读写失败的错误码 */
  error: string | null;
  /** 用户文件里被跳过的条目 */
  issues: TemplateIssue[];
  /** 读取（或重新读取）用户模板文件。 */
  load: () => Promise<void>;
  /**
   * 替换用户模板并写回文件。写入失败时界面保持原样并记下错误。
   *
   * @param next 新的用户模板列表。
   * @returns 是否写入成功。
   */
  saveUser: (next: CueTemplate[]) => Promise<boolean>;
}

/**
 * Cue 模板库：内置模板（随软件发布）+ 用户模板（数据目录里的配置文件，可手改、导入导出、在软件里编辑）。
 * 读不到用户文件时只有内置模板，不影响使用。
 */
export const useCueTemplateStore = create<CueTemplateState>((set, get) => ({
  user: [],
  status: "idle",
  error: null,
  issues: [],
  load: async () => {
    set({ status: "loading" });
    try {
      const text = await readUserTemplates();
      const parsed = text === null ? { templates: [], issues: [] } : parseTemplateText(text);
      set({ user: parsed.templates, issues: parsed.issues, status: "ready", error: null });
    } catch (e) {
      set({ status: "error", error: templateErrorCode(e) });
    }
  },
  saveUser: async (next) => {
    const prev = get().user;
    set({ user: next, error: null });
    try {
      await writeUserTemplates(serializeTemplates(next));
      return true;
    } catch (e) {
      set({ user: prev, error: templateErrorCode(e) });
      return false;
    }
  },
}));

/**
 * 当前可用的全部模板（内置 + 用户，同 `id` 时用户的覆盖内置的）。
 *
 * @param s 状态。
 * @returns 合并后的列表。
 */
export function allTemplates(s: Pick<CueTemplateState, "user">): CueTemplate[] {
  return mergeTemplates(BUILTIN_TEMPLATES, s.user);
}
