// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";

import i18n from "@/shared/i18n";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
const query = vi.hoisted(() => ({ data: { destinations: [] as unknown[] } }));

vi.mock("sonner", () => ({ toast }));
vi.mock("@/shared/tauri/invoke", () => ({ isTauri: () => true }));
vi.mock("@/features/settings", () => ({ useProtocolFlags: () => ({ sacnEnabled: false }) }));
vi.mock("../hooks/useForwarding", async (orig) => ({
  ...(await orig<typeof import("../hooks/useForwarding")>()),
  useForwardingQuery: () => query,
}));

import { forwardingPrefillState } from "../lib/prefill";
import { ForwardingView } from "./ForwardingView";

/** 把当前路由 state 暴露到 DOM，便于断言它被清掉。 */
function LocationProbe() {
  const { state } = useLocation();
  return <output data-testid="loc-state">{JSON.stringify(state)}</output>;
}

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe("ForwardingView 的跳转预填", () => {
  it("带预填进入时打开对话框，并清掉路由 state（刷新 / 回退不会再弹）", async () => {
    render(
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
      </MemoryRouter>,
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
      <MemoryRouter initialEntries={["/forwarding"]}>
        <ForwardingView />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
