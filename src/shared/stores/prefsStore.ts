import { z } from "zod";
import { create } from "zustand";
import { persist } from "zustand/middleware";

import { persistPrefs } from "./persistPrefs";

/** 界面语言 */
export type Language = "zh" | "en";

/** 全部可选语言（显示顺序） */
export const LANGUAGES = ["zh", "en"] as const satisfies readonly Language[];

/** 录制开始 / 停止的全局快捷键。 */
export interface RecordHotkeys {
  /** 开始录制 */
  start: string;
  /** 停止录制 */
  stop: string;
}

/** 录制热键默认值。 */
export const DEFAULT_RECORD_HOTKEYS: RecordHotkeys = {
  start: "CommandOrControl+Shift+R",
  stop: "CommandOrControl+Shift+S",
};

interface PrefsState {
  /** 界面语言（首次启动取系统语言） */
  language: Language;
  /** 侧栏是否折叠为图标栏 */
  sidebarCollapsed: boolean;
  /** 录制开始 / 停止的全局快捷键 */
  recordHotkeys: RecordHotkeys;
  /** 录制时窗口四周是否显示录制色光晕（默认开） */
  recordingGlow: boolean;
  /** 开发版：保留浏览器默认右键菜单（便于“检查元素”），默认关 */
  nativeContextMenu: boolean;
  /** 设置是否保留浏览器默认右键菜单 */
  setNativeContextMenu: (on: boolean) => void;
  /** 设置录制光晕开关 */
  setRecordingGlow: (on: boolean) => void;
  /** 设置界面语言 */
  setLanguage: (language: Language) => void;
  /** 切换侧栏折叠状态 */
  toggleSidebar: () => void;
  /** 设置侧栏折叠状态 */
  setSidebarCollapsed: (collapsed: boolean) => void;
  /** 设置某个录制热键 */
  setRecordHotkey: (action: keyof RecordHotkeys, accelerator: string) => void;
  /** 重置录制热键为默认值 */
  resetRecordHotkeys: () => void;
}

/**
 * 根据系统语言推断默认界面语言。
 *
 * # Returns
 *
 * 系统语言以 `zh` 开头返回 `"zh"`，其余返回 `"en"`；无法获取时回退 `"zh"`。
 */
export function detectSystemLanguage(): Language {
  if (typeof navigator === "undefined" || !navigator.language) return "zh";
  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

/** 落盘的外观偏好字段。 */
interface PrefsData {
  language: Language;
  sidebarCollapsed: boolean;
  recordHotkeys: RecordHotkeys;
  recordingGlow: boolean;
  nativeContextMenu: boolean;
}

/** 加速键：非空字符串才有效。 */
const accelerator = (fallback: string) =>
  z
    .string()
    .refine((v) => v.trim() !== "")
    .catch(fallback);

/**
 * 落盘字段与兜底规则：任何字段不合法都回落默认值（语言回落到系统语言），
 * 避免旧版本文件或被手改的文件让界面进入无效状态。
 */
const schema = z.object({
  language: z.enum(LANGUAGES).catch(() => detectSystemLanguage()),
  sidebarCollapsed: z.boolean().catch(false),
  recordHotkeys: z
    .object({
      start: accelerator(DEFAULT_RECORD_HOTKEYS.start),
      stop: accelerator(DEFAULT_RECORD_HOTKEYS.stop),
    })
    .catch({ ...DEFAULT_RECORD_HOTKEYS }),
  recordingGlow: z.boolean().catch(true),
  nativeContextMenu: z.boolean().catch(false),
}) satisfies z.ZodType<PrefsData>;

/**
 * 全局外观偏好，经 Tauri Store 插件持久化到 `ui-prefs.json`（键 `prefs`）。
 */
export const usePrefsStore = create<PrefsState>()(
  persist(
    (set) => ({
      language: detectSystemLanguage(),
      sidebarCollapsed: false,
      recordHotkeys: { ...DEFAULT_RECORD_HOTKEYS },
      recordingGlow: true,
      nativeContextMenu: false,
      setNativeContextMenu: (nativeContextMenu) => set({ nativeContextMenu }),
      setRecordingGlow: (recordingGlow) => set({ recordingGlow }),
      setLanguage: (language) => set({ language }),
      toggleSidebar: () =>
        set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
      setRecordHotkey: (action, accelerator) =>
        set((s) => ({
          recordHotkeys: { ...s.recordHotkeys, [action]: accelerator },
        })),
      resetRecordHotkeys: () =>
        set({ recordHotkeys: { ...DEFAULT_RECORD_HOTKEYS } }),
    }),
    persistPrefs<PrefsState, PrefsData>({ name: "prefs", version: 1, schema }),
  ),
);

/**
 * 把界面语言应用到 <html> 的 `lang` 属性上（便于读屏与字体回退）。
 *
 * # Arguments
 *
 * * `language` - 目标语言。
 */
export function applyLanguageAttr(language: Language): void {
  document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
}
