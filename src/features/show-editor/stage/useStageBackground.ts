import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { stageImageAuthorize } from "../lib/mediaApi";

/** 背景图的加载状态。 */
export type StageBackgroundState =
  | { status: "none" }
  | { status: "loading" }
  | { status: "ready"; image: HTMLImageElement }
  | { status: "error"; error: string };

/**
 * 加载舞台背景图：先经后端放行 asset 协议对这一个文件的访问，再用 `<img>` 解码。
 *
 * 路径变化时丢弃上一次未完成的结果。
 *
 * @param path 本地图片路径；`null` 为没有背景图。
 * @returns 加载状态。
 */
export function useStageBackground(path: string | null): StageBackgroundState {
  const [state, setState] = useState<{ path: string | null; value: StageBackgroundState }>({
    path: null,
    value: { status: "none" },
  });

  useEffect(() => {
    if (!path) return;
    let alive = true;
    const finish = (value: StageBackgroundState) => {
      if (alive) setState({ path, value });
    };
    stageImageAuthorize(path)
      .then(() => {
        const image = new Image();
        image.onload = () => finish({ status: "ready", image });
        image.onerror = () => finish({ status: "error", error: "decode" });
        image.src = convertFileSrc(path);
      })
      .catch((e: unknown) => finish({ status: "error", error: String(e) }));
    return () => {
      alive = false;
    };
  }, [path]);

  if (!path) return { status: "none" };
  // 状态还属于上一个路径时视为加载中（不需要在 effect 里同步重置）
  return state.path === path ? state.value : { status: "loading" };
}
