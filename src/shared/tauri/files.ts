import { save, open } from "@tauri-apps/plugin-dialog";
import { writeTextFile, readTextFile } from "@tauri-apps/plugin-fs";

/** JSON 文件的对话框过滤器。 */
const JSON_FILTER = [{ name: "JSON", extensions: ["json"] }];

/**
 * 保存文本到用户选择的文件（原生“另存为”对话框 + 文件系统写入）。
 *
 * # Arguments
 *
 * * `defaultName` - 默认文件名。
 * * `content` - 要写入的文本内容。
 *
 * # Returns
 *
 * 实际保存返回 `true`；用户取消返回 `false`。
 */
export async function saveTextFile(
  defaultName: string,
  content: string,
): Promise<boolean> {
  const path = await save({ defaultPath: defaultName, filters: JSON_FILTER });
  if (!path) return false;
  await writeTextFile(path, content);
  return true;
}

/**
 * 让用户选择一个文本文件并读取其内容（原生“打开”对话框 + 文件系统读取）。
 *
 * # Returns
 *
 * 读取到的文本；用户取消时返回 `null`。
 */
export async function openTextFile(): Promise<string | null> {
  const path = await open({ filters: JSON_FILTER, multiple: false });
  if (typeof path !== "string") return null;
  return readTextFile(path);
}
