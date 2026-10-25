import { Outlet } from "react-router-dom";

import { Sidebar } from "./Sidebar";
import { HeaderBar } from "./HeaderBar";
import { StatusLogBar } from "./StatusLogBar";

/**
 * 应用主布局：左侧导航 + 顶部状态条 + 内容区 + 底部日志条。
 */
export function MainLayout() {
  return (
    <div className="flex h-full w-full overflow-hidden bg-background">
      <Sidebar />
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
        <HeaderBar />
        <main className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto p-(--density-gutter)">
          <Outlet />
        </main>
        <StatusLogBar />
      </div>
    </div>
  );
}
