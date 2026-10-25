import { open } from "@tauri-apps/plugin-dialog";

/**
 * 弹出原生“选择文件夹”对话框。
 *
 * # Arguments
 *
 * * `defaultPath` - 对话框初始所在目录；为空则由系统决定。
 *
 * # Returns
 *
 * 用户选中的目录绝对路径；取消时返回 `null`。
 */
export async function pickDirectory(defaultPath?: string): Promise<string | null> {
  const picked = await open({
    directory: true,
    multiple: false,
    defaultPath: defaultPath?.trim() || undefined,
  });
  return typeof picked === "string" ? picked : null;
}
