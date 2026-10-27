/**
 * 节目库页面的地址约定（页面由节目库插件提供；录制页的面板只按地址跳转，不依赖其实现）。
 */

/** 节目库页面路径。 */
export const LIBRARY_PATH = "/library";
/** 节目编辑导出页面路径。 */
export const PROGRAM_EDIT_PATH = "/library/edit";

/**
 * 节目库地址，可选地选中一个节目。
 *
 * @param selected 要选中的节目路径。
 */
export function libraryHref(selected?: string): string {
  return selected ? `${LIBRARY_PATH}?sel=${encodeURIComponent(selected)}` : LIBRARY_PATH;
}

/**
 * 编辑导出某个节目的地址。
 *
 * @param path 节目路径。
 */
export function programEditHref(path: string): string {
  return `${PROGRAM_EDIT_PATH}?path=${encodeURIComponent(path)}`;
}

/**
 * 在节目编辑器中打开某个节目的地址。
 *
 * @param path 节目路径。
 */
export function editorHref(path: string): string {
  return `/editor?open=${encodeURIComponent(path)}`;
}
