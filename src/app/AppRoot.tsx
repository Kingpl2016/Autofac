import { useMemo } from "react";
import { RouterProvider } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";

import { router } from "./router";
import { usePrefsStore } from "@/shared/stores/prefsStore";
import { LiveAnnouncer } from "@/shared/components/LiveAnnouncer";
import { DMX_KIND_PLAYBACK } from "@/shared/lib/dmxFrame";
import { useAppearanceSync } from "@/shared/hooks/useAppearanceSync";
import { useDmxStream } from "@/shared/hooks/useDmxStream";
import { useEngineListeners } from "@/shared/hooks/useEngineListeners";
import { useSystemLog } from "@/shared/hooks/useSystemLog";
import { useAppModeListeners } from "@/features/app-mode";
import {
  usePlayerListeners,
  usePlayerStore,
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
 *
 * 二进制通道流在这里订阅一次：实时帧由 `useDmxStream` 写入引擎数据 store，
 * 回放帧（kind = 2）交给回放 store（`shared` 不依赖 `features`，所以由应用层注入）。
 */
export function AppRoot() {
  const theme = usePrefsStore((s) => s.theme);
  const applyPlayerFrame = usePlayerStore((s) => s.applyChannelFrame);
  const streamHandlers = useMemo(
    () => ({ [DMX_KIND_PLAYBACK]: applyPlayerFrame }),
    [applyPlayerFrame],
  );
  useAppearanceSync();
  useSystemLog();
  useEngineListeners();
  useDmxStream(streamHandlers);
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
