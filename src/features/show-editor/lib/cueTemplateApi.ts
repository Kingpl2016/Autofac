import { invoke } from "@/shared/tauri/invoke";

/**
 * 用户 Cue 模板文件的后端命令（见 `src-tauri/src/cue_template_commands.rs`）。
 * 错误码：`bad_path`、`file_too_large`、`invalid_json`、`io`。
 */

/**
 * 读取数据目录里的用户模板文件。
 *
 * @returns 文件内容；文件不存在时为 `null`。
 */
export function readUserTemplates(): Promise<string | null> {
  return invoke<string | null>("cue_templates_read");
}

/**
 * 写入用户模板文件（整份替换）。
 *
 * @param text 文件内容（JSON）。
 */
export function writeUserTemplates(text: string): Promise<void> {
  return invoke<void>("cue_templates_write", { text });
}

/**
 * 读取用户选择的模板文件（导入）。
 *
 * @param path `.json` 文件路径。
 * @returns 文件内容。
 */
export function importTemplateFile(path: string): Promise<string> {
  return invoke<string>("cue_templates_import", { path });
}

/**
 * 把模板写到用户选择的位置（导出）。
 *
 * @param path `.json` 文件路径。
 * @param text 文件内容。
 */
export function exportTemplateFile(path: string, text: string): Promise<void> {
  return invoke<void>("cue_templates_export", { path, text });
}

/**
 * 在文件管理器里显示用户模板文件（不存在时先建一个空列表）。
 *
 * @returns 文件路径。
 */
export function revealUserTemplates(): Promise<string> {
  return invoke<string>("cue_templates_reveal");
}

/**
 * 后端错误 → 错误码（未知错误为 `io`）。
 *
 * @param e 错误。
 * @returns 错误码。
 */
export function templateErrorCode(e: unknown): "bad_path" | "file_too_large" | "invalid_json" | "io" {
  const s = typeof e === "string" ? e : e instanceof Error ? e.message : "";
  return s === "bad_path" || s === "file_too_large" || s === "invalid_json" ? s : "io";
}
