// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";

import { createTauriEventBus, stubResizeObserver } from "../mockTauriEvents";
import { createTestQueryClient, renderWithProviders } from "../renderWithProviders";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("createTauriEventBus", () => {
  it("派发给同一事件的全部处理器，取消订阅后不再收到", async () => {
    const bus = createTauriEventBus();
    const a = vi.fn();
    const b = vi.fn();
    const offA = await bus.onEvent("x", a);
    await bus.onEvent("x", b);
    expect(bus.count("x")).toBe(2);

    bus.emit("x", 1);
    expect(a).toHaveBeenCalledWith(1);
    expect(b).toHaveBeenCalledWith(1);

    offA();
    bus.emit("x", 2);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it("最后一个处理器取消后 has 为 false；reset 清空全部", async () => {
    const bus = createTauriEventBus();
    const off = await bus.onEvent("x", vi.fn());
    await bus.onEvent("y", vi.fn());
    off();
    expect(bus.has("x")).toBe(false);
    expect(bus.has("y")).toBe(true);
    bus.reset();
    expect(bus.has("y")).toBe(false);
  });

  it("failWith 让之后的订阅失败，reset 恢复", async () => {
    const bus = createTauriEventBus();
    bus.failWith(new Error("no tauri"));
    await expect(bus.onEvent("x", vi.fn())).rejects.toThrow("no tauri");
    expect(bus.has("x")).toBe(false);
    bus.reset();
    await expect(bus.onEvent("x", vi.fn())).resolves.toBeTypeOf("function");
  });

  it("没有处理器时派发不报错", () => {
    expect(() => createTauriEventBus().emit("none", 0)).not.toThrow();
  });
});

describe("stubResizeObserver", () => {
  it("装上可构造的空实现", () => {
    stubResizeObserver();
    const ro = new ResizeObserver(() => undefined);
    expect(() => ro.observe(document.body)).not.toThrow();
  });
});

describe("renderWithProviders", () => {
  function ClientProbe() {
    const client = useQueryClient();
    return <output>{client.getDefaultOptions().queries?.retry === false ? "no-retry" : "retry"}</output>;
  }
  function Where() {
    return <output>{useLocation().search}</output>;
  }

  it("提供关闭重试的查询客户端，并返回它", () => {
    const { client } = renderWithProviders(<ClientProbe />);
    expect(screen.getByText("no-retry")).toBeTruthy();
    expect(client.getDefaultOptions().mutations?.retry).toBe(false);
  });

  it("可以传入现成的客户端", () => {
    const client = createTestQueryClient();
    expect(renderWithProviders(<ClientProbe />, { client }).client).toBe(client);
  });

  it("传 route 时包一层内存路由，初始地址带查询串", () => {
    renderWithProviders(<Where />, { route: "/network?tab=files" });
    expect(screen.getByText("?tab=files")).toBeTruthy();
  });
});
