import { useAiMemoryStore } from "@/features/ai";
import { useFixtureStore } from "@/features/fixtures";
import type { ShowProject } from "../lib/project";
import { useAiChatStore } from "../stores/useAiChatStore";
import { useAiExemplarStore } from "../stores/useAiExemplarStore";
import { allTemplates, useCueTemplateStore } from "../stores/useCueTemplateStore";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { allEffects, useEffectLibraryStore } from "../stores/useEffectLibraryStore";
import { useProjectStore } from "../stores/useProjectStore";
import { buildAliases, type AliasMap } from "./aliases";
import type { CompileEnv } from "./compile";
import type { SummaryOptions } from "./context";
import type { MemorySnapshot } from "./memory";

/**
 * 从编辑器的各个 store 取出一次 AI 调用需要的“快照”：工程、别名表、编译用的外部数据与编辑状态。
 * 一次请求（含工具调用与重试）内都用同一份快照，模型看到的别名与执行时一致。
 */

/** 一次 AI 调用的快照。 */
export interface EditorSnapshot {
  project: ShowProject;
  aliases: AliasMap;
  env: CompileEnv;
  summary: SummaryOptions;
}

/**
 * 当前可用的记忆：个人偏好、本工程笔记与范例、所有工程共用的范例。
 *
 * @returns 记忆快照。
 */
export function memorySnapshot(): MemorySnapshot {
  const chat = useAiChatStore.getState();
  return {
    prefs: useAiMemoryStore.getState().prefs,
    notes: chat.notes,
    exemplars: chat.exemplars,
    shared: useAiExemplarStore.getState().items,
  };
}

/** 确保特效库、模板库、灯具素材库与记忆已读入（AI 的词汇表来自它们）。 */
export async function ensureLibraries(): Promise<void> {
  const jobs: Promise<void>[] = [useAiMemoryStore.getState().load(), useAiExemplarStore.getState().load()];
  const effects = useEffectLibraryStore.getState();
  if (effects.status === "idle") jobs.push(effects.load());
  const templates = useCueTemplateStore.getState();
  if (templates.status === "idle") jobs.push(templates.load());
  const fixtures = useFixtureStore.getState();
  if (fixtures.status === "idle") jobs.push(fixtures.load());
  await Promise.all(jobs);
}

/**
 * 取当前编辑器的快照。
 *
 * @param lang 界面语言。
 * @returns 快照。
 */
export function editorSnapshot(lang: string): EditorSnapshot {
  const project = useProjectStore.getState().project;
  const ui = useEditorUiStore.getState();
  const alive = new Set(project.cues.map((c) => c.id));
  const selection = ui.selectedCueIds.filter((id) => alive.has(id));
  return {
    project,
    aliases: buildAliases(project),
    env: {
      effects: allEffects(useEffectLibraryStore.getState()),
      templates: allTemplates(useCueTemplateStore.getState()),
      libraryModels: useFixtureStore.getState().models,
      lang,
      playheadMs: ui.playheadMs,
      selection,
    },
    summary: { playheadMs: ui.playheadMs, selection, selectedTracks: ui.selectedTrackIds, timeRange: ui.timeRange },
  };
}
