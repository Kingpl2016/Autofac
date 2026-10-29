import type { ReactElement, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderOptions, type RenderResult } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * 测试用的查询客户端：关闭重试，失败的请求立即进入错误态，不让测试等待退避。
 *
 * @returns 新的查询客户端。
 */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

/** `renderWithProviders` 的选项。 */
export interface ProvidersOptions extends Omit<RenderOptions, "wrapper"> {
  /** 使用指定的查询客户端（例如需要 `vi.spyOn(client, "invalidateQueries")`）；省略时新建一个。 */
  client?: QueryClient;
  /** 包一层内存路由并以该地址为初始 URL（可带查询串）；省略时不包路由。 */
  route?: string;
}

/**
 * 带查询客户端（可选内存路由）的渲染。
 *
 * @param ui 被测组件。
 * @param options 渲染选项。
 * @returns 测试库的渲染结果，另附本次使用的查询客户端。
 */
export function renderWithProviders(
  ui: ReactElement,
  { client = createTestQueryClient(), route, ...options }: ProvidersOptions = {},
): RenderResult & { client: QueryClient } {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      {route === undefined ? children : <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>}
    </QueryClientProvider>
  );
  return { client, ...render(ui, { wrapper: Wrapper, ...options }) };
}
