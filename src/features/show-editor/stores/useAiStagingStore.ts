import { create } from "zustand";

import type { AliasMap } from "../ai/aliases";
import { listChanges, type ChangeEntry } from "../ai/changes";
import { planOps, type CompileEnv, type OpEffect, type OpIssue } from "../ai/compile";
import type { AiOp } from "../ai/opsSchema";
import type { ShowProject } from "../lib/project";
import { useEditorUiStore } from "./useEditorUiStore";
import { useProjectStore } from "./useProjectStore";
import { useRestorePointStore } from "./useRestorePointStore";

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
  /** 模型给出的全部操作（`ops` 是去掉被拒绝的之后的） */
  allOps: AiOp[];
  /** 被拒绝的操作（`allOps` 的下标）与原因：`user` 用户拒绝，`dependency` 依赖被拒绝的操作，`failed` 去掉其它操作后跑不通 */
  rejected: { index: number; reason: "user" | "dependency" | "failed"; message?: string }[];
  /** 生效的每条操作的影响（与 `allOps` 一一对应；被拒绝的为 `null`） */
  effects: (OpEffect | null)[];
}

/** 拒绝的结果。 */
export type RejectResult = { ok: true; rejected: number[] } | { ok: false; reason: "none" | "batch" };

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
  const plan = planOps(input.base, input.ops, input.env, input.aliases, { effects: true });
  if (plan.failed) return null;
  return {
    ...input,
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    next: plan.next,
    issues: plan.issues,
    sensitive: plan.sensitive,
    changes: listChanges(input.base, plan.next, input.env.lang),
    allOps: input.ops,
    rejected: [],
    effects: plan.effects ?? [],
  };
}

/**
 * 依赖某条操作的全部操作（传递闭包，不含它自己），只看还生效的操作。
 *
 * @param staged 改动。
 * @param index 操作下标（`allOps`）。
 * @returns 依赖它的操作下标（升序）。
 */
export function dependentsOf(staged: StagedChange, index: number): number[] {
  const out = new Set<number>();
  const queue = [index];
  while (queue.length > 0) {
    const i = queue.shift()!;
    staged.effects.forEach((e, j) => {
      if (e && e.deps.includes(i) && !out.has(j) && j !== index) {
        out.add(j);
        queue.push(j);
      }
    });
  }
  return [...out].sort((a, b) => a - b);
}

/** 生效操作在 `allOps` 里的下标。 */
const activeIndices = (staged: Pick<StagedChange, "allOps">, rejected: ReadonlySet<number>) =>
  staged.allOps.map((_, i) => i).filter((i) => !rejected.has(i));

/**
 * 换一组被拒绝的操作重新试运行：去掉它们后仍有操作出错时，把出错的也标成拒绝（原因 `failed`）再试，
 * 保证结果总能应用；整批的错误（结果不是合法工程）时放弃这次改动。
 *
 * @param staged 当前的改动。
 * @param rejected 新的拒绝列表。
 * @returns 新的改动；整批出错时为 `null`。
 */
export function restage(staged: StagedChange, rejected: StagedChange["rejected"]): StagedChange | null {
  const list = [...rejected];
  for (let guard = 0; guard <= staged.allOps.length; guard += 1) {
    const set = new Set(list.map((r) => r.index));
    const keep = activeIndices(staged, set);
    const ops = keep.map((i) => staged.allOps[i]);
    const plan = planOps(staged.base, ops, staged.env, staged.aliases, { effects: true });
    if (!plan.failed) {
      const effects = plan.effects ?? [];
      const byIndex: (OpEffect | null)[] = staged.allOps.map(() => null);
      keep.forEach((orig, k) => {
        const e = effects[k];
        byIndex[orig] = { ...e, deps: e.deps.map((d) => keep[d]) };
      });
      return {
        ...staged,
        ops,
        next: plan.next,
        issues: plan.issues.map((i) => (i.index >= 0 ? { ...i, index: keep[i.index] } : i)),
        sensitive: plan.sensitive,
        changes: listChanges(staged.base, plan.next, staged.env.lang),
        rejected: list.sort((a, b) => a.index - b.index),
        effects: byIndex,
      };
    }
    const failing = plan.issues.filter((i) => i.level === "error" && i.index >= 0);
    if (failing.length === 0) return null;
    for (const f of failing) list.push({ index: keep[f.index], reason: "failed", message: f.message });
  }
  return null;
}

/**
 * 拒绝暂存改动里的一条操作，连同依赖它的操作。
 *
 * @param index 操作下标（`allOps`）。
 * @returns 一起被拒绝的操作；整批出错（无法单独拒绝这一条）或没有改动时失败。
 */
export function rejectOp(index: number): RejectResult {
  const staged = useAiStagingStore.getState().staged;
  if (!staged || !staged.allOps[index] || staged.rejected.some((r) => r.index === index)) return { ok: false, reason: "none" };
  const deps = dependentsOf(staged, index);
  const next = restage(staged, [
    ...staged.rejected,
    { index, reason: "user" },
    ...deps.filter((d) => !staged.rejected.some((r) => r.index === d)).map((d) => ({ index: d, reason: "dependency" as const })),
  ]);
  if (!next) return { ok: false, reason: "batch" };
  // 拒绝光了：等于放弃整份改动
  if (next.ops.length === 0) {
    useAiStagingStore.getState().discard();
    return { ok: true, rejected: next.rejected.map((r) => r.index) };
  }
  useAiStagingStore.setState({ staged: next });
  return { ok: true, rejected: next.rejected.filter((r) => !staged.rejected.some((o) => o.index === r.index)).map((r) => r.index) };
}

/**
 * 恢复被拒绝的操作（不给参数时全部恢复）。恢复后仍跑不通的会再被标成拒绝。
 *
 * @param indices 要恢复的操作下标；省略为全部。
 * @returns 是否恢复了（整批出错时不变）。
 */
export function restoreOps(indices?: readonly number[]): boolean {
  const staged = useAiStagingStore.getState().staged;
  if (!staged || staged.rejected.length === 0) return false;
  const keep = indices ? staged.rejected.filter((r) => !indices.includes(r.index)) : [];
  // 恢复的操作依赖的、仍被拒绝的操作也一起恢复
  const restoring = new Set(staged.rejected.filter((r) => !keep.includes(r)).map((r) => r.index));
  const needed = new Set<number>();
  const full = planOps(staged.base, staged.allOps, staged.env, staged.aliases, { effects: true }).effects ?? [];
  for (const i of restoring) for (const d of full[i]?.deps ?? []) needed.add(d);
  const next = restage(staged, keep.filter((r) => !needed.has(r.index)).map((r) => ({ index: r.index, reason: r.reason })));
  if (!next) return false;
  useAiStagingStore.setState({ staged: next });
  return true;
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
  // 记下还原点（AI 历史里可以只撤回这一次、恢复到这次之前或重新应用）
  useRestorePointStore.getState().record(base, useProjectStore.getState().project, { summary: staged.summary, source: staged.source, sourceId: staged.sourceId });
  const before = new Set(base.cues.map((c) => c.id));
  const cueIds = next.cues.filter((c) => !before.has(c.id)).map((c) => c.id);
  if (cueIds.length > 0) useEditorUiStore.getState().selectCues(cueIds);
  useAiStagingStore.setState((s) => ({ staged: null, outcomes: withOutcome(s.outcomes, s.staged, "applied") }));
  return { ok: true, cueIds };
}
