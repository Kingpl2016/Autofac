import { createBrowserRouter } from "react-router-dom";

import { Skeleton } from "@/components/ui/skeleton";
import { MainLayout } from "@/layouts/MainLayout";
import { toRouteObjects, type RouteContribution } from "@/shared/plugin";

/** 按需页面加载期间的占位：骨架屏（个性化里开启“骨架屏流光”后会有光带扫过）。 */
const ROUTE_FALLBACK = (
  <div aria-hidden className="space-y-4">
    <Skeleton className="h-8 w-48" />
    <Skeleton className="h-4 w-80 max-w-full" />
    <Skeleton className="h-40 w-full" />
  </div>
);

/**
 * 用各插件贡献的路由创建应用路由：单布局 + 各功能页面。
 * 路由表不再在这里手写，新增页面只需在对应 feature 的插件里声明。
 *
 * @param routes 路由贡献（已排序）。
 * @returns 浏览器路由实例。
 */
export function createAppRouter(routes: readonly RouteContribution[]) {
  return createBrowserRouter([
    {
      path: "/",
      element: <MainLayout />,
      children: toRouteObjects(routes, ROUTE_FALLBACK),
    },
  ]);
}
