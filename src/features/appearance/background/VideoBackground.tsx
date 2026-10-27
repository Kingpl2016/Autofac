/** @file 视频背景：静音循环播放本地视频；减少动画、低配或页面不可见时暂停并停在画面上 */
import { useEffect, useRef, type CSSProperties } from "react";

import type { BackgroundSettings } from "@/shared/appearance/background";

import { useBackgroundMotion } from "./capabilities";
import { useMediaUrl } from "./useMediaUrl";

/** 对象位置的 CSS 取值 */
const POSITIONS: Record<BackgroundSettings["position"], string> = {
  center: "center",
  top: "center top",
  bottom: "center bottom",
  left: "left center",
  right: "right center",
};

/** VideoBackground 的属性 */
interface VideoBackgroundProps {
  /** 背景设置 */
  background: BackgroundSettings;
}

/**
 * 视频背景。
 *
 * @remarks
 * - 视频文件在 IndexedDB 里，通过对象 URL 播放，不经过网络
 * - 静音、循环、内联播放（`playsInline`），所以不会被浏览器的自动播放策略拦截
 * - 不应播放时（减少动画、低配、页面不可见）调用 `pause()`，视频停在当前帧，不会变成黑屏
 * - 文件缺失（比如设置是从别的浏览器导入的）时不渲染，由底下的主题底色兜底
 *
 * @param props - 组件属性
 * @returns 视频节点；没有文件时为 null
 */
export default function VideoBackground({ background }: VideoBackgroundProps) {
  const media = useMediaUrl("video", background.media?.version ?? 0);
  const video = useRef<HTMLVideoElement>(null);
  const { animate } = useBackgroundMotion();

  useEffect(() => {
    const element = video.current;
    if (!element) return;
    if (animate) {
      // 播放可能因浏览器策略被拒绝，失败时保持暂停即可
      element.play().catch(() => {});
    } else {
      element.pause();
    }
  }, [animate, media.status]);

  if (media.status !== "ready") return null;
  const style: CSSProperties = {
    objectFit: background.fit,
    objectPosition: POSITIONS[background.position],
    mixBlendMode: background.overlay.blend,
  };
  return (
    <video
      ref={video}
      src={media.url}
      muted
      loop
      playsInline
      preload="auto"
      aria-hidden
      tabIndex={-1}
      disablePictureInPicture
      className="absolute inset-0 size-full"
      style={style}
    />
  );
}
