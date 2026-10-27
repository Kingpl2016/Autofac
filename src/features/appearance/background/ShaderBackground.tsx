/** @file 着色器背景：基于 @paper-design/shaders-react 的流动渐变，WebGL 不可用时退回静态网格渐变 */
import { MeshGradient, Swirl, Warp } from "@paper-design/shaders-react";

import { toMeshGradient, type BackgroundSettings } from "@/shared/appearance/background";

import { hasWebGL, useBackgroundMotion } from "./capabilities";

/** 各速度档位对应的着色器动画速度（0 为静止） */
const SPEEDS: Record<BackgroundSettings["speed"], number> = {
  slow: 0.25,
  normal: 0.6,
  fast: 1.2,
};

/** ShaderBackground 的属性 */
interface ShaderBackgroundProps {
  /** 背景设置 */
  background: BackgroundSettings;
}

/**
 * 着色器背景。
 *
 * @remarks
 * - 颜色取自背景设置里的调色板（和网格渐变共用），可以在“特效 → 自定义背景”里编辑
 * - 需要降级时（减少动画、低配、页面不可见）速度设为 0，画面静止而不是消失
 * - 浏览器不支持 WebGL 时退回 CSS 网格渐变，不报错
 *
 * @param props - 组件属性
 * @returns 着色器节点
 */
export default function ShaderBackground({ background }: ShaderBackgroundProps) {
  const { animate } = useBackgroundMotion();
  const colors = background.mesh;

  if (!hasWebGL()) {
    return (
      <div
        className="absolute inset-0"
        style={{ backgroundColor: "var(--background)", backgroundImage: toMeshGradient(colors) }}
      />
    );
  }

  const speed = animate ? SPEEDS[background.speed] : 0;
  const common = {
    className: "absolute inset-0 size-full",
    speed,
    minPixelRatio: 1,
    maxPixelCount: 1920 * 1080,
  };

  if (background.shader === "swirl") {
    return <Swirl {...common} colors={colors} colorBack={colors[0] ?? "#000000"} />;
  }
  if (background.shader === "warp") return <Warp {...common} colors={colors} />;
  return <MeshGradient {...common} colors={colors} />;
}
