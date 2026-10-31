import { z } from "zod";

import type { MemoryItem } from "@/features/ai";

/**
 * 编辑器的 AI 记忆：范例（用户应用过的改动）、挑选规则，以及放进提示词的文字。
 *
 * 和技能一样由代码按确定的规则挑选（关键词重叠打分，不用向量检索）：同一个请求、同一份记忆，
 * 在任何模型上得到的提示词完全相同。只依赖类型，不引入 AI SDK。
 */

/** 一个范例：用户的一句话 → 应用过的操作。 */
export interface Exemplar {
  id: string;
  /** 用户这一轮说的话 */
  request: string;
  /** 模型给的说明 */
  summary: string;
  /** 操作（去掉了值为 `null` 的字段） */
  ops: Record<string, unknown>[];
  enabled: boolean;
  createdAt: number;
}

/** 每个工程最多保留多少个范例。 */
export const MAX_SHOW_EXEMPLARS = 50;

/** 所有工程共用的范例最多多少个。 */
export const MAX_SHARED_EXEMPLARS = 100;

/** 一次最多放进提示词的范例数。 */
export const MAX_PICKED_EXEMPLARS = 3;

/** 范例的操作序列化后最多多少字符（再长就不算“范例”了）。 */
export const MAX_EXEMPLAR_CHARS = 1200;

/** 范例与这句话的相似度至少多少才放进提示词。 */
const MIN_SCORE = 0.3;

const exemplarSchema = z.object({
  id: z.string().min(1).max(64),
  request: z.string().min(1).max(400),
  summary: z.string().max(400).catch(""),
  ops: z.array(z.looseObject({ op: z.string() })).min(1),
  enabled: z.boolean().catch(true),
  createdAt: z.number().catch(0),
});

/** 范例列表的宽松解析：坏的条目丢掉，整体不对时为空列表。 */
export const exemplarListSchema = z
  .array(z.unknown())
  .transform((items) => items.flatMap((i) => {
    const r = exemplarSchema.safeParse(i);
    return r.success ? [r.data as Exemplar] : [];
  }))
  .catch([]);

/** 记忆的类别。 */
export type MemoryKind = "pref" | "note" | "exemplar" | "shared";

/** 一条记忆的引用（回复下方的“参考了哪些记忆”）。 */
export interface MemoryRef {
  kind: MemoryKind;
  id: string;
}

/** 一次模型调用的 token 用量（对话框底部的“上下文用量”）。 */
export interface ContextUsage {
  /** 发给模型的 tokens（系统提示词 + 对话 + 工具结果） */
  input: number;
  /** 模型输出的 tokens */
  output: number;
}

/** 对话回复的元数据：这一轮放进提示词的记忆（回复下方的“参考了哪些记忆”）与最后一步的用量。 */
export interface ReplyMetadata {
  memory?: MemoryRef[];
  /** 这一轮最后一次模型调用的用量（多步工具调用时取最后一步，即对话此刻占用的上下文） */
  context?: ContextUsage;
}

/** 一次请求可用的全部记忆。 */
export interface MemorySnapshot {
  /** 个人偏好（所有工程） */
  prefs: readonly MemoryItem[];
  /** 本工程笔记 */
  notes: readonly MemoryItem[];
  /** 本工程范例 */
  exemplars: readonly Exemplar[];
  /** 所有工程共用的范例 */
  shared: readonly Exemplar[];
}

/** 空的记忆。 */
export const EMPTY_MEMORY: MemorySnapshot = { prefs: [], notes: [], exemplars: [], shared: [] };

/** 比较请求用的键。 */
const requestKey = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase().replace(/[。.!！?？]+$/u, "");

/**
 * 把文字切成比较用的词：中日韩文字取单字与相邻两字，其它按单词（两个字符以上）。
 *
 * @param text 文字。
 * @returns 词的集合。
 */
export function tokens(text: string): Set<string> {
  const out = new Set<string>();
  const lower = text.toLowerCase();
  for (const run of lower.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu) ?? []) {
    const chars = [...run];
    chars.forEach((c, i) => {
      out.add(c);
      if (i + 1 < chars.length) out.add(c + chars[i + 1]);
    });
  }
  for (const word of lower.match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(word)) continue;
    if ([...word].length >= 2) out.add(word);
  }
  return out;
}

/**
 * 两组词的相似度（Dice 系数）。
 *
 * @param a 一组词。
 * @param b 另一组。
 * @returns 0~1；任一为空时为 0。
 */
export function similarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let same = 0;
  for (const t of a) if (b.has(t)) same += 1;
  return (2 * same) / (a.size + b.size);
}

/** 去掉值为 `null` 的字段（范例更短，模型照着写时也不会把 `null` 当成要求）。 */
function stripNulls(op: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(op).filter(([, v]) => v !== null));
}

/** 范例的操作文字。 */
const opsText = (ops: readonly Record<string, unknown>[]) => JSON.stringify(ops);

/**
 * 由应用过的改动生成范例。
 *
 * @param request 用户的话。
 * @param summary 模型的说明。
 * @param ops 操作。
 * @param now 当前时间（毫秒）。
 * @returns 范例；没有用户的话或操作太长时为 `null`。
 */
