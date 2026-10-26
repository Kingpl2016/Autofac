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

/**
 * 启动应用。演示模式（`npm run dev:demo`）下先装好演示后端再渲染，
 * 保证各监听器与首次查询挂载时就能拿到演示数据；正常构建里这段分支会被整体移除。
 */
async function bootstrap(): Promise<void> {
  if (__DEMO_MODE__) {
    const { installDemo } = await import("@/demo");
    await installDemo();
  }

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <AppRoot />
    </React.StrictMode>,
  );
}

void bootstrap();
