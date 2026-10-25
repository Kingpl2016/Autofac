import { create } from "zustand";
import { persist } from "zustand/middleware";

import { createTauriPersistStorage } from "@/shared/tauri/tauriStorage";

/** 主题模式 */
export type ThemeMode = "dark" | "light";

/** 界面语言 */
export type Language = "zh" | "en";

/** 强调色预设 */
export type AccentColor =
  | "blue"
  | "cyan"
  | "green"
  | "orange"
  | "violet"
  | "rose";

/** 全部强调色（显示顺序） */
export const ACCENT_COLORS: readonly AccentColor[] = [
  "blue",
  "cyan",
  "green",
  "orange",
  "violet",
  "rose",
];

/** 全部可选语言（显示顺序） */
export const LANGUAGES: readonly Language[] = ["zh", "en"];

/** 全部主题模式。 */
const THEMES: readonly ThemeMode[] = ["dark", "light"];

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
  /** 当前主题（深色为默认） */
  theme: ThemeMode;
  /** 界面语言（首次启动取系统语言） */
  language: Language;
  /** 强调色 */
  accent: AccentColor;
  /** 侧栏是否折叠为图标栏 */
  sidebarCollapsed: boolean;
  /** 录制开始 / 停止的全局快捷键 */
  recordHotkeys: RecordHotkeys;
  /** 切换主题 */
  toggleTheme: () => void;
  /** 设置主题 */
  setTheme: (theme: ThemeMode) => void;
  /** 设置界面语言 */
  setLanguage: (language: Language) => void;
  /** 设置强调色 */
  setAccent: (accent: AccentColor) => void;
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
  theme: ThemeMode;
  language: Language;
  accent: AccentColor;
  sidebarCollapsed: boolean;
  recordHotkeys: RecordHotkeys;
}

/** 校验一个加速键字符串：非空字符串才有效。 */
function validAccelerator(v: unknown, fallback: string): string {
  return typeof v === "string" && v.trim() !== "" ? v : fallback;
}

/**
 * 校验并规整从磁盘读回的偏好：任何字段不合法都回落到当前值，
 * 避免旧版本文件或被手改的文件让界面进入无效状态。
 *
 * # Arguments
 *
 * * `raw` - 磁盘上读到的未知数据。
 * * `current` - 当前内存中的偏好（作为非法字段的回退）。
 *
 * # Returns
 *
 * 一定合法的偏好数据。
 */
function sanitizePrefs(raw: unknown, current: PrefsData): PrefsData {
  const r = (raw ?? {}) as Partial<Record<keyof PrefsData, unknown>>;
  return {
    theme: THEMES.includes(r.theme as ThemeMode)
      ? (r.theme as ThemeMode)
      : current.theme,
    language: LANGUAGES.includes(r.language as Language)
      ? (r.language as Language)
      : current.language,
    accent: ACCENT_COLORS.includes(r.accent as AccentColor)
      ? (r.accent as AccentColor)
      : current.accent,
    sidebarCollapsed:
      typeof r.sidebarCollapsed === "boolean"
        ? r.sidebarCollapsed
        : current.sidebarCollapsed,
    recordHotkeys: {
      start: validAccelerator(
        (r.recordHotkeys as Partial<RecordHotkeys> | undefined)?.start,
        current.recordHotkeys.start,
      ),
      stop: validAccelerator(
        (r.recordHotkeys as Partial<RecordHotkeys> | undefined)?.stop,
        current.recordHotkeys.stop,
      ),
    },
  };
}

/**
 * 全局外观偏好，经 Tauri Store 插件持久化到 `ui-prefs.json`（键 `prefs`）。
 */
export const usePrefsStore = create<PrefsState>()(
  persist(
    (set) => ({
      theme: "dark",
      language: detectSystemLanguage(),
      accent: "blue",
      sidebarCollapsed: false,
      recordHotkeys: { ...DEFAULT_RECORD_HOTKEYS },
      toggleTheme: () =>
        set((s) => ({ theme: s.theme === "dark" ? "light" : "dark" })),
      setTheme: (theme) => set({ theme }),
      setLanguage: (language) => set({ language }),
      setAccent: (accent) => set({ accent }),
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
    {
      name: "prefs",
      version: 1,
      storage: createTauriPersistStorage<PrefsData>(),
      partialize: ({ theme, language, accent, sidebarCollapsed, recordHotkeys }) => ({
        theme,
        language,
        accent,
        sidebarCollapsed,
        recordHotkeys,
      }),
      // 没有已保存数据（首次运行 / 读取失败）时保持当前值，不被默认值覆盖
      merge: (persisted, current) =>
        persisted == null
          ? current
          : { ...current, ...sanitizePrefs(persisted, current) },
    },
  ),
);

/**
 * 把主题应用到 <html> 的 class 上。
 *
 * # Arguments
 *
 * * `theme` - 目标主题模式。
 */
export function applyThemeClass(theme: ThemeMode): void {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
}

/**
 * 把强调色应用到 <html> 的 `data-accent` 属性上。
 *
 * # Arguments
 *
 * * `accent` - 目标强调色。
 */
export function applyAccent(accent: AccentColor): void {
  document.documentElement.dataset.accent = accent;
}

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
