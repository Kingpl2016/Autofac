import { beforeEach, describe, expect, it, vi } from "vitest";

const trash = vi.hoisted(() => ({ entries: new Map<string, { kind: string; label: string; json: string }>(), n: 0 }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/shared/tauri/tauriStorage", () => ({
  createTauriPersistStorage: () => ({ getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined }),
}));
vi.mock("../skillsApi", async (orig) => ({
  ...(await orig<typeof import("../skillsApi")>()),
  trashPutJson: async (kind: string, label: string, json: string) => {
    const id = `t${(trash.n += 1)}`;
    trash.entries.set(id, { kind, label, json });
    return { id, kind, label, deletedAtMs: 1 };
  },
  trashTakeJson: async (id: string) => {
    const e = trash.entries.get(id);
    if (!e) throw new Error("not_found");
    trash.entries.delete(id);
    return e.json;
  },
  trashRemove: async (id: string) => void trash.entries.delete(id),
}));
vi.mock("../memoryFile", () => ({ memoryFile: () => ({ read: async () => null, write: async () => undefined }) }));

import i18n from "@/shared/i18n";
import { useAiMemoryStore } from "../../stores/useAiMemoryStore";
import { useAiPrefsStore } from "../../stores/useAiPrefsStore";
import { clearUserMemory, removeMemoryItem, resetAiPrefs, restoreTrashEntry } from "../resetActions";

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  trash.entries.clear();
  vi.clearAllMocks();
  useAiPrefsStore.setState({ autoApply: true, disabledSkills: ["a"], mcpAlwaysAllow: ["mcp__x__y"] });
  useAiMemoryStore.setState({ status: "ready", prefs: [{ id: "u-1", text: "不要频闪", enabled: true, createdAt: 1 }, { id: "u-2", text: "偏暖", enabled: true, createdAt: 2 }] });
});

/** 提示里“撤销”按钮的回调。 */
const undoOf = () => (toast.success.mock.calls.at(-1)?.[1] as { action: { onClick: () => void } }).action.onClick;

describe("恢复默认与回收站", () => {
  it("AI 偏好恢复默认：先备份进回收站；撤销恢复原值；也能从回收站恢复", async () => {
    await resetAiPrefs(i18n.t);
    expect(useAiPrefsStore.getState()).toMatchObject({ autoApply: false, disabledSkills: [], mcpAlwaysAllow: [] });
    const [[id, entry]] = [...trash.entries];
    expect(entry.kind).toBe("ai-prefs");
    undoOf()();
    expect(useAiPrefsStore.getState()).toMatchObject({ autoApply: true, disabledSkills: ["a"], mcpAlwaysAllow: ["mcp__x__y"] });
    await Promise.resolve();
    expect(trash.entries.has(id)).toBe(false);

    await resetAiPrefs(i18n.t);
    const [[id2]] = [...trash.entries];
    await restoreTrashEntry({ id: id2, kind: "ai-prefs", label: "", deletedAtMs: 1 });
    expect(useAiPrefsStore.getState().autoApply).toBe(true);
  });

  it("清空个人偏好：进回收站后可恢复；删除单条也可撤销", async () => {
    await clearUserMemory(i18n.t);
    expect(useAiMemoryStore.getState().prefs).toEqual([]);
    const [[id]] = [...trash.entries];
    await restoreTrashEntry({ id, kind: "memory", label: "", deletedAtMs: 1 });
    expect(useAiMemoryStore.getState().prefs.map((m) => m.id)).toEqual(["u-1", "u-2"]);

    await removeMemoryItem("u-1", i18n.t);
    expect(useAiMemoryStore.getState().prefs.map((m) => m.id)).toEqual(["u-2"]);
    undoOf()();
    expect(useAiMemoryStore.getState().prefs.map((m) => m.id).sort()).toEqual(["u-1", "u-2"]);
  });
});
