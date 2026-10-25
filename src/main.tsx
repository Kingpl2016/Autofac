import React from "react";
import ReactDOM from "react-dom/client";

import "@/shared/i18n";
import "@/styles/globals.css";
import { AppRoot } from "@/app/AppRoot";
import {
  usePrefsStore,
  applyThemeClass,
  applyAccent,
  applyLanguageAttr,
} from "@/shared/stores/prefsStore";

// 首次渲染前先应用外观偏好，避免主题 / 强调色闪烁
const prefs = usePrefsStore.getState();
applyThemeClass(prefs.theme);
applyAccent(prefs.accent);
applyLanguageAttr(prefs.language);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AppRoot />
  </React.StrictMode>,
);
