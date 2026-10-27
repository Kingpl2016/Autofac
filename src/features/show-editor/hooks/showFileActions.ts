import {
  parseProjectText,
  serializeProject,
  showAutosaveClear,
  showExternalRead,
  showExternalSave,
  showProjectOpen,
  showProjectSave,
} from "../lib/showFile";
import { createEmptyProject, type ShowProject } from "../lib/project";
import { useDocumentStore, type DocumentOrigin } from "../stores/useDocumentStore";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { usePlaybackStore } from "../stores/usePlaybackStore";
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
  useEditorUiStore.setState({
    selectedFixtureIds: [],
    selectedGroupId: null,
    selectedCueIds: [],
    selectedTrackId: null,
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
