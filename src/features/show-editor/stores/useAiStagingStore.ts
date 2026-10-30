import { create } from "zustand";

import type { AliasMap } from "../ai/aliases";
import { listChanges, type ChangeEntry } from "../ai/changes";
import { planOps, type CompileEnv, type OpIssue } from "../ai/compile";
import type { AiOp } from "../ai/opsSchema";
import type { ShowProject } from "../lib/project";
import { useEditorUiStore } from "./useEditorUiStore";
import { useProjectStore } from "./useProjectStore";

/**
 * AI 改动的暂存区：模型给出的操作先在工程副本上试运行，用户在审阅卡片里看改动清单、在预览里看效果，
 * 确认后才写进工程（一步撤销）。不进撤销历史，不随工程保存。
 */

/** 一份待审阅的改动。 */
export interface StagedChange {
  /** 每次暂存唯一 */
  id: string;
  /** 模型给用户的一句话说明 */
  summary: string;
  ops: AiOp[];
  /** 生成时的工程 */
  base: ShowProject;
  /** 试运行后的工程（预览用；工程没变时直接写入它） */
  next: ShowProject;
  /** 操作针对的别名表（工程变了重新应用时仍按它解析） */
  aliases: AliasMap;
  env: CompileEnv;
  /** 警告（错误已经在暂存前排除） */
  issues: OpIssue[];
  /** 含配接 / 输出 / 大批量删除，自动写入时也要确认 */
  sensitive: boolean;
  source: "draft" | "chat";
  /** 对话里产生这份改动的工具调用 id（对话里的提议卡片据此判断是否就是当前待审阅的这份） */
  sourceId?: string;
  /** 对话里用户这一轮说的话（应用后记成范例） */
  request?: string;
  changes: ChangeEntry[];
}

/** 已经处理过的改动的结局（按 `sourceId` 记）。 */
export type StagedOutcome = "applied" | "discarded" | "replaced";

/** 应用的结果。 */
export type ApplyResult = { ok: true; cueIds: string[] } | { ok: false; reason: "none" | "stale" };

interface AiStagingState {
  staged: StagedChange | null;
  /** 预览里显示暂存的改动（关掉时预览回到当前工程，便于对比） */
  previewing: boolean;
  /**
   * 暂存一份改动（替换之前未处理的）。
   *
   * @param change 改动。
   */
  stage: (change: StagedChange) => void;
  /** 放弃暂存的改动。 */
  discard: () => void;
  /**
   * 预览开关。
   *
   * @param on 是否预览暂存的改动。
   */
  setPreviewing: (on: boolean) => void;
  /** 已处理的对话提议：工具调用 id → 结局（随对话记录写盘，见 `useAiChatStore`） */
  outcomes: Record<string, StagedOutcome>;
}

/** 记下一份改动的结局（有 `sourceId` 时）。 */
function withOutcome(outcomes: Record<string, StagedOutcome>, staged: StagedChange | null, outcome: StagedOutcome) {
  return staged?.sourceId ? { ...outcomes, [staged.sourceId]: outcome } : outcomes;
}

/** 暂存区。 */
export const useAiStagingStore = create<AiStagingState>((set) => ({
  staged: null,
  previewing: true,
  outcomes: {},
  stage: (staged) => set((s) => ({ staged, previewing: true, outcomes: withOutcome(s.outcomes, s.staged, "replaced") })),
  discard: () => set((s) => ({ staged: null, outcomes: withOutcome(s.outcomes, s.staged, "discarded") })),
  setPreviewing: (previewing) => set({ previewing }),
}));

/**
 * 由试运行结果生成待审阅的改动。
 *
 * @param input 操作、说明、来源，以及试运行用的工程、别名表与外部数据。
 * @returns 改动；试运行有错误时为 `null`（调用方应先把错误交给模型修正）。
 */
export function makeStaged(input: {
  summary: string;
  ops: AiOp[];
  base: ShowProject;
  aliases: AliasMap;
  env: CompileEnv;
  source: StagedChange["source"];
  sourceId?: string;
  request?: string;
}): StagedChange | null {
  const plan = planOps(input.base, input.ops, input.env, input.aliases);
  if (plan.failed) return null;
  return {
    ...input,
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    next: plan.next,
    issues: plan.issues,
    sensitive: plan.sensitive,
    changes: listChanges(input.base, plan.next, input.env.lang),
  };
}

/**
 * 把暂存的改动写进工程（一步撤销），并选中新放的片段。
 *
 * 生成之后工程没有变：直接写入预览过的结果（与预览完全一致）。工程变了（期间手动编辑过）：
 * 在当前工程上按同样的别名重新执行一遍操作；对不上（引用的对象被删了等）时不写入，返回 `stale`。
 *
 * @returns 结果与新片段 id。
 */
export function applyStaged(): ApplyResult {
  const staged = useAiStagingStore.getState().staged;
  if (!staged) return { ok: false, reason: "none" };
  const store = useProjectStore.getState();
  let base = staged.base;
  let next = staged.next;
  if (store.project !== staged.base) {
    const plan = planOps(store.project, staged.ops, staged.env, staged.aliases);
    if (plan.failed) return { ok: false, reason: "stale" };
    base = store.project;
    next = plan.next;
  }
  store.update((d) => {
    // 只替换变了的顶层字段：没变的保持同一引用，撤销历史的描述与预览缓存都按引用判断
    for (const key of Object.keys(next) as (keyof ShowProject)[]) {
      if (next[key] !== base[key]) (d as unknown as Record<string, unknown>)[key] = next[key];
    }
  });
  const before = new Set(base.cues.map((c) => c.id));
  const cueIds = next.cues.filter((c) => !before.has(c.id)).map((c) => c.id);
  if (cueIds.length > 0) useEditorUiStore.getState().selectCues(cueIds);
  useAiStagingStore.setState((s) => ({ staged: null, outcomes: withOutcome(s.outcomes, s.staged, "applied") }));
  return { ok: true, cueIds };
}
