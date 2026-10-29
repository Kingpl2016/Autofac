import { produce } from "immer";

import { mergeProject, type MergeOptions, type MergeReport } from "../lib/mergeProject";
import {
  parseProjectText,
  serializeProject,
  showAutosaveClear,
  showExportArtrec,
  showExternalRead,
  showExternalSave,
  showProjectOpen,
  showProjectSave,
  type ArtrecExportReport,
  type ShowFileKind,
} from "../lib/showFile";
import { createEmptyProject, type ShowProject } from "../lib/project";
import { useDocumentStore, type DocumentOrigin } from "../stores/useDocumentStore";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { usePlaybackStore } from "../stores/usePlaybackStore";
import { fileStem, useRecentFilesStore } from "../stores/useRecentFilesStore";
import { useProjectStore } from "../stores/useProjectStore";
import { useTimelineScrollStore } from "../timeline/timelineScrollStore";
import { resetTaps } from "./editorActions";
import { stopPlayback } from "./transportActions";

/**
 * 工程文件的读写动作（不依赖组件，便于测试）。
 *
 * 约定：失败时抛出后端错误码字符串（见 `showErrorText`）；成功后更新“已保存”基线和工程来源。
 * 保存期间用户继续编辑不会丢：基线取的是**写入磁盘的那一刻的快照**，之后的编辑仍然算未保存。
 */

/**
 * 记入最近文件（打开、保存成功后）：显示名取节目名，没有时取文件名。
 *
 * @param origin 工程来源（没有路径时不记）。
 */
function rememberRecent(origin: DocumentOrigin): void {
  if (origin.kind === "none") return;
  const name = useProjectStore.getState().project.name.trim() || fileStem(origin.path);
  useRecentFilesStore.getState().record({ path: origin.path, kind: origin.kind, name, openedAt: Date.now() });
}

/** 保存到节目库的选项。 */
export interface SaveLibraryOptions {
  name: string;
  notes: string;
  /** `true` 时即使当前工程已在库里，也另存为新节目 */
  asNew?: boolean;
}

/**
 * 把当前工程保存进节目库。
 *
 * 会先把名称和备注写进工程（成为一步可撤销的编辑），再序列化保存。
 *
 * @param options 名称、备注和是否另存为新节目。
 * @returns 该节目的 `.artrec` 路径。
 */
export async function saveToLibrary(options: SaveLibraryOptions): Promise<string> {
  const name = options.name.trim();
  const store = useProjectStore.getState();
  store.update((d) => {
    d.name = name;
    d.notes = options.notes;
  });
  const snapshot = useProjectStore.getState().project;
  const origin = useDocumentStore.getState().origin;
  const path = await showProjectSave({
    path: !options.asNew && origin.kind === "library" ? origin.path : undefined,
    name,
    notes: options.notes,
    fileStem: name,
    json: serializeProject(snapshot),
  });
  useDocumentStore.getState().setOrigin({ kind: "library", path });
  useProjectStore.getState().markSaved(snapshot);
  rememberRecent({ kind: "library", path });
  await showAutosaveClear().catch(() => undefined);
  return path;
}

/**
 * 保存到库外的 `.artshow` 文件。
 *
 * @param path 目标路径。
 */
export async function saveToFile(path: string): Promise<void> {
  const snapshot = useProjectStore.getState().project;
  await showExternalSave(path, serializeProject(snapshot));
  useDocumentStore.getState().setOrigin({ kind: "external", path });
  useProjectStore.getState().markSaved(snapshot);
  rememberRecent({ kind: "external", path });
  await showAutosaveClear().catch(() => undefined);
}

/**
 * 保存当前工程到它已有的位置（Ctrl+S）。
 *
 * @returns `"needs-name"` 表示这个工程还没保存过，需要先让用户起名；否则返回 `"saved"`。
 */
export async function saveInPlace(): Promise<"saved" | "needs-name"> {
  const origin = useDocumentStore.getState().origin;
  const { project } = useProjectStore.getState();
  if (origin.kind === "library") {
    await saveToLibrary({ name: project.name || origin.path, notes: project.notes });
    return "saved";
  }
  if (origin.kind === "external") {
    await saveToFile(origin.path);
    return "saved";
  }
  return "needs-name";
}

/**
 * 把解析好的工程装进编辑器，重置与上一个工程相关的界面状态。
 *
 * @param project 要载入的工程。
 * @param origin 工程的来源。
 */
