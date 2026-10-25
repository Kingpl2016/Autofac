import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { TooltipProvider } from "@/components/ui/tooltip";
import { LiveAnnouncer } from "@/shared/components/LiveAnnouncer";
import { useAppearanceSync } from "@/shared/hooks/useAppearanceSync";
import { SignalCheckerView } from "./SignalCheckerView";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: true },
  },
});

/**
 * 信号检测器窗口的根组件：外观同步、查询客户端与提示层。
 *
 * 独立于主应用的 `AppRoot`：不挂载引擎 / 录制 / 回放的全局监听，也没有路由。
 * 窗口获得焦点时重读偏好，主窗口里切换主题或语言后回到这里即可同步。
 */
export function SignalCheckerRoot() {
  useAppearanceSync({ rehydrateOnFocus: true });

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={200}>
        <SignalCheckerView />
        {/* 状态播报区：开始 / 停止时读屏软件会礼貌地朗读 */}
        <LiveAnnouncer />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
