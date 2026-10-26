// @vitest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";

import i18n from "@/shared/i18n";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
const query = vi.hoisted(() => ({
  data: { destinations: [] as unknown[] } as { destinations: unknown[] } | undefined,
  isError: false,
  refetch: vi.fn(),
}));

vi.mock("sonner", () => ({ toast }));
vi.mock("@/features/settings", () => ({ useProtocolFlags: () => ({ sacnEnabled: false }) }));
vi.mock("../../hooks/useForwarding", async (orig) => ({
  ...(await orig<typeof import("../../hooks/useForwarding")>()),
  useForwardingQuery: () => query,
}));

import { forwardingPrefillState } from "../../lib/prefill";
import { ForwardingView } from "../ForwardingView";

/** 把当前路由 state 暴露到 DOM，便于断言它被清掉。 */
function LocationProbe() {
  const { state } = useLocation();
  return <output data-testid="loc-state">{JSON.stringify(state)}</output>;
}

function Providers({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  vi.clearAllMocks();
  query.data = { destinations: [] };
  query.isError = false;
});
afterEach(() => cleanup());

describe("ForwardingView 的跳转预填", () => {
  it("带预填进入时打开对话框，并清掉路由 state（刷新 / 回退不会再弹）", async () => {
    render(
      <Providers>
        <MemoryRouter
          initialEntries={[
            {
              pathname: "/forwarding",
              state: forwardingPrefillState({ name: "舞台左", targetIp: "10.0.0.9" }),
            },
          ]}
        >
          <ForwardingView />
          <LocationProbe />
        </MemoryRouter>
      </Providers>,
    );

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByDisplayValue("10.0.0.9")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("loc-state").textContent).toBe("null"));
    // 清 state 后对话框仍保持打开，且只提示一次
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(toast.info).toHaveBeenCalledTimes(1);
  });

  it("普通进入时不打开对话框", () => {
    render(
      <Providers>
        <MemoryRouter initialEntries={["/forwarding"]}>
          <ForwardingView />
        </MemoryRouter>
      </Providers>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("ForwardingView 的加载状态", () => {
  const renderView = () =>
    render(
      <Providers>
        <MemoryRouter initialEntries={["/forwarding"]}>
          <ForwardingView />
        </MemoryRouter>
      </Providers>,
    );

  it("加载中显示加载提示", () => {
    query.data = undefined;
    renderView();
    expect(screen.getByText("加载中…")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("加载失败时显示错误与重试按钮，而不是一直“加载中”", () => {
    query.data = undefined;
    query.isError = true;
    renderView();
    expect(screen.getByRole("alert").textContent).toContain("转发配置加载失败");
    expect(screen.queryByText("加载中…")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(query.refetch).toHaveBeenCalledTimes(1);
  });
});