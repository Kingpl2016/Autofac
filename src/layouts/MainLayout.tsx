import { Outlet, useMatches } from "react-router-dom";

import { CloseGuardDialog, ModeConfirmDialog } from "@/features/app-mode";
import { useSignalCheckerHotkey } from "@/features/signal-checker";
import { cn } from "@/lib/utils";
import { Sidebar } from "./Sidebar";
import { useDataDirNotice } from "./useDataDirNotice";
import { HeaderBar } from "./HeaderBar";
import { StatusLogBar } from "./StatusLogBar";

/** 路由 `handle` 里可声明的布局选项。 */
interface RouteLayoutHandle {
  /** 内容区不留内边距、自己管理滚动（编辑器等占满内容区的页面）。 */
  fullBleed?: boolean;
}

/**
 * 应用主布局：左侧导航 + 顶部状态条 + 内容区 + 底部日志条。
 */
export function MainLayout() {
  // 主窗口内 Ctrl+Shift+T 打开信号检测器
  useSignalCheckerHotkey();
  // 软件目录没有写权限时提示数据实际保存的位置
  useDataDirNotice();
  const fullBleed = useMatches().some(
    (m) => (m.handle as RouteLayoutHandle | undefined)?.fullBleed === true,
  );
  return (
    <div className="flex h-full w-full overflow-hidden bg-background">
      <Sidebar />
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
        <HeaderBar />
        <main
          className={cn(
            "min-h-0 min-w-0 flex-1 overflow-x-hidden",
            fullBleed ? "overflow-y-hidden" : "overflow-y-auto p-(--density-gutter)",
          )}
        >
          <Outlet />
        </main>
        <StatusLogBar />
      </div>
      {/* 模式切换确认对话框：整个应用只挂载一次，任何入口都通过 useModeActions 打开 */}
      <ModeConfirmDialog />
      {/* 退出守卫：录制或播放进行中关闭窗口时的确认 */}
      <CloseGuardDialog />
    </div>
  );
}
