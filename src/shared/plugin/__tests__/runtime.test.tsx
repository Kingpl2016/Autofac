// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach } from "vitest";

import { createEventBus, type AppEventMap } from "@/shared/events/eventBus";
import { createPluginHost, PluginHostContext } from "../host";
import { composeProviders, composeRuntimes, resolvePluginOrder, setupPlugins } from "../runtime";
import { Slot } from "../Slot";
import type { AppPlugin, PluginContext } from "../types";

afterEach(cleanup);

const makeCtx = (): PluginContext => ({
  ...createPluginHost(),
  events: createEventBus<AppEventMap>(),
  queryClient: new QueryClient(),
});

const plugin = (name: string, extra: Partial<AppPlugin> = {}): AppPlugin => ({ name, ...extra });

describe("resolvePluginOrder", () => {
  it("无依赖时保持原有顺序，并过滤掉未启用的插件", () => {
    const order = resolvePluginOrder([
      plugin("a"),
      plugin("b", { enabled: () => false }),
      plugin("c"),
    ]).map((p) => p.name);
    expect(order).toEqual(["a", "c"]);
  });

  it("依赖先于被依赖者", () => {
    const order = resolvePluginOrder([
      plugin("notify", { dependsOn: ["auth"] }),
      plugin("x"),
      plugin("auth"),
    ]).map((p) => p.name);
    expect(order).toEqual(["auth", "notify", "x"]);
  });

  it("依赖缺失、已禁用、重名、成环时给出带插件名的错误", () => {
    expect(() => resolvePluginOrder([plugin("a", { dependsOn: ["ghost"] })])).toThrow(/"a".*"ghost"/);
    expect(() =>
      resolvePluginOrder([plugin("a", { dependsOn: ["b"] }), plugin("b", { enabled: () => false })]),
    ).toThrow(/"b"/);
    expect(() => resolvePluginOrder([plugin("a"), plugin("a")])).toThrow(/重复/);
    expect(() =>
      resolvePluginOrder([plugin("a", { dependsOn: ["b"] }), plugin("b", { dependsOn: ["a"] })]),
    ).toThrow(/成环/);
  });
});

describe("setupPlugins", () => {
  it("串行执行 setup 并发出 plugin:ready 事件", async () => {
    const calls: string[] = [];
    const ctx = makeCtx();
    const ready: string[] = [];
    ctx.events.on("plugin:ready").subscribe(({ name }) => ready.push(name));

    await setupPlugins(
      [
        plugin("slow", {
          setup: async () => {
            await new Promise((r) => setTimeout(r, 5));
            calls.push("slow");
          },
        }),
        plugin("fast", { setup: () => void calls.push("fast") }),
      ],
      ctx,
    );

    expect(calls).toEqual(["slow", "fast"]);
    expect(ready).toEqual(["slow", "fast"]);
  });

  it("某个 setup 失败时，已完成的插件按相反顺序清理，并抛出带名称的错误", async () => {
    const cleaned: string[] = [];
    const run = setupPlugins(
      [
        plugin("one", { setup: () => () => cleaned.push("one") }),
        plugin("two", { setup: () => () => cleaned.push("two") }),
        plugin("bad", {
          setup: () => {
            throw new Error("boom");
          },
        }),
      ],
      makeCtx(),
    );
    await expect(run).rejects.toThrow(/"bad"/);
    expect(cleaned).toEqual(["two", "one"]);
  });

  it("dispose 按相反顺序清理，且一个清理失败不影响其余", async () => {
    const cleaned: string[] = [];
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const runtime = await setupPlugins(
      [
        plugin("a", { setup: () => () => cleaned.push("a") }),
        plugin("b", {
          setup: () => () => {
            throw new Error("x");
          },
        }),
        plugin("c", { setup: () => () => cleaned.push("c") }),
      ],
      makeCtx(),
    );
    runtime.dispose();
    expect(cleaned).toEqual(["c", "a"]);
    error.mockRestore();
  });
});

describe("composeProviders / composeRuntimes", () => {
  it("Provider 按插件顺序由外到内嵌套", () => {
    const wrap = (label: string): AppPlugin["Provider"] =>
      function P({ children }) {
        return <div data-testid={label}>{children}</div>;
      };
    const Providers = composeProviders([
      plugin("outer", { Provider: wrap("outer") }),
      plugin("none"),
      plugin("inner", { Provider: wrap("inner") }),
    ]);
    render(
      <Providers>
        <span>child</span>
      </Providers>,
    );
    expect(screen.getByTestId("outer").contains(screen.getByTestId("inner"))).toBe(true);
    expect(screen.getByTestId("inner").contains(screen.getByText("child"))).toBe(true);
    expect(screen.getByTestId("inner").contains(screen.getByTestId("outer"))).toBe(false);
  });

  it("Runtime 全部被挂载", () => {
    const mounted: string[] = [];
    const rt = (name: string) => () => {
      mounted.push(name);
      return null;
    };
    const Runtimes = composeRuntimes([plugin("a", { Runtime: rt("a") }), plugin("b", { Runtime: rt("b") })]);
    render(<Runtimes />);
    expect(mounted).toEqual(["a", "b"]);
  });
});

describe("Slot", () => {
  it("按 order 渲染贡献；同 id 覆盖；取消注册后消失；故障贡献被隔离", () => {
    const host = createPluginHost();
    const label = (text: string) => () => <span>{text}</span>;
    host.slots.register("header.actions", { id: "b", order: 20, component: label("B") });
    host.slots.register("header.actions", { id: "a", order: 10, component: label("A") });
    const off = host.slots.register("header.actions", { id: "dup", component: label("old") });
    host.slots.register("header.actions", { id: "dup", component: label("new") });
    const Boom = () => {
      throw new Error("render failed");
    };
    host.slots.register("header.actions", { id: "boom", order: 5, component: Boom });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(
      <PluginHostContext value={host}>
        <div data-testid="bar">
          <Slot name="header.actions" />
        </div>
      </PluginHostContext>,
    );

    expect(screen.getByTestId("bar").textContent).toBe("ABnew");
    // 取消已被覆盖的旧注册，不应移除新的
    act(() => off());
    expect(screen.getByTestId("bar").textContent).toBe("ABnew");
    error.mockRestore();
  });

  it("没有提供宿主时渲染为空", () => {
    render(
      <div data-testid="empty">
        <Slot name="header.status" />
      </div>,
    );
    expect(screen.getByTestId("empty").childNodes).toHaveLength(0);
  });
});
