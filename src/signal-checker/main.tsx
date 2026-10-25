import React from "react";
import ReactDOM from "react-dom/client";

import "@/shared/i18n";
import "@/styles/globals.css";
import { SignalCheckerRoot } from "@/features/signal-checker";
import {
  usePrefsStore,
  applyThemeClass,
  applyAccent,
  applyLanguageAttr,
} from "@/shared/stores/prefsStore";

// 信号检测器是独立窗口（独立 HTML 入口），不挂载主应用的全局监听；
// 首次渲染前先应用外观偏好，避免主题 / 强调色闪烁
const prefs = usePrefsStore.getState();
applyThemeClass(prefs.theme);
applyAccent(prefs.accent);
applyLanguageAttr(prefs.language);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <SignalCheckerRoot />
  </React.StrictMode>,
);
