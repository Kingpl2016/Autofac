import type { UIMessage } from "ai";
import { z } from "zod";

import { aiHistoryLibraryPath, memoryListSchema, type MemoryItem } from "@/features/ai";
import type { DocumentOrigin } from "../stores/useDocumentStore";
import type { StagedOutcome } from "../stores/useAiStagingStore";
import { exemplarListSchema, type Exemplar } from "./memory";
import { PROMPT_VERSION } from "./prompt";

/**
 * AI 对话记录文件：跟着工程走，但不写进工程文件（`.artshow` 的格式不变）。
 *
 * - 库外工程：同目录的 `<文件名>.ai.json`（例如 `演出.artshow.ai.json`）；
 * - 节目库里的工程：数据目录下 `ai-history/<路径散列>.ai.json`（节目库按文件组改名 / 删除，不放进录制目录，
 *   避免留下孤立文件；节目改名后对话记录不再关联）；
 * - 还没保存过的工程：只在内存里，第一次保存时一起写盘。
 *
 * 第 2 版保存整棵消息树（编辑重发、重新生成产生的各个版本）与当前看的版本（`headId`），
 * 以及提议卡片 / 记忆卡片的结局和本工程的记忆（笔记、范例）。第 1 版（只有一条消息线）读入时当作一条线的树。
 */

/** 文件格式版本。 */
export const HISTORY_VERSION = 2;

/** 当前版本最多保留多少条消息（超出时丢掉最早的）。 */
export const MAX_BRANCH_MESSAGES = 200;

/** 整棵树最多保留多少条消息（超出时先删最早的、不在当前版本上的分支）。 */
export const MAX_TREE_MESSAGES = 400;

/** 消息树的一项。 */
export interface TreeItem {
  /** 上一条消息；第一条为 `null` */
  parentId: string | null;
  message: UIMessage;
}

/** 记忆卡片（`remember` 工具）的结局。 */
export type MemoryCardOutcome = "saved" | "ignored";

/** 一个工程的对话：消息树、当前版本、卡片结局与本工程的记忆。 */
export interface ChatDoc {
  tree: TreeItem[];
  /** 当前看的版本的最后一条消息；没有消息时为 `null` */
  headId: string | null;
  /** 最后使用的 AI 配置 */
  profileId: string | null;
  /** 提议卡片的结局：工具调用 id → 结局 */
  proposals: Record<string, StagedOutcome>;
  /** 记忆卡片的结局：工具调用 id → 结局 */
  memoryCards: Record<string, MemoryCardOutcome>;
  /** 本工程笔记 */
  notes: MemoryItem[];
  /** 本工程范例 */
  exemplars: Exemplar[];
}

/**
 * 空的对话。
 *
 * @returns 新对象。
 */
export function emptyChatDoc(): ChatDoc {
  return { tree: [], headId: null, profileId: null, proposals: {}, memoryCards: {}, notes: [], exemplars: [] };
}

const messageSchema = z.looseObject({
  id: z.string(),
  role: z.enum(["system", "user", "assistant"]),
  parts: z.array(z.looseObject({ type: z.string() })),
});

const v1Schema = z.object({
  version: z.literal(1),
  profileId: z.string().nullable().catch(null),
  messages: z.array(messageSchema),
});

const v2Schema = z.object({
  version: z.literal(2),
  profileId: z.string().nullable().catch(null),
  tree: z.array(z.object({ parentId: z.string().nullable(), message: messageSchema })),
  headId: z.string().nullable().catch(null),
  proposals: z.record(z.string(), z.enum(["applied", "discarded", "replaced"])).catch({}),
  memoryCards: z.record(z.string(), z.enum(["saved", "ignored"])).catch({}),
  notes: memoryListSchema,
  exemplars: exemplarListSchema,
});

/** 路径的稳定散列（FNV-1a 64 位的两段 32 位，十六进制）。 */
function pathKey(path: string): string {
  const s = path.replace(/\\/g, "/").toLowerCase();
  let h1 = 0x811c_9dc5;
  let h2 = 0x0100_0193;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x0100_0193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x0100_0193 ^ 0x5bd1_e995) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

/**
 * 工程的对话记录文件路径。
 *
 * @param origin 工程来源。
 * @returns 路径；还没保存过的工程为 `null`。
 */
export async function historyPath(origin: DocumentOrigin): Promise<string | null> {
  switch (origin.kind) {
    case "none":
      return null;
    case "external":
      return `${origin.path}.ai.json`;
    case "library":
      return aiHistoryLibraryPath(`lib-${pathKey(origin.path)}`);
  }
}

/**
 * 一条消息线 → 树。
 *
 * @param messages 按顺序的消息。
 * @returns 树（每条的上一条是前一条）。
 */
export function chainTree(messages: readonly UIMessage[]): TreeItem[] {
  return messages.map((message, i) => ({ parentId: i === 0 ? null : messages[i - 1].id, message }));
}

/**
 * 当前版本：从 `headId` 沿上一条往回走到第一条。
 *
 * @param tree 消息树。
 * @param headId 当前版本的最后一条。
 * @returns 当前版本的消息（从第一条起）；`headId` 不在树里时为空。
 */
export function currentBranch(tree: readonly TreeItem[], headId: string | null): UIMessage[] {
  const byId = new Map(tree.map((t) => [t.message.id, t]));
  const out: UIMessage[] = [];
  const seen = new Set<string>();
  for (let id = headId; id !== null && !seen.has(id); ) {
    const item = byId.get(id);
    if (!item) break;
    seen.add(id);
    out.push(item.message);
    id = item.parentId;
  }
  return out.reverse();
}

