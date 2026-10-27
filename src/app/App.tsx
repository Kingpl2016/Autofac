import type { ComponentProps, ComponentType, PropsWithChildren } from "react";
import { RouterProvider } from "react-router-dom";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";

import { Toaster } from "@/components/ui/sonner";
import { useResolvedMode } from "@/features/appearance";
import { LiveAnnouncer } from "@/shared/components/LiveAnnouncer";
import { PluginHostContext, type PluginHost } from "@/shared/plugin";


interface AppProps {
  /** 数据查询客户端。 */
  queryClient: QueryClient;
  /** 插件宿主（扩展点 / 路由 / 导航注册表）。 */
  host: PluginHost;
  /** 路由实例。 */
  router: ComponentProps<typeof RouterProvider>["router"];
  /** 由各插件 Provider 组合成的组件。 */
  PluginProviders: ComponentType<PropsWithChildren>;
  /** 由各插件 Runtime 组合成的无界面组件。 */
  PluginRuntimes: ComponentType;
}

/**
 * 应用根组件：只负责组装 Provider 与路由。
 * 引擎 / 录制 / 回放等全局监听都由各自插件的 `Runtime` 承载，这里不再逐个调用。
 */
export function App({ queryClient, host, router, PluginProviders, PluginRuntimes }: AppProps) {
  // 跟随系统时也要把实际生效的明暗交给 Toaster
  const theme = useResolvedMode();

  return (
    <QueryClientProvider client={queryClient}>
      <PluginHostContext value={host}>
        <PluginProviders>
          <PluginRuntimes />
          <RouterProvider router={router} />
          <Toaster theme={theme} />
          <LiveAnnouncer />
        </PluginProviders>
      </PluginHostContext>
    </QueryClientProvider>
  );
}
