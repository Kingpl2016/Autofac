/** @file 动态背景的能力检测与降级判断：减少动画、省电模式、页面可见性、WebGL 可用性 */
import { useSyncExternalStore } from "react";

import { useAppearanceStore } from "../stores/useAppearanceStore";

/** 带有 Network Information 与 Device Memory 的 navigator（非标准 API，只做尽力而为的检测） */
interface NavigatorHints {
  /** 用户开启了流量节省 */
  connection?: { saveData?: boolean };
  /** 设备内存（GB，近似值） */
  deviceMemory?: number;
  /** 逻辑处理器数量 */
  hardwareConcurrency?: number;
}

/**
 * 判断是否为低配或省流量设备：开启了数据节省，或内存不超过 2GB，或只有 2 核及以下。
 *
 * @remarks
 * 这些 API 并非所有浏览器都有，缺失时视为“不是低配”，避免误伤。
 *
 * @returns 是否应当使用静态背景
 */
export function isLowPowerDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const hints = navigator as unknown as NavigatorHints;
  if (hints.connection?.saveData === true) return true;
  if (typeof hints.deviceMemory === "number" && hints.deviceMemory <= 2) return true;
  return typeof hints.hardwareConcurrency === "number" && hints.hardwareConcurrency <= 2;
}

let webglSupport: boolean | undefined;

/**
 * 判断浏览器是否支持 WebGL（结果会缓存，创建上下文有成本）。
 *
 * @returns 是否支持
 */
export function hasWebGL(): boolean {
  if (webglSupport !== undefined) return webglSupport;
  try {
    const canvas = document.createElement("canvas");
    webglSupport = Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    webglSupport = false;
  }
  return webglSupport;
}

/**
 * 重置 WebGL 检测的缓存（仅供测试使用）。
 */
export function resetWebGLCache(): void {
  webglSupport = undefined;
}

/**
 * 订阅页面可见性。
 *
 * @param listener - 变化回调
 * @returns 取消订阅函数
 */
function subscribeVisibility(listener: () => void): () => void {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}

/**
 * 页面当前是否可见。
 *
 * @returns 可见时为 true
 */
export function usePageVisible(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    () => !document.hidden,
    () => true,
  );
}

/**
 * 订阅“减少动画”的系统偏好。
 *
 * @param listener - 变化回调
 * @returns 取消订阅函数
 */
function subscribeReducedMotion(listener: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => {};
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}

/**
 * 判断当前是否应当播放背景动画。
 *
 * @remarks
 * 需要同时满足：外观设置不是“减少”（选“完整”可覆盖系统偏好）、不是低配设备、页面可见。
 * 不满足时调用方应当显示静态画面或暂停，而不是什么都不渲染。
 *
 * @returns `animate` 为是否播放动画，`visible` 为页面是否可见
 *
 * @example
 * ```tsx
 * const { animate } = useBackgroundMotion()
 * return <Shader speed={animate ? 0.5 : 0} />
 * ```
 */
export function useBackgroundMotion(): { animate: boolean; visible: boolean } {
  const motion = useAppearanceStore((state) => state.motion);
  const visible = usePageVisible();
  const systemReduces = useSyncExternalStore(
    subscribeReducedMotion,
    () =>
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );
  const reduced = motion === "reduce" || (motion === "system" && systemReduces);
  return { animate: !reduced && !isLowPowerDevice() && visible, visible };
}
