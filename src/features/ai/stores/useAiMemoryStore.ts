import { z } from "zod";
import { create } from "zustand";

import { addMemory, memoryListSchema, removeMemory, updateMemory, type MemoryItem } from "../lib/memory";
import { memoryFile } from "../lib/memoryFile";

/**
 * 个人偏好记忆：对所有工程都生效的偏好（“不要频闪”“偏暖色”“回复简短”），存在数据目录的
 * `ai-history/memory-user.ai.json`。在设置页与对话的记忆卡片里修改。
 */

/** 文件格式版本。 */
const FILE_VERSION = 1;

const fileSchema = z.object({ version: z.literal(FILE_VERSION), items: memoryListSchema });

const file = memoryFile("memory-user");

interface AiMemoryState {
  /** 读入状态 */
  status: "idle" | "loading" | "ready";
  prefs: MemoryItem[];
  /** 读入（只读一次）。 */
  load: () => Promise<void>;
  /**
   * 添加一条偏好。
   *
   * @param text 文字。
   * @returns 是否已经有同样的内容。
   */
  add: (text: string) => boolean;
  /**
   * 修改一条偏好。
   *
   * @param id 条目 id。
   * @param patch 文字或启用状态。
   */
  update: (id: string, patch: Partial<Pick<MemoryItem, "text" | "enabled">>) => void;
  /**
   * 删除一条偏好。
   *
   * @param id 条目 id。
   */
  remove: (id: string) => void;
}

/** 改了就写盘。 */
const save = (prefs: MemoryItem[]) => void file.write({ version: FILE_VERSION, items: prefs });

/** 个人偏好记忆。 */
export const useAiMemoryStore = create<AiMemoryState>((set, get) => ({
  status: "idle",
  prefs: [],
  load: async () => {
    if (get().status !== "idle") return;
    set({ status: "loading" });
    const parsed = fileSchema.safeParse(await file.read());
    // 读的过程中已经改过：以内存里的为准（并入读到的旧条目）
    const loaded = parsed.success ? parsed.data.items : [];
    const current = get().prefs;
    const ids = new Set(current.map((m) => m.id));
    const prefs = [...loaded.filter((m) => !ids.has(m.id)), ...current];
    set({ status: "ready", prefs });
    // 读入前写过（只含新条目）：把合并后的完整列表写回
    if (current.length > 0) save(prefs);
  },
  add: (text) => {
    const r = addMemory(get().prefs, text, "u");
    set({ prefs: r.list });
    save(r.list);
    return r.duplicate;
  },
  update: (id, patch) => {
    const prefs = updateMemory(get().prefs, id, patch);
    set({ prefs });
    save(prefs);
  },
  remove: (id) => {
    const prefs = removeMemory(get().prefs, id);
    set({ prefs });
    save(prefs);
  },
}));
