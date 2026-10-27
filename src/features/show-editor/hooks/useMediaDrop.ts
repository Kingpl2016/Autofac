import { useEffect, useState } from "react";

import { listenFileDrop } from "@/shared/tauri/dragDrop";
import { isMediaPath } from "../lib/media";
import { importMediaPaths } from "./mediaActions";

/**
 * 接收从系统文件管理器拖进窗口的音视频文件并导入（编辑器页面挂载期间生效）。
 *
 * 只处理扩展名受支持的文件；其余文件被忽略（不弹提示，避免误拖时打扰）。
 * 没有 Tauri 运行时（测试、网页预览）时监听失败，什么也不做。
 *
 * @returns 是否有文件正悬停在窗口上（用于显示“松开导入”的提示）。
 */
export function useMediaDrop(): boolean {
  const [hovering, setHovering] = useState(false);

  useEffect(() => {
    let alive = true;
    let off: (() => void) | null = null;
    listenFileDrop({
      onHover: (on) => alive && setHovering(on),
      onDrop: (paths) => {
        const media = paths.filter(isMediaPath);
        if (media.length > 0) void importMediaPaths(media);
      },
    })
      .then((unlisten) => {
        if (alive) off = unlisten;
        else unlisten();
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      off?.();
    };
  }, []);

  return hovering;
}
