import type { TFunction } from "i18next";
import { toast } from "sonner";

import { announce } from "@/shared/stores/announcerStore";
import { memoryListSchema, type MemoryItem } from "./memory";
import { trashPutJson, trashRemove, trashTakeJson, type TrashEntry } from "./skillsApi";
import { useAiMemoryStore } from "../stores/useAiMemoryStore";
import { useAiPrefsStore } from "../stores/useAiPrefsStore";
import { useMcpStore } from "../stores/useMcpStore";
import { useSkillStore } from "../stores/useSkillStore";

/**
 * 恢复默认与回收站：清空 / 重置前先把原来的内容放进回收站（30 天内可恢复），提示里还能直接撤销。
 */

/** AI 偏好里会被重置的部分。 */
interface PrefsBackup {
  autoApply: boolean;
  disabledSkills: string[];
  mcpAlwaysAllow: string[];
}

/** 放进回收站；失败时返回 `null`（仍然可以用内存里的备份撤销）。 */
async function backup(kind: string, label: string, value: unknown): Promise<TrashEntry | null> {
  return trashPutJson(kind, label, JSON.stringify(value)).catch(() => null);
}

/** 撤销：恢复备份并删掉回收站条目。 */
function undoToast(text: string, t: TFunction, entry: TrashEntry | null, restore: () => void): void {
  announce(text);
  toast.success(text, {
    description: t(entry ? "ai.reset.inTrash" : "ai.reset.noTrash"),
    action: {
      label: t("ai.skills.undo"),
      onClick: () => {
        restore();
        if (entry) void trashRemove(entry.id).catch(() => undefined);
      },
    },
  });
}

/**
 * 恢复 AI 偏好的默认值（自动写入关闭、技能全部启用、外部工具都要逐次确认）。
 *
 * @param t 翻译函数。
 */
export async function resetAiPrefs(t: TFunction): Promise<void> {
  const s = useAiPrefsStore.getState();
  const saved: PrefsBackup = { autoApply: s.autoApply, disabledSkills: [...s.disabledSkills], mcpAlwaysAllow: [...s.mcpAlwaysAllow] };
  const entry = await backup("ai-prefs", t("ai.reset.prefsLabel"), saved);
  s.resetPrefs();
  undoToast(t("ai.reset.prefsDone"), t, entry, () => useAiPrefsStore.setState(saved));
}

/**
 * 清空个人偏好记忆。
 *
 * @param t 翻译函数。
 */
export async function clearUserMemory(t: TFunction): Promise<void> {
  const saved = [...useAiMemoryStore.getState().prefs];
  if (saved.length === 0) return;
  const entry = await backup("memory", t("ai.reset.memoryLabel", { count: saved.length }), saved);
  useAiMemoryStore.getState().replaceAll([]);
  undoToast(t("ai.reset.memoryDone", { count: saved.length }), t, entry, () => mergeMemory(saved));
}

/**
 * 删除一条个人偏好（进回收站，可撤销）。
 *
 * @param id 条目 id。
 * @param t 翻译函数。
 */
export async function removeMemoryItem(id: string, t: TFunction): Promise<void> {
  const item = useAiMemoryStore.getState().prefs.find((m) => m.id === id);
  if (!item) return;
  useAiMemoryStore.getState().remove(id);
  const entry = await backup("memory", item.text.slice(0, 60), [item]);
  undoToast(t("ai.reset.memoryItemDone"), t, entry, () => mergeMemory([item]));
}

/** 把条目并回个人偏好（同 id 的跳过）。 */
function mergeMemory(items: readonly MemoryItem[]): void {
  const cur = useAiMemoryStore.getState().prefs;
  const ids = new Set(cur.map((m) => m.id));
  useAiMemoryStore.getState().replaceAll([...cur, ...items.filter((m) => !ids.has(m.id))]);
}

/**
 * 从回收站恢复一个条目（按种类交给对应的模块）。
 *
 * @param entry 条目。
 * @throws 后端错误（条目不存在、同名已存在…）。
 */
export async function restoreTrashEntry(entry: TrashEntry): Promise<void> {
  switch (entry.kind) {
    case "skill":
      await useSkillStore.getState().restore(entry.id);
      return;
    case "mcp":
      await useMcpStore.getState().restore(entry.id);
      return;
    case "memory": {
      const items = memoryListSchema.parse(JSON.parse(await trashTakeJson(entry.id)));
      await useAiMemoryStore.getState().load();
      mergeMemory(items);
      return;
    }
    case "ai-prefs": {
      const v = JSON.parse(await trashTakeJson(entry.id)) as Partial<PrefsBackup>;
      useAiPrefsStore.setState({
        autoApply: v.autoApply === true,
        disabledSkills: Array.isArray(v.disabledSkills) ? v.disabledSkills.filter((x) => typeof x === "string") : [],
        mcpAlwaysAllow: Array.isArray(v.mcpAlwaysAllow) ? v.mcpAlwaysAllow.filter((x) => typeof x === "string") : [],
      });
      return;
    }
    default:
      throw new Error("not_found");
  }
}
