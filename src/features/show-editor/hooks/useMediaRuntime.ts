import { useEffect } from "react";

import { useMediaStore } from "../stores/useMediaStore";
import { useProjectStore } from "../stores/useProjectStore";
import { loadMedia } from "./mediaActions";

/**
 * 让工程里的每个素材都有可用的运行时状态（编辑器页面挂载期间生效）：
 *
 * - 新出现的素材，或路径变了（重新链接）的素材，自动放行 asset 协议并计算波形；
 * - 已从工程移除的素材，状态被清掉；
 * - 打开另一个工程时，旧工程素材的状态随之被替换。
 *
 * 文件缺失的素材标记为 `missing`，由素材库的“重新链接”处理。
 */
export function useMediaRuntime(): void {
  const media = useProjectStore((s) => s.project.media);

  useEffect(() => {
    useMediaStore.getState().retain(new Set(media.map((m) => m.id)));
    for (const m of media) {
      const current = useMediaStore.getState().items[m.id];
      if (!current || current.path !== m.path) void loadMedia(m);
    }
  }, [media]);

  useEffect(() => () => useMediaStore.getState().reset(), []);
}
