import { create } from "zustand";
import { persist } from "zustand/middleware";

import { createTauriPersistStorage } from "@/shared/tauri/tauriStorage";

/** 中间区域的视图：色块预览、舞台监视器、灯具表（色块为默认）。 */
export const CENTER_VIEWS = ["swatches", "stage", "sheet"] as const;

/** 中间区域的视图。 */
export type CenterView = (typeof CENTER_VIEWS)[number];

/** 色块视图的分区方式：按 Universe、按灯具分组、按型号。 */
export const SWATCH_GROUP_BY = ["universe", "group", "model"] as const;

/** 色块视图的分区方式。 */
export type SwatchGroupBy = (typeof SWATCH_GROUP_BY)[number];

/** 色块大小：舒适（大块，显示名称与地址）或紧凑（小块，灯多时一屏看全）。 */
export const SWATCH_DENSITIES = ["comfortable", "compact"] as const;

/** 色块大小。 */
export type SwatchDensity = (typeof SWATCH_DENSITIES)[number];

/** 时间线左侧轨道名称列的宽度范围（像素）。 */
export const TRACK_HEADER_WIDTH = { min: 160, max: 480, default: 208 } as const;

/**
 * 把宽度夹在允许范围内并取整。
 *
 * @param px 宽度（像素）。
 * @returns 合法宽度；非数字时为默认宽度。
 */
export function clampHeaderWidth(px: number): number {
  if (!Number.isFinite(px)) return TRACK_HEADER_WIDTH.default;
  return Math.round(Math.min(TRACK_HEADER_WIDTH.max, Math.max(TRACK_HEADER_WIDTH.min, px)));
}

/** 落盘的数据。 */
export interface EditorPrefsData {
  centerView: CenterView;
  swatchGroupBy: SwatchGroupBy;
  swatchDensity: SwatchDensity;
  /** 时间线左侧轨道名称列的宽度（像素） */
  trackHeaderWidth: number;
}

interface EditorPrefsState extends EditorPrefsData {
  /**
   * 切换中间区域的视图（记住选择）。
   *
   * @param view 视图。
   */
  setCenterView: (view: CenterView) => void;
  /**
   * 切换色块的分区方式。
   *
   * @param by 分区方式。
   */
  setSwatchGroupBy: (by: SwatchGroupBy) => void;
  /**
   * 切换色块大小。
   *
   * @param density 大小。
   */
  setSwatchDensity: (density: SwatchDensity) => void;
  /**
   * 设置轨道名称列的宽度（会夹在允许范围内）。
   *
   * @param px 宽度（像素）。
   */
  setTrackHeaderWidth: (px: number) => void;
}

/** 默认值：预览先显示色块，按 Universe 分区。 */
export const DEFAULT_EDITOR_PREFS: EditorPrefsData = {
  centerView: "swatches",
  swatchGroupBy: "universe",
  swatchDensity: "comfortable",
  trackHeaderWidth: TRACK_HEADER_WIDTH.default,
};

/**
 * 校验从磁盘读回的偏好：每个字段单独兜底，非法值保持当前值。
 *
 * @param raw 磁盘上读到的未知数据。
 * @param current 当前值。
 * @returns 一定合法的偏好。
 */
export function sanitizeEditorPrefs(raw: unknown, current: EditorPrefsData): EditorPrefsData {
  const r = (raw ?? {}) as Partial<Record<keyof EditorPrefsData, unknown>>;
  const pick = <T extends string>(list: readonly T[], v: unknown, fallback: T): T =>
    list.includes(v as T) ? (v as T) : fallback;
  return {
    centerView: pick(CENTER_VIEWS, r.centerView, current.centerView),
    swatchGroupBy: pick(SWATCH_GROUP_BY, r.swatchGroupBy, current.swatchGroupBy),
    swatchDensity: pick(SWATCH_DENSITIES, r.swatchDensity, current.swatchDensity),
    trackHeaderWidth: typeof r.trackHeaderWidth === "number" ? clampHeaderWidth(r.trackHeaderWidth) : current.trackHeaderWidth,
  };
}

/**
 * 编辑器的视图偏好（中间视图、色块分区与大小、轨道名称列宽度），落盘到界面偏好文件（键 `editor-prefs`）。
 */
export const useEditorPrefsStore = create<EditorPrefsState>()(
  persist(
    (set) => ({
      ...DEFAULT_EDITOR_PREFS,
      setCenterView: (centerView) => set({ centerView }),
      setSwatchGroupBy: (swatchGroupBy) => set({ swatchGroupBy }),
      setSwatchDensity: (swatchDensity) => set({ swatchDensity }),
      setTrackHeaderWidth: (px) => set({ trackHeaderWidth: clampHeaderWidth(px) }),
    }),
    {
      name: "editor-prefs",
      version: 1,
      storage: createTauriPersistStorage<EditorPrefsData>(),
      partialize: ({ centerView, swatchGroupBy, swatchDensity, trackHeaderWidth }) => ({ centerView, swatchGroupBy, swatchDensity, trackHeaderWidth }),
      merge: (persisted, current) => (persisted == null ? current : { ...current, ...sanitizeEditorPrefs(persisted, current) }),
    },
  ),
);