export function makeExemplar(request: string, summary: string, ops: readonly object[], now = Date.now()): Exemplar | null {
  const text = request.replace(/\s+/g, " ").trim().slice(0, 400);
  const clean = ops.map(stripNulls);
  if (!text || clean.length === 0 || opsText(clean).length > MAX_EXEMPLAR_CHARS) return null;
  return {
    id: `e-${now.toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    request: text,
    summary: summary.slice(0, 400),
    ops: clean,
    enabled: true,
    createdAt: now,
  };
}

/**
 * 操作里有没有只在当前工程有意义的别名（灯具、分组、轨道、片段、标记点、素材库模型）。
 * 有的范例不放进所有工程共用的范例。段落 `S#` 与 `all` / `movers` / `selection` 不算。
 *
 * @param ops 操作。
 * @returns 是否含工程别名。
 */
export function hasShowAliases(ops: readonly object[]): boolean {
  return /"[FGTCML]\d+(?::[a-z]+)?"/i.test(JSON.stringify(ops));
}

/**
 * 添加一个范例：同一句话只保留最新的一个；超过上限时丢掉最早的。
 *
 * @param list 现有范例。
 * @param ex 新范例。
 * @param limit 上限。
 * @returns 新列表（按时间，最新的在后）。
 */
export function addExemplar(list: readonly Exemplar[], ex: Exemplar, limit: number): Exemplar[] {
  const key = requestKey(ex.request);
  return [...list.filter((e) => requestKey(e.request) !== key), ex].slice(-limit);
}

/** 挑出的范例。 */
interface Picked {
  ex: Exemplar;
  kind: "exemplar" | "shared";
}

/**
 * 按这句话挑选最相关的范例（确定性：相似度从高到低，同分时新的在前，再按 id）。
 * 本工程的范例与共用范例里同一句话只取本工程的。
 *
 * @param text 用户这一轮说的话。
 * @param snapshot 记忆。
 * @param n 最多几个。
 * @returns 范例与来源。
 */
export function pickExemplars(text: string, snapshot: Pick<MemorySnapshot, "exemplars" | "shared">, n = MAX_PICKED_EXEMPLARS): Picked[] {
  const query = tokens(text);
  if (query.size === 0) return [];
  const seen = new Set<string>();
  const scored: (Picked & { score: number })[] = [];
  const pools: [readonly Exemplar[], Picked["kind"]][] = [
    [snapshot.exemplars, "exemplar"],
    [snapshot.shared, "shared"],
  ];
  for (const [pool, kind] of pools) {
    for (const ex of pool) {
      const key = requestKey(ex.request);
      if (!ex.enabled || seen.has(key)) continue;
      seen.add(key);
      const score = similarity(query, tokens(ex.request));
      if (score >= MIN_SCORE) scored.push({ ex, kind, score });
    }
  }
  scored.sort((a, b) => b.score - a.score || b.ex.createdAt - a.ex.createdAt || (a.ex.id < b.ex.id ? -1 : 1));
  return scored.slice(0, n).map(({ ex, kind }) => ({ ex, kind }));
}

/** 放进提示词的记忆与引用。 */
export interface BuiltMemory {
  /** 提示词里的一节；没有记忆时为空串 */
  text: string;
  /** 用到的记忆 */
  used: MemoryRef[];
}

/**
 * 生成这一轮放进提示词的记忆：启用的个人偏好与工程笔记全部放入，对话时再加上最相关的范例。
 *
 * @param snapshot 记忆。
 * @param request 这一轮用户说的话（草稿为描述）。
 * @param mode `chat` 带范例，`draft` 不带。
 * @returns 文字与引用。
 */
export function buildMemory(snapshot: MemorySnapshot, request: string, mode: "chat" | "draft"): BuiltMemory {
  const prefs = snapshot.prefs.filter((m) => m.enabled);
  const notes = snapshot.notes.filter((m) => m.enabled);
  const picked = mode === "chat" ? pickExemplars(request, snapshot) : [];
  const used: MemoryRef[] = [
    ...prefs.map((m) => ({ kind: "pref" as const, id: m.id })),
    ...notes.map((m) => ({ kind: "note" as const, id: m.id })),
    ...picked.map((p) => ({ kind: p.kind, id: p.ex.id })),
  ];
  if (used.length === 0) return { text: "", used };
  const lines = ["Memory (saved by the user earlier; follow it unless the user now asks for something else):"];
  if (prefs.length > 0) lines.push("User preferences (all shows):", ...prefs.map((m) => `- ${m.text}`));
  if (notes.length > 0) lines.push("Notes for this show:", ...notes.map((m) => `- ${m.text}`));
  if (picked.length > 0) {
    lines.push(
      "Changes the user approved before (follow the same style; aliases in them may be outdated, look them up again):",
      ...picked.map(({ ex }) => `- "${ex.request}" → propose_ops(${JSON.stringify({ summary: ex.summary, ops: ex.ops })})`),
    );
  }
  return { text: lines.join("\n"), used };
}
