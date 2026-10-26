import { getCurrentWebview } from "@tauri-apps/api/webview";

/** 系统文件拖放的回调。 */
export interface FileDropHandlers {
  /** 拖拽文件进入 / 离开窗口时（用于高亮拖放区）。 */
  onHover: (hovering: boolean) => void;
  /** 在窗口内松开文件时，携带本地路径。 */
  onDrop: (paths: string[]) => void;
}

/**
 * 监听系统文件拖放。
 *
 * Tauri 会拦截原生拖放，网页里的 HTML5 `drop` 事件拿不到文件路径，
 * 所以改用 webview 的拖放事件，直接拿到本地路径交给后端流式读取。
 *
 * # Arguments
 *
 * * `handlers` - 悬停与放下的回调。
 *
 * # Returns
 *
 * 取消监听的函数。
 */
export async function listenFileDrop(handlers: FileDropHandlers): Promise<() => void> {
  return getCurrentWebview().onDragDropEvent((event) => {
    const p = event.payload;
    if (p.type === "enter" || p.type === "over") handlers.onHover(true);
    else if (p.type === "leave") handlers.onHover(false);
    else if (p.type === "drop") {
      handlers.onHover(false);
      if (p.paths.length > 0) handlers.onDrop(p.paths);
    }
  });
}
