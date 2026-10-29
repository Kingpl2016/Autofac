import type { TFunction } from "i18next";

import { invoke } from "@/shared/tauri/invoke";
import type { ShowProject } from "./project";
import { parseProject, type ParseResult } from "./schema";

/**
 * 工程文件的存取：节目库里的工程（`名称.artrec.show`）、库外导出的 `.artshow`、自动存档。
 * 命令的行为与错误码见 `src-tauri/src/show_commands.rs`。
 */

/** 保存到节目库的参数。 */
export interface SaveToLibraryArgs {
  /** 已有节目的 `.artrec` 路径（覆盖保存）；省略表示新建 */
  path?: string;
  name: string;
  notes: string;
  /** 新建时文件名的主干（后端会规整非法字符、重名追加序号） */
  fileStem?: string;
  /** 工程 JSON 文本 */
  json: string;
}

/**
 * 把工程序列化为文件内容。
 *
 * @param project 工程。
 * @returns JSON 文本（紧凑格式，工程文件通常较大）。
 */
export function serializeProject(project: ShowProject): string {
  return JSON.stringify(project);
}

/**
 * 保存工程进节目库。
 *
 * @param args 保存参数。
 * @returns 该节目的 `.artrec` 路径（烘焙之前文件并不存在，只有工程）。
 */
export function showProjectSave(args: SaveToLibraryArgs): Promise<string> {
  return invoke<string>("show_project_save", { args });
}

/**
 * 读取节目库里某个节目的工程文本。
 *
 * @param path 节目的 `.artrec` 路径。
 */
export function showProjectOpen(path: string): Promise<string> {
  return invoke<string>("show_project_open", { path });
}

/**
 * 保存工程到库外的 `.artshow` 文件。
 *
 * @param path 目标路径（扩展名必须是 `.artshow`）。
 * @param json 工程 JSON 文本。
 */
export function showExternalSave(path: string, json: string): Promise<void> {
  return invoke<void>("show_external_save", { path, json });
}

/**
 * 读取库外的 `.artshow` 文件。
 *
 * @param path 文件路径。
 */
export function showExternalRead(path: string): Promise<string> {
  return invoke<string>("show_external_read", { path });
}

/**
 * 写入自动存档（覆盖上一份）。
 *
 * @param json 工程 JSON 文本。
 */
export function showAutosaveWrite(json: string): Promise<void> {
  return invoke<void>("show_autosave_write", { json });
}

/** 读取自动存档；没有存档时为 `null`。 */
export function showAutosaveRead(): Promise<string | null> {
  return invoke<string | null>("show_autosave_read");
}

/** 删除自动存档。 */
export function showAutosaveClear(): Promise<void> {
  return invoke<void>("show_autosave_clear");
}

/** 工程所在位置的种类（与最近文件、工程来源一致）。 */
export type ShowFileKind = "library" | "external";

/** 工程文件信息（见后端 `show_file_info`）。 */
export interface ShowFileInfo {
  /** 工程文件是否存在 */
  exists: boolean;
  /** 工程文件路径（节目库为 `名称.artrec.show`） */
  projectPath: string;
  /** 工程文件字节数 */
  bytes: number;
  /** 工程文件修改时间（Unix 毫秒） */
  modifiedUnixMs: number | null;
  /** 节目库里回放文件的路径（库外工程为 `null`） */
  artrecPath: string | null;
  /** 回放文件字节数（还没生成时为 `null`） */
  artrecBytes: number | null;
  /** 回放文件修改时间（Unix 毫秒） */
  artrecModifiedUnixMs: number | null;
}

/**
 * 查询工程文件信息（文件不存在不算错误）。
 *
 * @param kind 节目库或库外文件。
 * @param path 节目的 `.artrec` 路径，或 `.artshow` 路径。
 * @returns 文件信息。
 */
export function showFileInfo(kind: ShowFileKind, path: string): Promise<ShowFileInfo> {
  return invoke<ShowFileInfo>("show_file_info", { kind, path });
}

/**
 * 在系统文件管理器里显示工程（节目库条目优先选中回放文件）。
 *
 * @param kind 节目库或库外文件。
 * @param path 节目的 `.artrec` 路径，或 `.artshow` 路径。
 */
export function showReveal(kind: ShowFileKind, path: string): Promise<void> {
  return invoke<void>("show_reveal", { kind, path });
}

/** 导出 ArtRec 的结果。 */
export interface ArtrecExportReport {
  /** 写入的帧数 */
  frames: number;
  /** 文件字节数 */
  bytes: number;
}

/**
 * 把工程烘焙成指定位置的 `.artrec` 回放文件（不必先保存）。
 *
 * @param path 目标路径（扩展名必须是 `.artrec`）。
 * @param json 工程 JSON 文本。
 * @returns 帧数与文件大小。
 */
export function showExportArtrec(path: string, json: string): Promise<ArtrecExportReport> {
  return invoke<ArtrecExportReport>("show_export_artrec", { path, json });
}

/**
 * 读取并校验工程文本。
 *
 * @param text 工程 JSON 文本。
 * @returns 解析结果（见 [`parseProject`]）。
 */
export function parseProjectText(text: string): ParseResult {
  return parseProject(text);
}

/**
 * 把后端错误码或解析失败转成本地化文案。
 *
 * @param t 翻译函数。
 * @param error 被 reject 的值（后端错误码字符串）。
 * @returns 可直接展示给用户的文案。
 */
export function showErrorText(t: TFunction, error: unknown): string {
  const raw = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  switch (raw) {
    case "outside_library":
    case "not_found":
    case "bad_path":
    case "project_too_large":
    case "invalid_project":
    case "project_too_new":
    case "in_use":
    case "nothing_to_bake":
    case "reveal_failed":
      return t(`editor.file.errors.${raw}`);
    default:
      return raw.startsWith("trash_failed") || raw === "" ? t("common.unknownError") : raw;
  }
}
