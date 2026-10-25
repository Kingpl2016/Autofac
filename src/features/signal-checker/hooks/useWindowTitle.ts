import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * 把原生窗口标题和文档标题设为本地化文案（窗口由后端创建，初始标题是不分语言的英文）。
 *
 * 不在 Tauri 宿主里（例如单元测试）时静默忽略。
 *
 * # Arguments
 *
 * * `title` - 要显示的标题。
 */
export function useWindowTitle(title: string): void {
  useEffect(() => {
    document.title = title;
    try {
      void getCurrentWindow()
        .setTitle(title)
        .catch(() => undefined);
    } catch {
      // 非 Tauri 环境：没有窗口可设置
    }
  }, [title]);
}
