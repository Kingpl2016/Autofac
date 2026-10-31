import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";

import { buildAliases } from "../ai/aliases";
import { planOps, type CompileEnv } from "../ai/compile";
import { aiOpsSchema } from "../ai/opsSchema";
import { suggestionOps, suggestTimeline, type Suggestion } from "../ai/suggestions";
import type { Cue, ShowProject } from "../lib/project";
import { useAiChatStore } from "./useAiChatStore";
import { useAiStagingStore } from "./useAiStagingStore";
import { allTemplates, useCueTemplateStore } from "./useCueTemplateStore";
import { useEditorPrefsStore } from "./useEditorPrefsStore";
import { useEditorUiStore } from "./useEditorUiStore";
import { allEffects, useEffectLibraryStore } from "./useEffectLibraryStore";
import { currentAnalysis, useMediaAnalysisStore, useTimelineAnalysis } from "./useMediaAnalysisStore";
import { useProjectStore } from "./useProjectStore";
import { useRestorePointStore } from "./useRestorePointStore";
import { useFixtureStore } from "@/features/fixtures";
import i18n from "@/shared/i18n";

/** 建议的说明（还原点里显示）。 */
const suggestionSummary = (s: Suggestion) => {
  const args = Object.fromEntries(Object.entries(s.text.args ?? {}).map(([k, v]) => [k, typeof v === "string" && v.startsWith("editor.") ? i18n.t(v) : v]));
  return String(i18n.t(s.text.key, args));
};

/**
 * 时间线上的主动建议：规则给出（`ai/suggestions.ts`），在时间线上画成点线虚影。
 * 悬停 / 播放头所在的建议是“当前建议”：Tab 采纳（一步撤销，不记成范例），Esc 忽略（跟着工程记下）。
 * 有待审阅的 AI 改动时不显示（避免两种虚影混在一起）；在“分析”菜单里可以关掉。
 */

interface SuggestionState {
  /** 鼠标悬停的建议 */
  hoverId: string | null;
  /**
   * 设置悬停的建议。
   *
   * @param id 建议键；`null` 清除。
   */
  setHover: (id: string | null) => void;
}

/** 建议的界面状态。 */
export const useAiSuggestionStore = create<SuggestionState>((set) => ({
  hoverId: null,
  setHover: (hoverId) => set({ hoverId }),
}));

/** 一条建议试运行的结果。 */
export interface SuggestionPlan {
  next: ShowProject;
  /** 新增 / 修改后的片段（虚影） */
  cues: Cue[];
  /** 会新建轨道（例如重音轨道） */
  newTracks: number;
}

/** 编译用的外部数据（特效库、模板库、灯具素材库与分析）。 */
function compileEnv(project: ShowProject): CompileEnv {
  const ui = useEditorUiStore.getState();
  return {
    effects: allEffects(useEffectLibraryStore.getState()),
    templates: allTemplates(useCueTemplateStore.getState()),
    libraryModels: useFixtureStore.getState().models,
    lang: "en",
    playheadMs: ui.playheadMs,
    selection: [],
    analysis: currentAnalysis(project),
  };
}

/** 试运行的缓存：同一工程（引用）上的同一条建议只算一次（词汇表变化时整个换掉）。 */
let planCache = new WeakMap<ShowProject, Map<string, SuggestionPlan | null>>();
/** 缓存对应的词汇表。 */
let planLibs: readonly unknown[] = [];

/**
 * 在工程上试运行一条建议。
 *
 * @param project 工程。
 * @param s 建议。
 * @param env 编译用的外部数据；省略时从各个 store 取。
 * @returns 结果；跑不通时为 `null`。
 */
export function planSuggestion(project: ShowProject, s: Suggestion, env?: CompileEnv): SuggestionPlan | null {
  // 词汇表（特效库、模板库）变了：之前的试运行结果作废
  const libs = [useEffectLibraryStore.getState().user, useCueTemplateStore.getState().user] as const;
  if (libs.some((x, i) => x !== planLibs[i])) {
    planCache = new WeakMap();
    planLibs = libs;
  }
  let plans = planCache.get(project);
  if (!plans) {
    plans = new Map();
    planCache.set(project, plans);
  }
  const hit = plans.get(s.id);
  if (hit !== undefined) return hit;
  const aliases = buildAliases(project);
  const raw = suggestionOps(s, aliases.toAlias);
  const parsed = raw ? aiOpsSchema.safeParse(raw) : null;
  let result: SuggestionPlan | null = null;
  if (parsed?.success) {
    const plan = planOps(project, parsed.data.ops, env ?? compileEnv(project), aliases, { effects: true });
    if (!plan.failed) {
      const byId = new Map(plan.next.cues.map((c) => [c.id, c]));
      const ids = new Set((plan.effects ?? []).flatMap((e) => [...e.added, ...e.changed]));
      const before = new Set(project.tracks.map((t) => t.id));
      result = {
        next: plan.next,
        cues: [...ids].flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])),
        newTracks: plan.next.tracks.filter((t) => !before.has(t.id)).length,
      };
    }
  }
  plans.set(s.id, result);
  return result;
}

