import { z } from "zod";

/**
 * AI 记忆的通用条目（个人偏好、工程笔记共用）：一句短文字 + 启用开关。
 *
 * 只做纯函数：增删改、去重、上限。存哪里由各自的 store 决定（个人偏好在数据目录，工程笔记跟着工程的对话记录）。
 * 停用的条目保留着，但不会放进提示词（对应 ChatGPT 的“不要再提”）。
 */

/** 一条记忆。 */
export interface MemoryItem {
  /** 稳定 id（记忆来源引用它） */
  id: string;
  text: string;
  /** 停用后不放进提示词 */
  enabled: boolean;
  /** 创建时间（毫秒） */
  createdAt: number;
}

/** 每类最多多少条。 */
export const MAX_MEMORY_ITEMS = 30;

/** 每条最多多少字。 */
export const MAX_MEMORY_TEXT = 200;

const itemSchema = z.object({
  id: z.string().min(1).max(64),
  text: z.string().min(1).max(MAX_MEMORY_TEXT),
  enabled: z.boolean().catch(true),
  createdAt: z.number().catch(0),
});

/** 记忆列表的宽松解析：逐条校验，坏的条目丢掉，整体不对时为空列表。 */
export const memoryListSchema = z
  .array(z.unknown())
  .transform((items) => items.flatMap((i) => {
    const r = itemSchema.safeParse(i);
    return r.success ? [r.data] : [];
  }))
  .catch([]);

/**
 * 规范化记忆文字：去掉首尾空白、合并连续空白、截到上限。
 *
 * @param text 原文。
 * @returns 规范化后的文字（可能为空串）。
 */
export function normalizeMemoryText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_MEMORY_TEXT);
}

/** 比较用的键：规范化 + 小写 + 去掉句末标点。 */
const compareKey = (text: string) => normalizeMemoryText(text).toLowerCase().replace(/[。.!！?？；;，,\s]+$/u, "");

/**
 * 新的记忆 id。
 *
 * @param prefix 前缀（区分类别，如 `u` 个人偏好、`n` 工程笔记）。
 * @returns id。
 */
export function newMemoryId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** 添加的结果。 */
export interface AddMemoryResult {
  list: MemoryItem[];
  /** 新加的条目，或已经存在的同样内容的条目 */
  item: MemoryItem | null;
  /** 已经有同样内容（没有新加；停用的会重新启用） */
  duplicate: boolean;
}

/**
 * 添加一条记忆：同样的内容不重复存（停用的重新启用）；超过上限时丢掉最早的。
 *
 * @param list 现有列表。
 * @param text 文字。
 * @param prefix id 前缀。
 * @param now 当前时间（毫秒）。
 * @returns 新列表与条目；文字为空时列表不变、`item` 为 `null`。
 */
export function addMemory(list: readonly MemoryItem[], text: string, prefix: string, now = Date.now()): AddMemoryResult {
  const clean = normalizeMemoryText(text);
  if (!clean) return { list: [...list], item: null, duplicate: false };
  const key = compareKey(clean);
  const same = list.find((m) => compareKey(m.text) === key);
  if (same) {
    const item = { ...same, enabled: true };
    return { list: list.map((m) => (m.id === same.id ? item : m)), item, duplicate: true };
  }
  const item: MemoryItem = { id: newMemoryId(prefix), text: clean, enabled: true, createdAt: now };
  return { list: [...list, item].slice(-MAX_MEMORY_ITEMS), item, duplicate: false };
}

/**
 * 修改一条记忆（文字或启用状态）；改成空文字时删除。
 *
 * @param list 现有列表。
 * @param id 条目 id。
 * @param patch 要改的字段。
 * @returns 新列表。
 */
export function updateMemory(list: readonly MemoryItem[], id: string, patch: Partial<Pick<MemoryItem, "text" | "enabled">>): MemoryItem[] {
  if (patch.text !== undefined && !normalizeMemoryText(patch.text)) return removeMemory(list, id);
  return list.map((m) =>
    m.id === id ? { ...m, ...patch, ...(patch.text !== undefined ? { text: normalizeMemoryText(patch.text) } : {}) } : m,
  );
}

/**
 * 删除一条记忆。
 *
 * @param list 现有列表。
 * @param id 条目 id。
 * @returns 新列表。
 */
export function removeMemory(list: readonly MemoryItem[], id: string): MemoryItem[] {
  return list.filter((m) => m.id !== id);
}
