import { QueryClient } from "@tanstack/react-query";

import { createEventBus, type AppEventMap } from "@/shared/events/eventBus";
import { createPluginHost, type PluginHost } from "./host";
import { setupPlugins, type PluginRuntime } from "./runtime";
import type { AppPlugin } from "./types";

/**
 * 测试辅助：用一组插件装配出宿主（只执行 `setup`，不渲染 Provider / Runtime）。
 *
 * @param plugins 要装配的插件。
 * @returns 宿主与运行时句柄；测试结束时可调用 `runtime.dispose()`。
 */
export async function createTestHost(
  plugins: readonly AppPlugin[],
): Promise<{ host: PluginHost; runtime: PluginRuntime }> {
  const host = createPluginHost();
  const runtime = await setupPlugins(plugins, {
    ...host,
    events: createEventBus<AppEventMap>(),
    queryClient: new QueryClient(),
  });
  return { host, runtime };
}
