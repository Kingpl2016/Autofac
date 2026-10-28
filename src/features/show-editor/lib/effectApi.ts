import { invoke } from "@/shared/tauri/invoke";

/**
 * 用户特效文件的后端命令（见 `src-tauri/src/effect_commands.rs`）。
 * 错误码与 Cue 模板文件相同：`bad_path`、`file_too_large`、`invalid_json`、`io`（用 `templateErrorCode` 归一化）。
 */

/**
 * 读取数据目录里的用户特效文件。
 *
 * @returns 文件内容；文件不存在时为 `null`。
 */
export function readUserEffects(): Promise<string | null> {
  return invoke<string | null>("effects_read");
}

/**
 * 写入用户特效文件（整份替换）。
 *
 * @param text 文件内容（JSON）。
 */
export function writeUserEffects(text: string): Promise<void> {
  return invoke<void>("effects_write", { text });
}

/**
 * 读取用户选择的特效文件（导入）。
 *
 * @param path `.json` 文件路径。
 * @returns 文件内容。
 */
export function importEffectFile(path: string): Promise<string> {
  return invoke<string>("effects_import", { path });
}

/**
 * 把特效写到用户选择的位置（导出）。
 *
 * @param path `.json` 文件路径。
 * @param text 文件内容。
 */
export function exportEffectFile(path: string, text: string): Promise<void> {
  return invoke<void>("effects_export", { path, text });
}

/**
 * 在文件管理器里显示用户特效文件（不存在时先建一个空列表）。
 *
 * @returns 文件路径。
 */
export function revealUserEffects(): Promise<string> {
  return invoke<string>("effects_reveal");
}
