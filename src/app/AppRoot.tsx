import { RouterProvider } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";

import { router } from "./router";
import { usePrefsStore } from "@/shared/stores/prefsStore";
import { LiveAnnouncer } from "@/shared/components/LiveAnnouncer";
import { useAppearanceSync } from "@/shared/hooks/useAppearanceSync";
import { useEngineListeners } from "@/shared/hooks/useEngineListeners";
import { useSystemLog } from "@/shared/hooks/useSystemLog";
import { useAppModeListeners } from "@/features/app-mode";
import {
  usePlayerListeners,
  useRecordingHotkeys,
  useRecordingListeners,
} from "@/features/recording";

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
  useAppearanceSync();
  useSystemLog();
  useEngineListeners();
  useRecordingListeners();
  usePlayerListeners();
  useAppModeListeners();
  useRecordingHotkeys();

  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster position="bottom-right" theme={theme} richColors />
      <LiveAnnouncer />
    </QueryClientProvider>
  );
}
