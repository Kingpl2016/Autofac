import { Outlet, useMatches } from "react-router-dom";

import { cn } from "@/lib/utils";
import { Slot, type RouteLayoutHandle } from "@/shared/plugin";
import { Sidebar } from "./Sidebar";
import { useDataDirNotice } from "./useDataDirNotice";
import { HeaderBar } from "./HeaderBar";
import { StatusLogBar } from "./StatusLogBar";

/**
 * 应用主布局：左侧导航 + 顶部状态条 + 内容区 + 底部日志条。
 * 导航项、顶栏内容与全局对话框都由插件贡献，这里只负责摆放。
 */
export function MainLayout() {
  // 软件目录没有写权限时提示数据实际保存的位置
  useDataDirNotice();
  const fullBleed = useMatches().some(
    (m) => (m.handle as RouteLayoutHandle | undefined)?.fullBleed === true,
  );
  return (
    <div data-layout="root" className="flex h-full w-full overflow-hidden bg-background">
      <Sidebar />
      <div data-layout="content" className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
        <HeaderBar />
        <main
          data-layout-main={fullBleed ? "bleed" : "padded"}
          className={cn(
            "min-h-0 min-w-0 flex-1 overflow-x-hidden",
            fullBleed ? "overflow-y-hidden" : "overflow-y-auto p-(--density-gutter)",
          )}
        >
          <Outlet />
        </main>
        <StatusLogBar />
      </div>
      {/* 全局覆盖层（模式确认、退出守卫等）：整个应用只挂载一次 */}
      <Slot name="layout.overlays" />
    </div>
  );
}
