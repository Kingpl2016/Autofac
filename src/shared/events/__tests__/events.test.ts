import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown) => void>(),
  unlisten: vi.fn(),
  resolveListen: null as null | (() => void),
  deferred: false,
}));

vi.mock("@/shared/tauri/events", () => ({
  onEvent: (event: string, handler: (payload: unknown) => void) => {
    tauri.handlers.set(event, handler);
    if (tauri.deferred) {
      return new Promise<() => void>((resolve) => {
        tauri.resolveListen = () => resolve(tauri.unlisten);
      });
    }
    return Promise.resolve(tauri.unlisten);
  },
}));

import { createEventBus } from "../eventBus";
import { fromTauriEvent } from "../fromTauriEvent";

beforeEach(() => {
  tauri.handlers.clear();
  tauri.unlisten.mockClear();
  tauri.deferred = false;
});

describe("createEventBus", () => {
  it("只把对应类型的载荷交给订阅者", () => {
    const bus = createEventBus<{ a: { n: number }; b: { s: string } }>();
    const got: number[] = [];
    bus.on("a").subscribe(({ n }) => got.push(n));

    bus.emit("a", { n: 1 });
    bus.emit("b", { s: "x" });
    bus.emit("a", { n: 2 });

    expect(got).toEqual([1, 2]);
  });

  it("all$ 收到全部事件，退订后不再收到", () => {
    const bus = createEventBus<{ a: number; b: number }>();
    const seen: string[] = [];
    const sub = bus.all$.subscribe((e) => seen.push(String(e.type)));
    bus.emit("a", 1);
    sub.unsubscribe();
    bus.emit("b", 2);
    expect(seen).toEqual(["a"]);
  });
});

describe("fromTauriEvent", () => {
  it("订阅时才监听，载荷逐个发出，退订时取消监听", async () => {
    const values: number[] = [];
    const sub = fromTauriEvent<number>("engine:stats").subscribe((v) => values.push(v));
    await Promise.resolve();

    tauri.handlers.get("engine:stats")?.(1);
    tauri.handlers.get("engine:stats")?.(2);
    expect(values).toEqual([1, 2]);

    sub.unsubscribe();
    expect(tauri.unlisten).toHaveBeenCalledTimes(1);
  });

  it("listen 完成之前就退订，也会在完成后立刻取消监听（不泄漏）", async () => {
    tauri.deferred = true;
    const sub = fromTauriEvent<number>("engine:stats").subscribe();
    sub.unsubscribe();
    expect(tauri.unlisten).not.toHaveBeenCalled();

    tauri.resolveListen?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(tauri.unlisten).toHaveBeenCalledTimes(1);
  });
});
