import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import { usePrefsStore } from "@/shared/stores/prefsStore";
import en from "./locales/en.json";
import zh from "./locales/zh.json";

/**
 * i18n 初始化：中英文语言包均随首屏内置（体积很小），
 * 初始语言取自持久化的用户偏好（首次启动为系统语言）。
 */
void i18n.use(initReactI18next).init({
  resources: {
    zh: { translation: zh },
    en: { translation: en },
  },
  lng: usePrefsStore.getState().language,
  fallbackLng: "zh",
  interpolation: { escapeValue: false },
  returnNull: false,
});

export default i18n;
