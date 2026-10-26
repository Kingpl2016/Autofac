// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const stream = vi.hoisted(() => ({ subscribeDmxStream: vi.fn() }));

vi.mock("@/shared/tauri/stream", () => stream);

import {
  DMX_KIND_LIVE,
  DMX_KIND_PLAYBACK,
  encodeDmxFrame,
  type DmxFrame,
} from "@/shared/lib/dmxFrame";
import { useEngineDataStore } from "@/shared/stores/engineDataStore";
import { useDmxStream } from "../useDmxStream";

let onFrame: (buf: ArrayBuffer) => void = () => undefined;
const unsubscribe = vi.fn();

const channels = () =>
  Object.fromEntries(
    Object.entries(useEngineDataStore.getState().channels).map(([u, d]) => [u, [...d]]),
  );

/** 帧摘要：`[universe, 数据]`。 */
const summary = (f: DmxFrame) => f.entries.map((e) => [e.universe, [...e.data]]);

beforeEach(() => {
  vi.clearAllMocks();
  useEngineDataStore.setState({ channels: {} });
  stream.subscribeDmxStream.mockImplementation((cb: (buf: ArrayBuffer) => void) => {
    onFrame = cb;
    return Promise.resolve(unsubscribe);
  });
});

afterEach(() => useEngineDataStore.setState({ channels: {} }));

describe("useDmxStream", () => {
  it("实时帧整帧写入 store（每帧一次更新），没有处理器的类别与坏帧被忽略，卸载时退订", async () => {
    const { unmount } = renderHook(() => useDmxStream());
    expect(stream.subscribeDmxStream).toHaveBeenCalledTimes(1);

    let notified = 0;
    const off = useEngineDataStore.subscribe(() => {
      notified += 1;
    });
    onFrame(
      encodeDmxFrame({
        kind: DMX_KIND_LIVE,
        full: true,
        entries: [
          { universe: 1, data: [1, 2] },
          { universe: 2, data: [3] },
        ],
      }),
    );
    expect(channels()).toEqual({ 1: [1, 2], 2: [3] });
    expect(notified).toBe(1);

    onFrame(encodeDmxFrame({ kind: DMX_KIND_PLAYBACK, full: true, entries: [{ universe: 9, data: [9] }] }));
    onFrame(new ArrayBuffer(3));
    expect(channels()).toEqual({ 1: [1, 2], 2: [3] });
    expect(notified).toBe(1);

    onFrame(encodeDmxFrame({ kind: DMX_KIND_LIVE, full: false, entries: [{ universe: 1, data: [] }] }));
    expect(channels()).toEqual({ 2: [3] });
    off();

    await Promise.resolve();
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("其它类别交给对应的处理器，不写实时 store；换处理器不重新订阅", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ h }) => useDmxStream(h), {
      initialProps: { h: { [DMX_KIND_PLAYBACK]: first } },
    });

    onFrame(encodeDmxFrame({ kind: DMX_KIND_PLAYBACK, full: true, entries: [{ universe: 5, data: [7, 8] }] }));
    expect(first).toHaveBeenCalledTimes(1);
    expect(first.mock.calls[0][0]).toMatchObject({ kind: DMX_KIND_PLAYBACK, full: true });
    expect(summary(first.mock.calls[0][0])).toEqual([[5, [7, 8]]]);
    expect(channels()).toEqual({});

    // 调用方传入新的处理器对象：后续帧交给新处理器，后端订阅保持不变
    rerender({ h: { [DMX_KIND_PLAYBACK]: second } });
    onFrame(encodeDmxFrame({ kind: DMX_KIND_PLAYBACK, full: false, entries: [{ universe: 5, data: [] }] }));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(stream.subscribeDmxStream).toHaveBeenCalledTimes(1);

    // 实时帧仍由内置逻辑处理，不交给处理器
    onFrame(encodeDmxFrame({ kind: DMX_KIND_LIVE, full: true, entries: [{ universe: 1, data: [1] }] }));
    expect(second).toHaveBeenCalledTimes(1);
    expect(channels()).toEqual({ 1: [1] });
  });

  it("订阅完成前已卸载：完成后立即退订", async () => {
    let resolve!: (fn: () => void) => void;
    stream.subscribeDmxStream.mockReturnValue(new Promise((r) => (resolve = r)));
    const { unmount } = renderHook(() => useDmxStream());
    unmount();
    expect(unsubscribe).not.toHaveBeenCalled();
    resolve(unsubscribe);
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1));
  });
});
