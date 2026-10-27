import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { TooltipProvider } from "@/components/ui/tooltip";
import { LiveAnnouncer } from "@/shared/components/LiveAnnouncer";
import { SignalCheckerView } from "./SignalCheckerView";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: true },
  },
});

/**
 * 信号检测器窗口的根组件：外观同步、查询客户端与提示层。
 *
 * 独立于主应用的 `App`：不挂载引擎 / 录制 / 回放的全局监听，也没有路由。
 * 外观与语言的读回、同步由窗口入口（`signal-checker/main.tsx`）负责。
 */
export function SignalCheckerRoot() {
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
