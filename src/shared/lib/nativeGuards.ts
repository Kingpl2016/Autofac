/**
 * 屏蔽 WebView 自带的交互，让应用像原生桌面软件：
 *
 * - 右键：不弹出浏览器菜单（返回 / 刷新 / 检查…）。文本输入框、可编辑区域与标了
 *   `data-native-contextmenu` 的元素保留（复制粘贴要用）；开发版可在设置里临时恢复。
 * - 浏览器快捷键：发布版屏蔽刷新、打印、查找、查看源码、开发者工具、光标浏览等，
 *   避免误按刷新丢掉未保存的工程。开发版保留，方便调试。
 *
 * 只做“阻止默认行为”，不阻止事件传播：应用自己的快捷键与右键菜单照常收到事件。
 */

/** 键盘事件里与判断有关的字段。 */
export interface GuardKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * 右键事件的目标是否需要保留浏览器菜单。
 *
 * @param target 事件目标。
 * @returns 文本输入框、可编辑区域或标了 `data-native-contextmenu` 的元素里为 `true`。
 */
export function keepsNativeMenu(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest("[data-native-contextmenu]")) return true;
  const el = target.closest("input, textarea, [contenteditable=''], [contenteditable='true']");
  if (!el) return false;
  if (el instanceof HTMLInputElement) {
    // 只有能输入文字的输入框才需要复制粘贴菜单
    return ["text", "search", "url", "email", "password", "number", "tel", ""].includes(el.type);
  }
  return true;
}

/**
 * 是否是应在发布版里屏蔽的浏览器快捷键。
 *
 * @param e 键盘事件。
 * @returns 刷新（F5 / Ctrl+R / Ctrl+Shift+R）、打印（Ctrl+P）、查找（Ctrl+F / F3 / Ctrl+G）、
 *   查看源码（Ctrl+U）、开发者工具（F12 / Ctrl+Shift+I / J / C）、光标浏览（F7）为 `true`。
 */
export function isBrowserShortcut(e: GuardKeyEvent): boolean {
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const mod = e.ctrlKey || e.metaKey;
  if (["F5", "F7", "F12", "F3", "BrowserRefresh"].includes(key)) return true;
  if (!mod || e.altKey) return false;
  if (e.shiftKey) return ["i", "j", "c", "r"].includes(key);
  return ["r", "p", "f", "g", "u"].includes(key);
}

/** 安装选项。 */
export interface GuardOptions {
  /** 是否开发版（开发版不屏蔽浏览器快捷键） */
  dev: boolean;
  /** 是否临时保留浏览器右键菜单（开发版的调试开关） */
  allowNativeMenu: () => boolean;
}

/**
 * 在窗口上安装屏蔽。
 *
 * @param target 窗口（测试可传入替身）。
 * @param options 选项。
 * @returns 卸载函数。
 */
export function installNativeGuards(target: Pick<Window, "addEventListener" | "removeEventListener">, options: GuardOptions): () => void {
  const onContextMenu = (e: Event) => {
    if (options.allowNativeMenu() || keepsNativeMenu(e.target)) return;
    e.preventDefault();
  };
  const onKeyDown = (e: Event) => {
    if (options.dev) return;
    if (isBrowserShortcut(e as KeyboardEvent)) e.preventDefault();
  };
  target.addEventListener("contextmenu", onContextMenu);
  target.addEventListener("keydown", onKeyDown);
  return () => {
    target.removeEventListener("contextmenu", onContextMenu);
    target.removeEventListener("keydown", onKeyDown);
  };
}
