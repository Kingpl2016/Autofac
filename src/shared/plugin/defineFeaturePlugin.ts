import type { ComponentType } from "react";

import type { Disposer } from "./registry";
import type { NavItemDef } from "./navigation";
import type { RouteContribution } from "./routes";
import type { AppPlugin } from "./types";

/** 页面型 feature 的声明：路由与导航项。 */
export interface FeaturePluginSpec extends Omit<AppPlugin, "setup"> {
  /** 向主布局贡献的路由。 */
  routes?: readonly RouteContribution[];
  /** 向侧栏贡献的导航项。 */
  nav?: readonly NavItemDef[];
  /** 额外的初始化（可选），在路由与导航注册之后执行。 */
  setup?: AppPlugin["setup"];
}

/**
 * 把“按名称导出的组件”适配成路由需要的 `{ default }` 形状，省去每个页面重复的 `.then`。
 *
 * @example
 * `load: namedExport(() => import("./components/AboutView"), "AboutView")`
 *
 * @param loader 动态导入。
 * @param name 要作为页面的导出名。
 * @returns 可直接赋给 `RouteContribution.load` 的加载函数。
 */
export function namedExport<K extends string>(
  loader: () => Promise<Record<K, ComponentType>>,
  name: K,
): () => Promise<{ default: ComponentType }> {
  return () => loader().then((module) => ({ default: module[name] }));
}

/**
 * 声明一个页面型 feature 插件：只需列出路由与导航项，注册 / 清理由这里统一处理。
 * 需要更多能力（Runtime、Provider、顶栏按钮等）时，直接在声明里补上对应字段即可。
 *
 * @param spec feature 声明。
 * @returns 可放进插件清单的插件。
 */
export function defineFeaturePlugin(spec: FeaturePluginSpec): AppPlugin {
  const { routes = [], nav = [], setup, ...plugin } = spec;
  return {
    ...plugin,
    setup: async (ctx) => {
      const disposers: Disposer[] = [
        ...routes.map((route) => ctx.routes.register(route)),
        ...nav.map((item) => ctx.nav.items.register(item)),
      ];
      const extra = await setup?.(ctx);
      if (extra) disposers.push(extra);
      return () => {
        for (const dispose of disposers.reverse()) dispose();
      };
    },
  };
}
