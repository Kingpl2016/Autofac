import { describe, expect, it, vi } from "vitest";

import { createStreamHub, sameData, sameList } from "../streamHub";

describe("createStreamHub", () => {
  it("帧推给全部订阅者；订阅 / 取消 / requestFull 改变全量代次", () => {
    const hub = createStreamHub();
    expect(hub.hasSubscribers()).toBe(false);
    hub.send(new ArrayBuffer(1)); // 没有订阅者时是空操作

    const a = vi.fn();
    const b = vi.fn();
    const e0 = hub.epoch();
    const offA = hub.subscribe(a);
    const e1 = hub.epoch();
    expect(e1).not.toBe(e0);
    hub.subscribe(b);
    expect(hub.hasSubscribers()).toBe(true);

    const buf = new ArrayBuffer(6);
    hub.send(buf);
    expect(a).toHaveBeenCalledWith(buf);
    expect(b).toHaveBeenCalledWith(buf);

    const e2 = hub.epoch();
    offA();
    expect(hub.epoch()).not.toBe(e2);
    const e3 = hub.epoch();
    offA(); // 重复取消不再改变代次
    expect(hub.epoch()).toBe(e3);
    hub.send(buf);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);

    hub.requestFull();
    expect(hub.epoch()).not.toBe(e3);
  });

  it("同一个回调重复订阅也各自独立取消（对齐 React 严格模式）", () => {
    const hub = createStreamHub();
    const cb = vi.fn();
    const off1 = hub.subscribe(cb);
    hub.subscribe(cb);
    off1();
    expect(hub.hasSubscribers()).toBe(true);
    hub.send(new ArrayBuffer(1));
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe("变化检测辅助函数", () => {
  it("sameData / sameList 逐值比较", () => {
    expect(sameData(undefined, [])).toBe(false);
    expect(sameData([1, 2], [1, 2])).toBe(true);
    expect(sameData([1, 2], [1, 3])).toBe(false);
    expect(sameData([1], [1, 1])).toBe(false);
    expect(sameList([1, 2], [1, 2])).toBe(true);
    expect(sameList([2, 1], [1, 2])).toBe(false);
  });
});
