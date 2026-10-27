/** @file 自定义背景层：固定在页面最底层，按类型渲染渐变、图片等，上面叠遮罩；加载失败回退为无背景 */
import { lazy, Suspense, useState, type CSSProperties } from "react";

import {
  colorsLuminance,
  requiredDim,
  toLinearGradient,
  toMeshGradient,
  type BackgroundSettings,
} from "@/shared/appearance/background";

import { useAppearanceStore } from "../stores/useAppearanceStore";
import { useResolvedMode } from "../hooks/useResolvedMode";
import { useMediaUrl } from "./useMediaUrl";

// 着色器、粒子与视频背景各自按需加载：用渐变或图片背景的用户不会下载 WebGL / 粒子引擎的代码
const ShaderBackground = lazy(() => import("./ShaderBackground"));
const ParticlesBackground = lazy(() => import("./ParticlesBackground"));
const VideoBackground = lazy(() => import("./VideoBackground"));

/** 对象位置的 CSS 取值 */
const POSITIONS: Record<BackgroundSettings["position"], string> = {
  center: "center",
  top: "center top",
  bottom: "center bottom",
  left: "left center",
  right: "right center",
};

/** MediaLayer 的属性 */
interface MediaProps {
  /** 背景设置 */
  background: BackgroundSettings;
}

/**
 * 图片类背景（本地上传或外部地址）。
 *
 * @param props - 组件属性
 * @returns 图片节点；还在加载或加载失败时为 null
 */
function ImageMedia({ background }: MediaProps) {
  const [failed, setFailed] = useState<string | null>(null);
  const isUrl = background.type === "url";
  const media = useMediaUrl(isUrl ? null : "image", background.media?.version ?? 0);
  const source = isUrl ? background.url : media.status === "ready" ? media.url : null;
  if (!source || failed === source) return null;

  const style: CSSProperties = {
    objectFit: background.fit,
    objectPosition: POSITIONS[background.position],
    mixBlendMode: background.overlay.blend,
  };
  return (
    // 外部图片不带来源页面信息（隐私），也不参与跨域凭据；加载失败就回退，不影响页面
    <img
      src={source}
      alt=""
      decoding="async"
      referrerPolicy="no-referrer"
      draggable={false}
      onError={() => setFailed(source)}
      className="absolute inset-0 size-full"
      style={style}
    />
  );
}

/**
 * 估算当前背景的平均亮度，用于对比度保护。
 *
 * @param background - 背景设置
 * @returns 0~1 的亮度；未知（外部图片、视频）时为 null；粒子背景返回 1（等同于不需要保护的亮背景）
 */
function estimateLuma(background: BackgroundSettings): number | null {
  if (background.type === "gradient") {
    return colorsLuminance(background.gradient.stops.map((stop) => stop.color));
  }
  if (background.type === "mesh" || background.type === "shader") {
    return colorsLuminance(background.mesh);
  }
  // 粒子稀疏地飘在主题底色上，正文背景仍是主题底色，不需要额外遮罩
  if (background.type === "particles") return 1;
  if (background.type === "image") {
    return background.media?.kind === "image" ? background.media.luma : null;
  }
  return null;
}

/**
 * 自定义背景层。
 *
 * @remarks
 * - 固定在页面最底层（z-index -2），不拦截指针事件，对读屏器隐藏
 * - 遮罩的颜色取自当前主题的背景色，强度 = max(用户设置, 对比度保护所需的最小值)
 * - 对比度保护按平均亮度估算，亮度未知（外部图片、视频）时使用保守的固定遮罩；这是估算，不是逐像素的保证
 *
 * @returns 背景层节点；没有启用自定义背景时为 null
 *
 * @example
 * ```tsx
 * <BackgroundLayer />
 * ```
 */
export function BackgroundLayer() {
  const background = useAppearanceStore((state) => state.background);
  const mode = useResolvedMode();
  if (background.type === "none") return null;

  const { overlay } = background;
  const guard = overlay.guard ? requiredDim(estimateLuma(background), mode) : 0;
  const dim = Math.max(overlay.dim, guard);

  return (
    <div
      aria-hidden
      data-slot="appearance-background"
      data-background-type={background.type}
      className="pointer-events-none fixed inset-0 -z-20 overflow-hidden"
    >
      {background.type === "gradient" ? (
        <div
          className="absolute inset-0"
          style={{ backgroundImage: toLinearGradient(background.gradient) }}
        />
      ) : null}
      {background.type === "mesh" ? (
        <div
          className="absolute inset-0"
          style={{
            backgroundColor: "var(--background)",
            backgroundImage: toMeshGradient(background.mesh),
          }}
        />
      ) : null}
      {background.type === "shader" ? (
        <Suspense fallback={null}>
          <ShaderBackground background={background} />
        </Suspense>
      ) : null}
      {background.type === "particles" ? (
        <Suspense fallback={null}>
          <ParticlesBackground background={background} />
        </Suspense>
      ) : null}
      {background.type === "video" ? (
        <Suspense fallback={null}>
          <VideoBackground background={background} />
        </Suspense>
      ) : null}
      {background.type === "image" || background.type === "url" ? (
        <ImageMedia background={background} />
      ) : null}
      {dim > 0 || overlay.blur > 0 ? (
        <div
          data-slot="appearance-background-overlay"
          data-dim={dim}
          className="absolute inset-0"
          style={{
            backgroundColor: `color-mix(in oklab, var(--background) ${dim}%, transparent)`,
            backdropFilter: overlay.blur > 0 ? `blur(${overlay.blur}px)` : undefined,
            WebkitBackdropFilter: overlay.blur > 0 ? `blur(${overlay.blur}px)` : undefined,
          }}
        />
      ) : null}
    </div>
  );
}
