import type { ComponentType } from "react";

import { createRegistry, type Disposer, type Registry, type RegistryItem } from "./registry";

/**
 * 扩展点及其属性类型的声明表，新增扩展点只需在这里加一行。
 * 值是宿主渲染贡献组件时传给它们的 props 类型；不需要传参的用 `object`。
 */
export interface SlotPropsMap {
  /** 顶栏左侧的状态区（网络接口、连接状态、运行时长等）。 */
  "header.status": object;
  /** 顶栏右侧的操作区（模式、录制、主题、语言、个性化等）。 */
  "header.actions": object;
  /** 全局覆盖层（确认对话框、退出守卫等），整个应用只挂载一次。 */
  "layout.overlays": object;
  /** 个性化面板的“扩展”标签页里的额外设置分区。 */
  "appearance.sections": object;
}

/** 扩展点名称。 */
export type SlotName = keyof SlotPropsMap;

/** 插件向某个扩展点贡献的内容。 */
export interface SlotContribution<N extends SlotName = SlotName> extends RegistryItem {
  /** 要渲染的组件。 */
  component: ComponentType<SlotPropsMap[N]>;
}

/** 扩展点注册表：每个扩展点一个独立的 {@link Registry}。 */
export interface SlotRegistry {
  /**
   * 向扩展点注册一项贡献。
   *
   * @returns 取消注册的函数。
   */
  register: <N extends SlotName>(name: N, contribution: SlotContribution<N>) => Disposer;
  /** 取得某个扩展点的注册表（用于订阅与读取）。 */
  of: (name: SlotName) => Registry<SlotContribution>;
}

/**
 * 创建扩展点注册表。
 *
 * @returns 空的注册表。
 */
export function createSlotRegistry(): SlotRegistry {
  const registries = new Map<SlotName, Registry<SlotContribution>>();
  const of = (name: SlotName): Registry<SlotContribution> => {
    let registry = registries.get(name);
    if (!registry) {
      registry = createRegistry<SlotContribution>();
      registries.set(name, registry);
    }
    return registry;
  };
  return {
    register: (name, contribution) => of(name).register(contribution as SlotContribution),
    of,
  };
}