/**
 * 把当前版本并进树：已有的消息原地更新（位置不变），新的加在后面。
 *
 * @param tree 消息树。
 * @param branch 当前版本的消息（从第一条起）。
 * @returns 新树。
 */
export function mergeBranch(tree: readonly TreeItem[], branch: readonly UIMessage[]): TreeItem[] {
  const index = new Map(tree.map((t, i) => [t.message.id, i]));
  const out = [...tree];
  branch.forEach((message, i) => {
    const item = { parentId: i === 0 ? null : branch[i - 1].id, message };
    const at = index.get(message.id);
    if (at === undefined) {
      index.set(message.id, out.length);
      out.push(item);
    } else out[at] = item;
  });
  return out;
}

/** 某条消息与它的全部后代的 id。 */
function subtree(tree: readonly TreeItem[], rootId: string): Set<string> {
  const ids = new Set([rootId]);
  // 树按“先父后子”的顺序生成，一次正向扫描即可；为保险起见扫到不再增长
  for (let grew = true; grew; ) {
    grew = false;
    for (const t of tree) {
      if (t.parentId !== null && ids.has(t.parentId) && !ids.has(t.message.id)) {
        ids.add(t.message.id);
        grew = true;
      }
    }
  }
  return ids;
}

/**
 * 修剪消息树：当前版本只留最近的 `maxBranch` 条（更早的连同它们的其它分支一起删），
 * 整棵树超过 `maxTree` 条时从最早的、不在当前版本上的分支删起（整个分支一起删）。
 *
 * @param tree 消息树。
 * @param headId 当前版本的最后一条。
 * @param limits 上限。
 * @returns 修剪后的树（顺序不变）。
 */
export function pruneTree(
  tree: readonly TreeItem[],
  headId: string | null,
  limits = { maxBranch: MAX_BRANCH_MESSAGES, maxTree: MAX_TREE_MESSAGES },
): TreeItem[] {
  const branch = currentBranch(tree, headId);
  const onBranch = new Set(branch.map((m) => m.id));
  let out = [...tree];
  if (branch.length > limits.maxBranch) {
    const first = branch[branch.length - limits.maxBranch];
    // 新的第一条之前的一切（包括挂在它们上的其它分支）都删掉
    const keep = subtree(out, first.id);
    out = out.filter((t) => keep.has(t.message.id)).map((t) => (t.message.id === first.id ? { ...t, parentId: null } : t));
  }
  while (out.length > limits.maxTree) {
    // 最早的分支起点：父在当前版本上（或没有父），自己不在当前版本上
    const root = out.find((t) => !onBranch.has(t.message.id));
    if (!root) break;
    const drop = subtree(out, root.message.id);
    out = out.filter((t) => !drop.has(t.message.id));
  }
  return out;
}

/** 树里出现过的工具调用 id。 */
function toolCallIds(tree: readonly TreeItem[]): Set<string> {
  const ids = new Set<string>();
  for (const t of tree) {
    for (const p of t.message.parts) {
      const id = (p as { toolCallId?: unknown }).toolCallId;
      if (typeof id === "string") ids.add(id);
    }
  }
  return ids;
}

/** 只留树里还有的工具调用的结局。 */
function pick<T>(outcomes: Record<string, T>, ids: ReadonlySet<string>): Record<string, T> {
  return Object.fromEntries(Object.entries(outcomes).filter(([id]) => ids.has(id)));
}

/**
 * 解析对话记录文件；版本不对、结构不对时当作没有记录（不报错，旧记录不影响使用）。
 * 第 1 版读成一条线的树。
 *
 * @param text 文件内容。
 * @returns 对话。
 */
export function parseHistory(text: string): ChatDoc {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return emptyChatDoc();
  }
  const v2 = v2Schema.safeParse(raw);
  if (v2.success) {
    const tree = v2.data.tree as unknown as TreeItem[];
    const ids = new Set(tree.map((t) => t.message.id));
    const headId = v2.data.headId && ids.has(v2.data.headId) ? v2.data.headId : (tree.at(-1)?.message.id ?? null);
    return { ...v2.data, tree, headId };
  }
  const v1 = v1Schema.safeParse(raw);
  if (v1.success) {
    const messages = (v1.data.messages as unknown as UIMessage[]).slice(-MAX_BRANCH_MESSAGES);
    return { ...emptyChatDoc(), profileId: v1.data.profileId, tree: chainTree(messages), headId: messages.at(-1)?.id ?? null };
  }
  return emptyChatDoc();
}

/**
 * 序列化对话记录：修剪消息树，只保留树里还有的卡片结局。
 *
 * @param doc 对话。
 * @returns 文件内容。
 */
export function serializeHistory(doc: ChatDoc): string {
  const tree = pruneTree(doc.tree, doc.headId);
  const ids = toolCallIds(tree);
  const alive = new Set(tree.map((t) => t.message.id));
  return JSON.stringify({
    version: HISTORY_VERSION,
    promptVersion: PROMPT_VERSION,
    profileId: doc.profileId,
    tree,
    headId: doc.headId && alive.has(doc.headId) ? doc.headId : (tree.at(-1)?.message.id ?? null),
    proposals: pick(doc.proposals, ids),
    memoryCards: pick(doc.memoryCards, ids),
    notes: doc.notes,
    exemplars: doc.exemplars,
  });
}