/** 建议列表的缓存（工程、分析、忽略记录都没变时复用）。 */
let listCache: { project: ShowProject; sources: readonly unknown[]; dismissed: readonly string[]; list: Suggestion[] } | null = null;

/**
 * 当前显示的建议（关掉建议、有待审阅的改动时为空）。
 *
 * @returns 建议。
 */
export function currentSuggestions(): Suggestion[] {
  if (!useEditorPrefsStore.getState().aiSuggestions || useAiStagingStore.getState().staged) return [];
  const project = useProjectStore.getState().project;
  const dismissed = useAiChatStore.getState().dismissedSuggestions;
  // 分析每次换算都是新对象：按它的来源（分析状态与素材设置）判断是否变化
  const sources = [useMediaAnalysisStore.getState().entries, useMediaAnalysisStore.getState().videos, useAiChatStore.getState().media] as const;
  if (listCache && listCache.project === project && listCache.dismissed === dismissed && listCache.sources.every((x, i) => x === sources[i])) {
    return listCache.list;
  }
  // 试运行留到显示 / 采纳时再做（只算看得见的几条）
  const list = suggestTimeline(project, currentAnalysis(project), dismissed);
  listCache = { project, sources, dismissed, list };
  return list;
}

/**
 * 当前建议：悬停的，否则播放头所在的那条。
 *
 * @returns 建议；没有时为 `null`。
 */
export function activeSuggestion(): Suggestion | null {
  const list = currentSuggestions();
  const hover = useAiSuggestionStore.getState().hoverId;
  const playhead = useEditorUiStore.getState().playheadMs;
  const project = useProjectStore.getState().project;
  const ok = (s: Suggestion) => planSuggestion(project, s) !== null;
  return list.find((s) => s.id === hover && ok(s)) ?? list.find((s) => playhead >= s.startMs && playhead < s.endMs && ok(s)) ?? null;
}

/**
 * 采纳建议：写进工程（一步撤销），选中新放的片段。不记成范例。
 *
 * @param s 建议。
 * @returns 是否写入。
 */
export function acceptSuggestion(s: Suggestion): boolean {
  const store = useProjectStore.getState();
  const base = store.project;
  const plan = planSuggestion(base, s);
  if (!plan) return false;
  const next = plan.next;
  store.update((d) => {
    for (const key of Object.keys(next) as (keyof ShowProject)[]) {
      if (next[key] !== base[key]) (d as unknown as Record<string, unknown>)[key] = next[key];
    }
  });
  useRestorePointStore.getState().record(base, useProjectStore.getState().project, { summary: suggestionSummary(s), source: "suggestion" });
  const before = new Set(base.cues.map((c) => c.id));
  const added = next.cues.filter((c) => !before.has(c.id)).map((c) => c.id);
  if (added.length > 0) useEditorUiStore.getState().selectCues(added);
  useAiSuggestionStore.getState().setHover(null);
  return true;
}

/**
 * 忽略建议（跟着工程记下，在“分析”菜单里可以让它们重新出现）。
 *
 * @param s 建议。
 */
export function dismissSuggestion(s: Suggestion): void {
  useAiChatStore.getState().dismissSuggestion(s.id);
  useAiSuggestionStore.getState().setHover(null);
}

/** 工程停止变化多久后再更新建议（拖动片段时不每帧重算）。 */
export const SUGGESTION_SETTLE_MS = 300;

/**
 * 当前显示的建议（hook：工程、分析、忽略记录、开关或暂存区变化时更新；工程连续变化时等它停下来）。
 *
 * @returns 建议与当前工程（虚影按它试运行）。
 */
export function useTimelineSuggestions(): { list: Suggestion[]; project: ShowProject } {
  const live = useProjectStore((s) => s.project);
  const analysis = useTimelineAnalysis();
  const dismissed = useAiChatStore((s) => s.dismissedSuggestions);
  const on = useEditorPrefsStore((s) => s.aiSuggestions);
  const staged = useAiStagingStore((s) => s.staged !== null);
  // 词汇表读入后（特效 / 模板）试运行结果可能变化
  const effects = useEffectLibraryStore((s) => s.status);
  const templates = useCueTemplateStore((s) => s.status);
  const [project, setProject] = useState(live);
  useEffect(() => {
    if (live === project) return;
    const id = window.setTimeout(() => setProject(live), SUGGESTION_SETTLE_MS);
    return () => window.clearTimeout(id);
  }, [live, project]);
  const list = useMemo(() => {
    void analysis;
    void dismissed;
    void effects;
    void templates;
    if (!on || staged) return [];
    return suggestTimeline(project, currentAnalysis(project), useAiChatStore.getState().dismissedSuggestions);
  }, [project, analysis, dismissed, on, staged, effects, templates]);
  // 工程还在变时先沿用上一次的建议（停下来后再更新）
  return { list, project };
}
