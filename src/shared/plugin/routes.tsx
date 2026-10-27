import { lazy, Suspense, type ComponentType, type ReactNode } from "react";
import type { RouteObject } from "react-router-dom";

import { createRegistry, type Registry, type RegistryItem } from "./registry";

/** 路由 `handle` 里可声明的布局选项。 */
export interface RouteLayoutHandle {
  /** 内容区不留内边距、自己管理滚动（编辑器等占满内容区的页面）。 */
  fullBleed?: boolean;
}

/** 插件贡献的一条主布局下的路由。`id` 同时是注册表键。 */
export interface RouteContribution extends RegistryItem {
  /** 路径（相对根）；与 `index` 二选一。 */
  path?: string;
  /** 作为根路径的索引路由。 */
  index?: boolean;
  /** 页面元素；与 `load` 二选一。 */
  element?: ReactNode;
  /** 按需加载的页面组件（默认导出）；会自动包上 Suspense。 */
  load?: () => Promise<{ default: ComponentType }>;
  /** 包在页面外的守卫组件（如“仅实时模式可用”）；位于 Suspense 之外，守卫拒绝时不会触发加载占位。 */
  guard?: ComponentType<{ children: ReactNode }>;
  /** 路由 `handle`。 */
  handle?: RouteLayoutHandle;
}

/** 路由注册表。 */
export type RouteRegistry = Registry<RouteContribution>;

/**
 * 创建路由注册表。
 *
 * @returns 空的注册表。
 */
export function createRouteRegistry(): RouteRegistry {
  return createRegistry<RouteContribution>();
}

/**
 * 把路由贡献转成 react-router 的路由对象。
 * `load` 在此处用 `lazy()` 包装一次，调用方应只在启动时转换一次。
 *
 * @param routes 路由贡献（已排序）。
 * @param fallback 按需加载期间显示的占位。
 * @returns 路由对象列表。
 */
export function toRouteObjects(routes: readonly RouteContribution[], fallback: ReactNode): RouteObject[] {
  return routes.map((route): RouteObject => {
    const Lazy = route.load ? lazy(route.load) : null;
    const page = Lazy ? (
      <Suspense fallback={fallback}>
        <Lazy />
      </Suspense>
    ) : (
      route.element
    );
    const Guard = route.guard;
    const element = Guard ? <Guard>{page}</Guard> : page;
    const common = { element, handle: route.handle };
    return route.index ? { index: true, ...common } : { path: route.path, ...common };
  });
}

/**
 * 在空闲时提前加载所有按需页面的代码，避免第一次切换页面时出现占位闪烁。
 * 失败只告警：到真正访问该页时会再次尝试加载。
 *
 * @param routes 路由贡献。
 */
export function preloadRoutes(routes: readonly RouteContribution[]): void {
  const run = () => {
    for (const route of routes) {
      route.load?.().catch((error: unknown) => console.warn(`[plugin] 预加载页面 "${route.id}" 失败`, error));
    }
  };
  if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 3000 });
  else setTimeout(run, 1000);
}
