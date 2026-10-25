import { useTranslation } from "react-i18next";

import { useAnnounceRunState } from "../hooks/useAnnounceRunState";
import { useBackendSync } from "../hooks/useBackendSync";
import { useSignalCheckerListeners } from "../hooks/useSignalCheckerListeners";
import { useWindowTitle } from "../hooks/useWindowTitle";
import { CheckerFooter } from "./CheckerFooter";
import { CheckerHeader } from "./CheckerHeader";
import { ConnectionCard } from "./ConnectionCard";
import { DiagnosticHints } from "./DiagnosticHints";
import { ErrorBar } from "./ErrorBar";
import { ModeSection } from "./ModeSection";

/**
 * 信号检测器窗口的主视图：顶栏 + 错误条 + 可滚动主体 + 底栏。
 *
 * 窗口是独立的 webview（独立 HTML 入口），不经过主应用的侧栏 / 顶栏布局。
 */
export function SignalCheckerView() {
  const { t } = useTranslation();
  useWindowTitle(t("signalChecker.windowTitle"));
  useSignalCheckerListeners();
  useBackendSync();
  useAnnounceRunState();

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <CheckerHeader />
      <ErrorBar />
      <main className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="mx-auto grid max-w-3xl gap-(--density-gap)">
          <ConnectionCard />
          <DiagnosticHints />
          <ModeSection />
        </div>
      </main>
      <CheckerFooter />
    </div>
  );
}
