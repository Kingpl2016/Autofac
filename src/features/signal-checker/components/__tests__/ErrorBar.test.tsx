// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/shared/tauri/tauriStorage", () => ({
  createTauriPersistStorage: () => ({
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  }),
}));

import i18n from "@/shared/i18n";
import { useSenderStore } from "../../stores/useSenderStore";
import { ErrorBar } from "../ErrorBar";

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  useSenderStore.setState({ error: null });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ErrorBar", () => {
  it("没有错误时什么也不渲染", () => {
    const { container } = render(<ErrorBar />);
    expect(container.firstChild).toBeNull();
  });

  it("显示错误（带 Universe），用 role=alert 让读屏立即播报", () => {
    render(<ErrorBar />);
    act(() => useSenderStore.getState().pushError({ universe: 3, message: "网络不可达" }));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("发送失败（Universe 3）：网络不可达");
  });

  it("没有 Universe 信息时不带括号", () => {
    render(<ErrorBar />);
    act(() => useSenderStore.getState().pushError({ universe: null, message: "套接字关闭" }));
    expect(screen.getByRole("alert").textContent).toBe("发送失败：套接字关闭");
  });

  it("可以手动关闭", () => {
    render(<ErrorBar />);
    act(() => useSenderStore.getState().pushError({ universe: 1, message: "x" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭错误提示" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("5 秒后自动消失；新错误会重新计时，旧定时器不会误关它", () => {
    vi.useFakeTimers();
    render(<ErrorBar />);
    act(() => useSenderStore.getState().pushError({ universe: 1, message: "a" }));
    act(() => void vi.advanceTimersByTime(4000));
    expect(screen.queryByRole("alert")).not.toBeNull();

    // 4 秒时又来一条同样文案的错误：从现在重新计 5 秒
    act(() => useSenderStore.getState().pushError({ universe: 1, message: "a" }));
    act(() => void vi.advanceTimersByTime(4000)); // 距第一条 8 秒，距第二条 4 秒
    expect(screen.queryByRole("alert")).not.toBeNull();
    act(() => void vi.advanceTimersByTime(1100));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
