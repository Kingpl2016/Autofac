import type { ComponentType } from "react";

import { createRegistry, type Registry, type RegistryItem } from "./registry";

/** 导航图标：任何接受 `className` 的组件（lucide 图标满足）。 */
export type NavIcon = ComponentType<{ className?: string }>;

/** 导航分组。 */
export interface NavSectionDef extends RegistryItem {
  /** 分组标题的 i18n key。 */
  labelKey: string;
}

/** 导航项。`id` 即分组内唯一标识，通常与路由 id 相同。 */
export interface NavItemDef extends RegistryItem {
  /** 路由路径。 */
  to: string;
  /** 标签的 i18n key。 */
  labelKey: string;
  /** 图标。 */
  icon: NavIcon;
  /** 所属分组的 id（须已注册）。 */
  section: string;
  /** 依赖实时信号：播放器模式下接收已停止（仍可进入以查看原因）。 */
  liveOnly?: boolean;
  /** 路径精确匹配（根路径用）。 */
  end?: boolean;
}

/** 导航注册表：分组与导航项各一个注册表。 */
export interface NavRegistry {
  /** 导航分组。 */
  sections: Registry<NavSectionDef>;
  /** 导航项。 */
  items: Registry<NavItemDef>;
}

/**
 * 创建导航注册表。
 *
 * @returns 空的注册表。
 */
export function createNavRegistry(): NavRegistry {
  return { sections: createRegistry<NavSectionDef>(), items: createRegistry<NavItemDef>() };
}

/** 一个分组及其导航项（已排序）。 */
export interface NavGroup {
  /** 分组。 */
  section: NavSectionDef;
  /** 该分组下的导航项。 */
  items: readonly NavItemDef[];
}

/**
 * 把分组与导航项归并成侧栏要渲染的结构：没有导航项的分组被省略；
 * 引用了未注册分组的导航项也被省略（并给出警告），不会让侧栏出现无标题的孤儿项。
 *
 * @param sections 已排序的分组。
 * @param items 已排序的导航项。
 * @returns 分组列表。
 */
export function groupNavItems(
  sections: readonly NavSectionDef[],
  items: readonly NavItemDef[],
): NavGroup[] {
  const known = new Set(sections.map((s) => s.id));
  for (const item of items) {
    if (!known.has(item.section)) {
      console.warn(`[plugin] 导航项 "${item.id}" 引用了未注册的分组 "${item.section}"，已忽略`);
    }
  }
  return sections
    .map((section) => ({ section, items: items.filter((i) => i.section === section.id) }))
    .filter((group) => group.items.length > 0);
}
