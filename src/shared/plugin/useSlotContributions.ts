import { usePluginHost } from "./host";
import { useRegistryItems } from "./registry";
import type { SlotContribution, SlotName } from "./slotRegistry";

/**
 * 订阅某个扩展点当前的贡献列表。
 * 宿主需要根据“是否有贡献”决定外围结构时使用；单纯渲染贡献请用 `<Slot>`。
 *
 * @param name 扩展点名称。
 * @returns 已排序的贡献；没有变化时返回同一数组引用。
 */
export function useSlotContributions(name: SlotName): readonly SlotContribution[] {
  const { slots } = usePluginHost();
  return useRegistryItems(slots.of(name));
}
