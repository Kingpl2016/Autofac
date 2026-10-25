import { useEffect } from "react";
import { RouterProvider } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";

import { router } from "./router";
import i18n from "@/shared/i18n";
import {
  usePrefsStore,
  applyThemeClass,
  applyAccent,
  applyLanguageAttr,
} from "@/shared/stores/prefsStore";
import { useEngineListeners } from "@/shared/hooks/useEngineListeners";
import { usePlayerListeners, useRecordingListeners } from "@/features/recording";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: true },
  },
});

/**
 * 应用根组件：挂载主题 / 强调色 / 语言、QueryClient、路由与全局 Toaster。
 */
export function AppRoot() {
  const theme = usePrefsStore((s) => s.theme);
  const accent = usePrefsStore((s) => s.accent);
  const language = usePrefsStore((s) => s.language);
  useEngineListeners();
  useRecordingListeners();
  usePlayerListeners();

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

  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster position="bottom-right" theme={theme} richColors />
    </QueryClientProvider>
  );
}
