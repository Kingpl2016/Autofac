import { useEffect } from "react";

import i18n from "@/shared/i18n";
import {
  applyAccent,
  applyLanguageAttr,
  applyThemeClass,
  usePrefsStore,
} from "@/shared/stores/prefsStore";

interface AppearanceSyncOptions {
  /**
   * 窗口重新获得焦点时重新读取磁盘上的偏好。
   *
   * 第二个窗口（如信号检测器）自己的内存状态不会随主窗口里的主题 / 语言切换而变，
   * 获得焦点时重读一次即可追上，不需要额外的跨窗口事件。
   */
  rehydrateOnFocus?: boolean;
}

/**
 * 把外观偏好（主题 / 强调色 / 语言）同步到 `<html>` 与 i18n。
 *
 * 偏好从磁盘异步读回，所以这里用 effect 在读回后再应用；首屏的默认值由各入口在渲染前先应用。
 * 每个窗口的根组件调用一次。
 *
 * # Arguments
 *
 * * `options` - 同步选项，见 [`AppearanceSyncOptions`]。
 */
export function useAppearanceSync({ rehydrateOnFocus = false }: AppearanceSyncOptions = {}): void {
  const theme = usePrefsStore((s) => s.theme);
  const accent = usePrefsStore((s) => s.accent);
  const language = usePrefsStore((s) => s.language);

  useEffect(() => {
    applyThemeClass(theme);
  }, [theme]);

  useEffect(() => {
    applyAccent(accent);
  }, [accent]);

  useEffect(() => {
    applyLanguageAttr(language);
    if (i18n.language !== language) void i18n.changeLanguage(language);
  }, [language]);

  useEffect(() => {
    if (!rehydrateOnFocus) return;
    const onFocus = () => void usePrefsStore.persist.rehydrate();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [rehydrateOnFocus]);
}
