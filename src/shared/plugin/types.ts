import type { QueryClient } from "@tanstack/react-query";
import type { ComponentType, PropsWithChildren } from "react";

import type { AppearanceRegistry } from "@/shared/appearance/registry";
import type { AppEventMap, EventBus } from "@/shared/events/eventBus";
import type { Disposer } from "./registry";
import type { NavRegistry } from "./navigation";
import type { RouteRegistry } from "./routes";
import type { SlotRegistry } from "./slotRegistry";

/** 插件 `setup` 阶段可使用的上下文（Facade：插件只通过它接触应用）。 */
export interface PluginContext {
  /** 扩展点：向宿主的顶栏、覆盖层等位置贡献组件。 */
  slots: SlotRegistry;
  /** 路由：向主布局贡献页面。 */
  routes: RouteRegistry;
  /** 导航：向侧栏贡献分组与导航项。 */
  nav: NavRegistry;
  /** 外观预设：向个性化面板贡献主题、主色与字体。 */
  appearance: AppearanceRegistry;
  /** 应用级事件总线。 */
  events: EventBus<AppEventMap>;
  /** TanStack Query 客户端。 */
  queryClient: QueryClient;
}

/**
 * 应用插件契约。
 *
 * 一个插件是应用里一块可独立启用 / 关闭 / 移除的能力。
 * 它通过 {@link PluginContext} 把自己的页面、导航、顶栏按钮、监听器等“挂”到宿主上，
 * 宿主本身不依赖任何具体插件。
 */
export interface AppPlugin {
  /** 唯一名称，用于依赖声明、日志与错误信息。 */
  name: string;
  /** 依赖的插件名；运行时据此排序，并在依赖缺失时给出明确错误。 */
  dependsOn?: readonly string[];
  /** 是否启用；缺省启用。 */
  enabled?: () => boolean;
  /**
   * 渲染前的初始化，可异步（读取持久化设置、注册贡献等）。
   * 可返回清理函数，卸载应用或某个后续插件 `setup` 失败时按相反顺序调用。
   */
  setup?: (ctx: PluginContext) => void | Disposer | Promise<void | Disposer>;
  /** 可选的 React Provider，按插件顺序由外到内包裹应用。 */
  Provider?: ComponentType<PropsWithChildren>;
  /**
   * 可选的无界面组件，挂在 Provider 之内，用来承载 `useXxxListeners` 这类需要在组件树里运行的钩子。
   * 它不渲染任何内容。
   */
  Runtime?: ComponentType;
}
