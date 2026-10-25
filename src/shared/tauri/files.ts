import { save, open } from "@tauri-apps/plugin-dialog";
import { writeTextFile, readTextFile } from "@tauri-apps/plugin-fs";

import { isTauri } from "./invoke";

/** JSON 文件的对话框过滤器。 */
const JSON_FILTER = [{ name: "JSON", extensions: ["json"] }];

/**
 * 保存文本到用户选择的文件。
 *
 * Tauri 环境使用原生“另存为”对话框 + 文件系统写入（可自选保存位置）；
 * 非 Tauri（dev 浏览器预览）回退为浏览器下载。
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
  if (isTauri()) {
    const path = await save({ defaultPath: defaultName, filters: JSON_FILTER });
    if (!path) return false;
    await writeTextFile(path, content);
    return true;
  }
  const blob = new Blob([content], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = defaultName;
  a.click();
  URL.revokeObjectURL(url);
  return true;
}

/**
 * 让用户选择一个文本文件并读取其内容。
 *
 * Tauri 环境使用原生“打开”对话框 + 文件系统读取；非 Tauri 回退为 `<input type=file>`。
 *
 * # Returns
 *
 * 读取到的文本；用户取消时返回 `null`。
 */
export async function openTextFile(): Promise<string | null> {
  if (isTauri()) {
    const path = await open({ filters: JSON_FILTER, multiple: false });
    if (typeof path !== "string") return null;
    return readTextFile(path);
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = () =>
        resolve(typeof reader.result === "string" ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsText(file);
    };
    input.click();
  });
}
