import React from "react";
import ReactDOM from "react-dom/client";

import "@/shared/i18n";
import "@/styles/globals.css";
import { loadAppearance, rehydrateOnFocus, startAppearanceSync } from "@/features/appearance";
import { loadLanguage, rehydrateLanguageOnFocus, startLanguageSync } from "@/features/i18n";
import { SignalCheckerRoot } from "@/features/signal-checker";

/**
 * 启动信号检测器窗口。
 *
 * 它是独立窗口（独立 HTML 入口），不挂载主应用的插件运行时和全局监听，只复用外观能力：
 * 先读回外观与语言并应用，之后每次窗口获得焦点再重读，主窗口里切换主题或语言后回到这里即可同步。
 */
async function bootstrap(): Promise<void> {
  await Promise.all([loadAppearance(), loadLanguage()]);
  startAppearanceSync();
  startLanguageSync();
  rehydrateOnFocus();
  rehydrateLanguageOnFocus();

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <SignalCheckerRoot />
    </React.StrictMode>,
  );
}

void bootstrap();
