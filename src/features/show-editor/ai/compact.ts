import type { ModelMessage } from "ai";

/**
 * 长对话压缩：发给模型之前，把较早的轮次里的工具细节去掉（不调用模型做摘要，规则确定）。
 *
 * - 最近 `keepTurns` 轮（从用户的一句话到下一句之前）原样保留；
 * - 更早的轮次：用户消息与助手的文字保留；`propose_ops` 换成一行“提议了什么、结局如何”，
 *   `remember` 换成一行“提议记住什么、结局如何”，外部（MCP）工具换成一行“调用了哪个工具、结局如何”（结果不再带上），
 *   其它工具调用、工具结果与推理过程删掉；
 * - 仍然超过 `maxMessages` 条时，从最早的压缩部分按整轮删起（保留的轮次不动，避免拆开工具调用与结果）。
 *
 * 少了大段的工具结果，长对话的 token 更少，模型也更不容易被很早以前的细节带偏。
 */

/** 压缩选项。 */
export interface CompactOptions {
  /** 最近几轮原样保留 */
  keepTurns?: number;
  /** 最多发多少条消息 */
  maxMessages?: number;
  /** 工具调用的结局（提议卡片：applied / discarded / replaced；记忆卡片：saved / ignored） */
  outcomeOf?: (toolCallId: string) => string | undefined;
}

/** 默认保留的轮数。 */
export const KEEP_TURNS = 4;

/** 默认最多的消息数。 */
export const MAX_SENT_MESSAGES = 40;

type AssistantPart = Exclude<Extract<ModelMessage, { role: "assistant" }>["content"], string>[number];

/** 工具调用换成的一行文字；返回 `null` 表示删掉。 */
function toolLine(part: Extract<AssistantPart, { type: "tool-call" }>, outcomeOf: CompactOptions["outcomeOf"]): string | null {
  const input = (part.input ?? {}) as { summary?: unknown; text?: unknown };
  const outcome = outcomeOf?.(part.toolCallId) ?? "pending";
  if (part.toolName === "propose_ops") return `[proposed a change: ${typeof input.summary === "string" ? input.summary : "?"} (${outcome})]`;
  if (part.toolName === "remember") return `[asked to remember: "${typeof input.text === "string" ? input.text : "?"}" (${outcome})]`;
  // 外部工具：只留调用了什么与结局，结果（外部数据）不再带上
  if (part.toolName.startsWith("mcp__")) return `[called external tool ${part.toolName} (${outcome})]`;
  return null;
}

/** 压缩一条较早的消息；返回 `null` 表示整条删掉。 */
function compactMessage(m: ModelMessage, outcomeOf: CompactOptions["outcomeOf"]): ModelMessage | null {
  if (m.role === "tool") return null;
  if (m.role !== "assistant" || typeof m.content === "string") return m;
  const parts: AssistantPart[] = [];
  for (const p of m.content) {
    if (p.type === "text") {
      if (p.text.trim()) parts.push(p);
    } else if (p.type === "tool-call") {
      const line = toolLine(p, outcomeOf);
      if (line) parts.push({ type: "text", text: line });
    }
  }
  return parts.length > 0 ? { ...m, content: parts } : null;
}

/**
 * 压缩发给模型的消息。
 *
 * @param messages 发给模型的消息（按时间）。
 * @param options 保留轮数、上限与工具结局。
 * @returns 压缩后的消息；同样的输入总是得到同样的结果。
 */
export function compactHistory(messages: readonly ModelMessage[], options: CompactOptions = {}): ModelMessage[] {
  const keepTurns = options.keepTurns ?? KEEP_TURNS;
  const maxMessages = options.maxMessages ?? MAX_SENT_MESSAGES;
  const userAt = messages.flatMap((m, i) => (m.role === "user" ? [i] : []));
  if (userAt.length <= keepTurns) return [...messages];
  const cut = userAt[userAt.length - keepTurns];
  const kept = messages.slice(cut);
  let older = messages
    .slice(0, cut)
    .map((m) => compactMessage(m, options.outcomeOf))
    .filter((m): m is ModelMessage => m !== null);
  // 仍然太长：从最早的整轮删起（系统消息保留）
  while (older.length > 0 && older.length + kept.length > maxMessages) {
    const firstUser = older.findIndex((m) => m.role === "user");
    const nextUser = older.findIndex((m, i) => i > firstUser && m.role === "user");
    const keepSystem = older.slice(0, Math.max(firstUser, 0)).filter((m) => m.role === "system");
    older = nextUser === -1 ? keepSystem : [...keepSystem, ...older.slice(nextUser)];
    if (firstUser === -1) break;
  }
  return [...older, ...kept];
}
