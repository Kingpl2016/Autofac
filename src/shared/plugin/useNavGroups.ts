import { usePluginHost } from "./host";
import { groupNavItems, type NavGroup } from "./navigation";
import { useRegistryItems } from "./registry";

/**
 * 订阅侧栏要渲染的导航分组：分组与导航项任一变化都会更新。
 *
 * @returns 已排序、已过滤掉空分组的导航分组。
 */
export function useNavGroups(): NavGroup[] {
  const { nav } = usePluginHost();
  const sections = useRegistryItems(nav.sections);
  const items = useRegistryItems(nav.items);
  return groupNavItems(sections, items);
}
