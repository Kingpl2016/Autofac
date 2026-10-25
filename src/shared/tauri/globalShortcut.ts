import {
  register,
  unregister,
  isRegistered,
  type ShortcutEvent,
} from "@tauri-apps/plugin-global-shortcut";

/**
 * 注册一个全局快捷键，仅在按下（而非释放）时触发回调。
 *
 * 全局快捷键在应用失焦时同样生效。重复注册同一加速键前应先 {@link unregisterShortcut}。
 *
 * # Arguments
 *
 * * `accelerator` - 加速键字符串，如 `"CommandOrControl+Shift+R"`。
 * * `onPressed` - 按下时触发的回调。
 *
 * # Returns
 *
 * 注册完成的 Promise。
 */
export function registerShortcut(
  accelerator: string,
  onPressed: () => void,
): Promise<void> {
  return register(accelerator, (event: ShortcutEvent) => {
    if (event.state === "Pressed") onPressed();
  });
}

/**
 * 注销一个已注册的全局快捷键。
 *
 * # Arguments
 *
 * * `accelerator` - 要注销的加速键字符串。
 *
 * # Returns
 *
 * 注销完成的 Promise。
 */
export function unregisterShortcut(accelerator: string): Promise<void> {
  return unregister(accelerator);
}

/**
 * 查询某个加速键当前是否已注册。
 *
 * # Arguments
 *
 * * `accelerator` - 待查询的加速键字符串。
 *
 * # Returns
 *
 * 已注册返回 `true`，否则 `false`。
 */
export function isShortcutRegistered(accelerator: string): Promise<boolean> {
  return isRegistered(accelerator);
}
