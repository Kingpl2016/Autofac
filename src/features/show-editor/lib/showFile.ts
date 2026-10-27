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
      return t(`editor.file.errors.${raw}`);
    default:
      return raw.startsWith("trash_failed") || raw === "" ? t("common.unknownError") : raw;
  }
}
