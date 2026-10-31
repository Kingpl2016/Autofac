import { useFixtureStore } from "@/features/fixtures";
import { upsertEffect } from "../lib/effectLibrary";
import { upsertTemplate } from "../lib/templateOps";
import { useCueTemplateStore } from "../stores/useCueTemplateStore";
import { useEffectLibraryStore } from "../stores/useEffectLibraryStore";
import { hasLibraryChanges, type LibraryChanges } from "./compile";

/**
 * 把 AI 改动里要保留的特效、模板与灯具模型写进用户库（应用改动时调用）。
 * 还没读过用户文件的库先读一遍，避免覆盖文件里已有的内容。
 */

/** 写库的结果。 */
export interface LibrarySaveResult {
  /** 写入了几项 */
  saved: number;
  /** 写失败的种类 */
  failed: ("effects" | "templates" | "models")[];
}

/**
 * 写入用户库。
 *
 * @param changes 要写入的内容。
 * @returns 写入数与失败的种类（不抛出）。
 */
export async function saveLibraryChanges(changes: LibraryChanges): Promise<LibrarySaveResult> {
  const out: LibrarySaveResult = { saved: 0, failed: [] };
  if (!hasLibraryChanges(changes)) return out;
  if (changes.effects.length > 0) {
    const store = useEffectLibraryStore.getState();
    if (store.status !== "ready") await store.load();
    const s = useEffectLibraryStore.getState();
    const next = changes.effects.reduce((list, def) => upsertEffect(list, def), s.user);
    if (s.status === "ready" && (await s.saveUser(next))) out.saved += changes.effects.length;
    else out.failed.push("effects");
  }
  if (changes.templates.length > 0) {
    const store = useCueTemplateStore.getState();
    if (store.status !== "ready") await store.load();
    const s = useCueTemplateStore.getState();
    const next = changes.templates.reduce((list, t) => upsertTemplate(list, t), s.user);
    if (s.status === "ready" && (await s.saveUser(next))) out.saved += changes.templates.length;
    else out.failed.push("templates");
  }
  for (const model of changes.models) {
    try {
      await useFixtureStore.getState().save(model);
      out.saved += 1;
    } catch {
      if (!out.failed.includes("models")) out.failed.push("models");
    }
  }
  return out;
}
