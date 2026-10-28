import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient } from "@tanstack/react-query";

import { createEventBus, type AppEventMap } from "@/shared/events/eventBus";
import {
  composeProviders,
  composeRuntimes,
  createPluginHost,
  preloadRoutes,
  setupPlugins,
} from "@/shared/plugin";
import { App } from "./App";
import { appPlugins } from "./plugins";
import { createAppRouter } from "./router";

/** 启动失败时在容器里显示的错误（不依赖 i18n / 样式体系，保证任何情况下都能看到）。 */
function renderFatal(container: HTMLElement, error: unknown): void {
  console.error("[bootstrap] 启动失败", error);
  const pre = document.createElement("pre");
  pre.setAttribute("role", "alert");
  pre.style.cssText = "padding:16px;white-space:pre-wrap;font:13px/1.5 monospace";
  pre.textContent = error instanceof Error ? `${error.message}\n${String(error.cause ?? "")}` : String(error);
  container.replaceChildren(pre);
}

/**
 * 启动主应用：
 *
 * 1. 创建查询客户端、事件总线与插件宿主，依次执行各插件的 `setup`。
 * 2. 用插件组合出的 Provider 与 Runtime 渲染根组件。
 *
 * @param container 挂载点。
 */
export async function bootstrap(container: HTMLElement): Promise<void> {
  try {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { refetchOnWindowFocus: true } },
    });
    const host = createPluginHost();
    const events = createEventBus<AppEventMap>();
    const runtime = await setupPlugins(appPlugins, { ...host, events, queryClient });

    const routes = host.routes.list();
    ReactDOM.createRoot(container).render(
      <React.StrictMode>
        <App
          queryClient={queryClient}
          host={host}
          router={createAppRouter(routes)}
          PluginProviders={composeProviders(runtime.active)}
          PluginRuntimes={composeRuntimes(runtime.active)}
        />
      </React.StrictMode>,
    );
    // 空闲时预加载按需页面，避免第一次切换页面时出现占位闪烁
    preloadRoutes(routes);
  } catch (error) {
    renderFatal(container, error);
  }
}
