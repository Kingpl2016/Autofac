import type { ComponentType, PropsWithChildren, ReactNode } from "react";

import type { AppPlugin, PluginContext } from "./types";

/** 已启动的插件运行时。 */
export interface PluginRuntime {
  /** 已启用的插件，按依赖排序后的执行顺序。 */
  active: readonly AppPlugin[];
  /** 按启动的相反顺序调用各插件 `setup` 返回的清理函数；某个清理失败不影响其余。 */
  dispose: () => void;
}

/**
 * 筛选启用的插件，并按 `dependsOn` 做稳定的拓扑排序：
 * 没有依赖关系的插件保持列表里的先后顺序。
 *
 * @param plugins 全部插件。
 * @returns 排好序的已启用插件。
 * @throws 名称重复、依赖未启用（或不存在）、依赖成环时抛出，信息里带插件名。
 */
export function resolvePluginOrder(plugins: readonly AppPlugin[]): AppPlugin[] {
  const active = plugins.filter((plugin) => plugin.enabled?.() ?? true);
  const byName = new Map<string, AppPlugin>();
  for (const plugin of active) {
    if (byName.has(plugin.name)) throw new Error(`插件名称重复："${plugin.name}"`);
    byName.set(plugin.name, plugin);
  }

  const ordered: AppPlugin[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (plugin: AppPlugin, trail: readonly string[]) => {
    const mark = state.get(plugin.name);
    if (mark === "done") return;
    if (mark === "visiting") {
      throw new Error(`插件依赖成环：${[...trail, plugin.name].join(" -> ")}`);
    }
    state.set(plugin.name, "visiting");
    for (const dep of plugin.dependsOn ?? []) {
      const target = byName.get(dep);
      if (!target) throw new Error(`插件 "${plugin.name}" 依赖的 "${dep}" 未启用或不存在`);
      visit(target, [...trail, plugin.name]);
    }
    state.set(plugin.name, "done");
    ordered.push(plugin);
  };
  for (const plugin of active) visit(plugin, []);
  return ordered;
}

/**
 * 依次执行已启用插件的 `setup`（串行：后面的插件可能依赖前面的结果）。
 * 任何一个 `setup` 失败，已完成的插件会按相反顺序清理，然后抛出带插件名的错误。
 *
 * @param plugins 全部插件。
 * @param ctx 插件上下文。
 * @returns 运行时句柄。
 */
export async function setupPlugins(
  plugins: readonly AppPlugin[],
  ctx: PluginContext,
): Promise<PluginRuntime> {
  const active = resolvePluginOrder(plugins);
  const disposers: Array<() => void> = [];
  const dispose = () => {
    for (const fn of disposers.splice(0).reverse()) {
      try {
        fn();
      } catch (error) {
        console.error("[plugin] 清理失败", error);
      }
    }
  };

  for (const plugin of active) {
    try {
      // 插件之间存在依赖，必须串行
      const cleanup = await plugin.setup?.(ctx);
      if (cleanup) disposers.push(cleanup);
    } catch (error) {
      dispose();
      throw new Error(`插件 "${plugin.name}" 初始化失败`, { cause: error });
    }
    ctx.events.emit("plugin:ready", { name: plugin.name });
  }
  return { active, dispose };
}

/**
 * 把各插件的 Provider 组合成单个组件（Composite）。在启动阶段调用一次，而不是在渲染期间。
 *
 * @param plugins 已启用的插件。
 * @returns 按插件顺序由外到内嵌套各 Provider 的组件。
 */
export function composeProviders(plugins: readonly AppPlugin[]): ComponentType<PropsWithChildren> {
  const providers = plugins.flatMap((plugin) => (plugin.Provider ? [plugin.Provider] : []));
  return function PluginProviders({ children }: PropsWithChildren) {
    return providers.reduceRight<ReactNode>((tree, Provider) => <Provider>{tree}</Provider>, children);
  };
}

/**
 * 把各插件的 Runtime 合成一个无界面组件。
 *
 * @param plugins 已启用的插件。
 * @returns 依次渲染各 Runtime 的组件。
 */
export function composeRuntimes(plugins: readonly AppPlugin[]): ComponentType {
  const runtimes = plugins.flatMap((plugin) =>
    plugin.Runtime ? [{ name: plugin.name, Runtime: plugin.Runtime }] : [],
  );
  return function PluginRuntimes() {
    return (
      <>
        {runtimes.map(({ name, Runtime }) => (
          <Runtime key={name} />
        ))}
      </>
    );
  };
}