function install(project: ShowProject, origin: DocumentOrigin): void {
  // 换工程时，正在输出的旧节目必须先停下
  if (usePlaybackStore.getState().state?.outputting) void stopPlayback();
  useProjectStore.getState().load(project);
  useDocumentStore.getState().setOrigin(origin);
  rememberRecent(origin);
  useEditorUiStore.setState({
    selectedFixtureIds: [],
    selectedGroupId: null,
    selectedCueIds: [],
    selectedTrackId: null,
    selectedTrackIds: [],
    contextTarget: null,
    hoverFixtureId: null,
    selectedTimelineObject: null,
    playheadMs: 0,
    clipboard: [],
  });
  useTimelineScrollStore.getState().set(0, 0);
  resetTaps();
}

/**
 * 解析工程文本，失败时抛出 `invalid_project`。
 *
 * @param text 工程 JSON 文本。
 * @returns 解析并校验过的工程。
 */
function parseOrThrow(text: string): ShowProject {
  const result = parseProjectText(text);
  if (!result.ok) throw result.reason === "tooNew" ? "project_too_new" : "invalid_project";
  return result.project;
}

/**
 * 打开节目库里的工程。
 *
 * @param path 节目的 `.artrec` 路径。
 */
export async function openFromLibrary(path: string): Promise<void> {
  install(parseOrThrow(await showProjectOpen(path)), { kind: "library", path });
}

/**
 * 打开库外的 `.artshow` 文件。
 *
 * @param path 文件路径。
 */
export async function openFromFile(path: string): Promise<void> {
  install(parseOrThrow(await showExternalRead(path)), { kind: "external", path });
}

/**
 * 载入从自动存档恢复的工程：保持“未保存”状态，来源未知。
 *
 * @param text 自动存档里的工程文本。
 */
export function restoreFromAutosave(text: string): void {
  const project = parseOrThrow(text);
  install(project, { kind: "none" });
  useProjectStore.getState().restore(project);
}

/** 新建空工程。 */
export function newProject(): void {
  install(createEmptyProject(""), { kind: "none" });
}

/**
 * 从磁盘重新载入当前工程，放弃未保存的修改（撤销历史一并清空）。
 *
 * @returns 是否载入了（工程从未保存过时没有可载入的文件，返回 `false`）。
 */
export async function reloadFromDisk(): Promise<boolean> {
  const origin = useDocumentStore.getState().origin;
  if (origin.kind === "none") return false;
  if (origin.kind === "library") await openFromLibrary(origin.path);
  else await openFromFile(origin.path);
  return true;
}

/**
 * 导出工程副本到库外的 `.artshow` 文件：只写文件，当前工程仍保存在原来的位置，未保存状态不变。
 *
 * @param path 目标路径。
 */
export async function exportCopy(path: string): Promise<void> {
  await showExternalSave(path, serializeProject(useProjectStore.getState().project));
}

/**
 * 把当前工程（含未保存的修改）烘焙成 `.artrec` 回放文件。
 *
 * @param path 目标路径。
 * @returns 帧数与文件大小。
 */
export function exportArtrec(path: string): Promise<ArtrecExportReport> {
  return showExportArtrec(path, serializeProject(useProjectStore.getState().project));
}

/**
 * 读取另一个节目（导入用），不影响当前工程。
 *
 * @param kind 节目库里的节目或库外文件。
 * @param path 节目的 `.artrec` 路径，或 `.artshow` 路径。
 * @returns 解析并校验过的工程。
 */
export async function readShow(kind: ShowFileKind, path: string): Promise<ShowProject> {
  return parseOrThrow(kind === "library" ? await showProjectOpen(path) : await showExternalRead(path));
}

/**
 * 把另一个节目合并进当前工程（一步撤销）。合并结果先按工程文件的规则校验，不合格时不改动当前工程。
 *
 * @param source 要导入的工程。
 * @param options 导入选项。
 * @returns 导入了多少东西。
 */
export function importShow(source: ShowProject, options: MergeOptions): MergeReport {
  const current = useProjectStore.getState().project;
  let report: MergeReport | null = null;
  const merged = produce(current, (d) => {
    report = mergeProject(d, source, options);
  });
  if (!parseProjectText(serializeProject(merged)).ok || !report) throw "invalid_project";
  useProjectStore.getState().update((d) => {
    d.fixtureModels = merged.fixtureModels;
    d.fixtures = merged.fixtures;
    d.groups = merged.groups;
    d.presets = merged.presets;
    d.tracks = merged.tracks;
    d.cues = merged.cues;
    d.markers = merged.markers;
    d.sections = merged.sections;
    d.durationMs = merged.durationMs;
  });
  return report;
}
