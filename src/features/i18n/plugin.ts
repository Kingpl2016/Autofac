import type { AppPlugin } from "@/shared/plugin";
import { LanguageSwitcher } from "./components/LanguageSwitcher";
import { loadLanguage, startLanguageSync } from "./lib/runtime";

/**
 * 国际化插件：界面语言的读回、同步与顶栏切换入口。
 *
 * `setup` 先读回上次选择的语言并应用，再渲染界面，所以首屏就是正确的语言。
 * 语言偏好仍存放在界面偏好里（与侧栏折叠、快捷键同一个文件）。
 */
export const i18nPlugin: AppPlugin = {
  name: "i18n",
  setup: async ({ slots }) => {
    await loadLanguage();
    const sync = startLanguageSync();
    const dispose = slots.register("header.actions", { id: "language", order: 70, component: LanguageSwitcher });
    return () => {
      sync.unsubscribe();
      dispose();
    };
  },
};
