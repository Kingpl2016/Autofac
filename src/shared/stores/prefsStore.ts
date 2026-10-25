import { create } from "zustand";
import { persist } from "zustand/middleware";

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

interface PrefsState {
  /** 当前主题（深色为默认） */
  theme: ThemeMode;
  /** 界面语言（首次启动取系统语言） */
  language: Language;
  /** 强调色 */
  accent: AccentColor;
  /** 侧栏是否折叠为图标栏 */
  sidebarCollapsed: boolean;
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

/**
 * 全局外观偏好，持久化到 localStorage。
 */
export const usePrefsStore = create<PrefsState>()(
  persist(
    (set) => ({
      theme: "dark",
      language: detectSystemLanguage(),
      accent: "blue",
      sidebarCollapsed: false,
      toggleTheme: () =>
        set((s) => ({ theme: s.theme === "dark" ? "light" : "dark" })),
      setTheme: (theme) => set({ theme }),
      setLanguage: (language) => set({ language }),
      setAccent: (accent) => set({ accent }),
      toggleSidebar: () =>
        set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
    }),
    { name: "art-net-studio-prefs" },
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
