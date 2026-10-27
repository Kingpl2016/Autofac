import { createContext, use } from "react";

import { createAppearanceRegistry, type AppearanceRegistry } from "@/shared/appearance/registry";
import { createNavRegistry, type NavRegistry } from "./navigation";
import { createRouteRegistry, type RouteRegistry } from "./routes";
import { createSlotRegistry, type SlotRegistry } from "./slotRegistry";

/** 宿主向组件树暴露的注册表集合。 */
export interface PluginHost {
  /** 扩展点。 */
  slots: SlotRegistry;
  /** 路由。 */
  routes: RouteRegistry;
  /** 导航。 */
  nav: NavRegistry;
  /** 外观预设：主题、主色、字体。 */
  appearance: AppearanceRegistry;
}

/**
 * 创建一个空的宿主。
 *
 * @returns 空注册表集合。
 */
export function createPluginHost(): PluginHost {
  return {
    slots: createSlotRegistry(),
    routes: createRouteRegistry(),
    nav: createNavRegistry(),
    appearance: createAppearanceRegistry(),
  };
}

/** 宿主上下文。未提供时是一个永远为空的宿主，`<Slot>` 渲染为空，便于单元测试。 */
export const PluginHostContext = createContext<PluginHost>(createPluginHost());

/**
 * 读取宿主注册表。
 *
 * @returns 当前宿主。
 */
export function usePluginHost(): PluginHost {
  return use(PluginHostContext);
}
