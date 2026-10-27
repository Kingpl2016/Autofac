import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSyncer, throttle } from "../syncer";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** 可手动完成的异步发送：用来制造“上一次还没发完”的场景。 */
function deferred() {
  let done!: () => void;
  const promise = new Promise<void>((resolve) => {
    done = resolve;
  });
  return { promise, done };
}

describe("createSyncer", () => {
  it("防抖：连续提交只发最后一个", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const s = createSyncer<number>(send, vi.fn(), 100);
    s.push(1);
    await vi.advanceTimersByTimeAsync(60);
    s.push(2);
    await vi.advanceTimersByTimeAsync(60);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(2);
  });

  it("串行：上一次没发完时新值排队，完成后只发最新的", async () => {
    const gate = deferred();
    const send = vi.fn((v: number) => (v === 1 ? gate.promise : Promise.resolve()));
    const s = createSyncer<number>(send, vi.fn(), 10);
    s.push(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(send).toHaveBeenCalledTimes(1);
    s.push(2);
    await vi.advanceTimersByTimeAsync(10);
    s.push(3);
    await vi.advanceTimersByTimeAsync(10);
    expect(send).toHaveBeenCalledTimes(1); // 仍在等第一次
    gate.done();
    await vi.advanceTimersByTimeAsync(0);
    expect(send.mock.calls.map((c) => c[0])).toEqual([1, 3]);
  });

  it("flush 立即发送并在发完后 resolve；没有待发值时立即 resolve", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const s = createSyncer<string>(send, vi.fn(), 1000);
    await s.flush();
    expect(send).not.toHaveBeenCalled();
    s.push("a");
    await s.flush();
    expect(send).toHaveBeenCalledWith("a");
    // 防抖定时器已被取消，不会重复发送
    await vi.advanceTimersByTimeAsync(2000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("发送失败交给 onError，之后仍能继续同步", async () => {
    const onError = vi.fn();
    const send = vi.fn().mockRejectedValueOnce("boom").mockResolvedValue(undefined);
    const s = createSyncer<number>(send, onError, 5);
    s.push(1);
    await vi.advanceTimersByTimeAsync(5);
    expect(onError).toHaveBeenCalledWith("boom");
    s.push(2);
    await vi.advanceTimersByTimeAsync(5);
    expect(send).toHaveBeenLastCalledWith(2);
  });

  it("dispose 之后丢弃待发值，后续提交无效", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const s = createSyncer<number>(send, vi.fn(), 10);
    s.push(1);
    s.dispose();
    s.push(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("throttle", () => {
  it("首次立即执行，间隔内的调用合并成最后一次尾调用", () => {
    vi.setSystemTime(1000);
    const fn = vi.fn();
    const t = throttle(fn, 40);
    t(1);
    expect(fn).toHaveBeenCalledWith(1);
    vi.setSystemTime(1010);
    t(2);
    t(3);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(40);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith(3);
  });

  it("cancel 取消待执行的尾调用", () => {
    vi.setSystemTime(1000);
    const fn = vi.fn();
    const t = throttle(fn, 40);
    t(1);
    vi.setSystemTime(1005);
    t(2);
    t.cancel();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
