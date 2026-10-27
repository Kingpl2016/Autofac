import { lazy, Suspense } from "react";

import { useAppearanceStore } from "../stores/useAppearanceStore";

// 背景层（含着色器 / 粒子 / 视频的按需加载）只在启用自定义背景时才下载
const BackgroundLayer = lazy(() =>
  import("../background/BackgroundLayer").then((module) => ({ default: module.BackgroundLayer })),
);

/** 自定义背景的宿主：没有启用自定义背景时不渲染、不加载任何背景代码。 */
export function BackgroundHost() {
  const enabled = useAppearanceStore((s) => s.background.type !== "none");
  if (!enabled) return null;
  return (
    <Suspense fallback={null}>
      <BackgroundLayer />
    </Suspense>
  );
}