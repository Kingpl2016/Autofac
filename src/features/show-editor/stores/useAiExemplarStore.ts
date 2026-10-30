import { z } from "zod";
import { create } from "zustand";

import { memoryFile, type MemoryFile } from "@/features/ai";
import { addExemplar, exemplarListSchema, MAX_SHARED_EXEMPLARS, type Exemplar } from "../ai/memory";

/**
 * 所有工程共用的范例：应用过、且不含工程别名（灯具、分组、轨道、片段…）的对话改动，
 * 存在数据目录的 `ai-history/memory-exemplars.ai.json`。
 */

/** 文件格式版本。 */
const FILE_VERSION = 1;

const fileSchema = z.object({ version: z.literal(FILE_VERSION), items: exemplarListSchema });

// 第一次用到时再打开（模块加载时不调用别的功能的接口，测试里替换它们也更简单）
let opened: MemoryFile | null = null;
const file = () => (opened ??= memoryFile("memory-exemplars"));

interface AiExemplarState {
  /** 读入状态 */
  status: "idle" | "loading" | "ready";
  items: Exemplar[];
  /** 读入（只读一次）。 */
  load: () => Promise<void>;
  /**
   * 记下一个范例（同一句话只留最新的）。
   *
   * @param ex 范例。
   */
  add: (ex: Exemplar) => void;
  /**
   * 启用 / 停用。
   *
   * @param id 范例 id。
   * @param enabled 是否启用。
   */
  setEnabled: (id: string, enabled: boolean) => void;
  /**
   * 删除。
   *
   * @param id 范例 id。
   */
  remove: (id: string) => void;
  /** 全部清空。 */
  clear: () => void;
}

const save = (items: Exemplar[]) => void file().write({ version: FILE_VERSION, items });

/** 所有工程共用的范例。 */
export const useAiExemplarStore = create<AiExemplarState>((set, get) => {
  const change = (items: Exemplar[]) => {
    set({ items });
    save(items);
  };
  return {
    status: "idle",
    items: [],
    load: async () => {
      if (get().status !== "idle") return;
      set({ status: "loading" });
      const parsed = fileSchema.safeParse(await file().read());
      const current = get().items;
      let items = parsed.success ? parsed.data.items : [];
      for (const ex of current) items = addExemplar(items, ex, MAX_SHARED_EXEMPLARS);
      set({ status: "ready", items });
      // 读入前写过（只含新条目）：把合并后的完整列表写回
      if (current.length > 0) save(items);
    },
    add: (ex) => change(addExemplar(get().items, ex, MAX_SHARED_EXEMPLARS)),
    setEnabled: (id, enabled) => change(get().items.map((e) => (e.id === id ? { ...e, enabled } : e))),
    remove: (id) => change(get().items.filter((e) => e.id !== id)),
    clear: () => change([]),
  };
});
