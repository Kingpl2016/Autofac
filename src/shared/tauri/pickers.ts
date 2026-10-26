import { open, save } from "@tauri-apps/plugin-dialog";

/**
 * 让用户选择一个或多个 `.artrec` 节目文件（原生“打开”对话框）。
 *
 * # Returns
 *
 * 所选文件的本地路径；用户取消时返回空数组。
 */
export async function pickArtrecFiles(): Promise<string[]> {
  const picked = await open({
    multiple: true,
    directory: false,
    filters: [{ name: "Art-Net Recording", extensions: ["artrec"] }],
  });
  if (picked === null) return [];
  return Array.isArray(picked) ? picked : [picked];
}

/**
 * 让用户选择一个固件 `.bin` 文件。
 *
 * # Returns
 *
 * 所选文件的本地路径；用户取消时返回 `null`。
 */
export async function pickFirmwareFile(): Promise<string | null> {
  const picked = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Firmware", extensions: ["bin"] }],
  });
  return typeof picked === "string" ? picked : null;
}

/**
 * 让用户选择保存位置（原生“另存为”对话框）。
 *
 * # Arguments
 *
 * * `defaultName` - 默认文件名。
 * * `extensions` - 过滤的扩展名（不含点）。
 *
 * # Returns
 *
 * 目标路径；用户取消时返回 `null`。
 */
export async function pickSavePath(
  defaultName: string,
  extensions: string[] = [],
): Promise<string | null> {
  return save({
    defaultPath: defaultName,
    filters: extensions.length > 0 ? [{ name: defaultName, extensions }] : undefined,
  });
}
