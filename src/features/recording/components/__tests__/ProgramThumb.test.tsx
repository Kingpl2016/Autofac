// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const api = vi.hoisted(() => ({ playerOverview: vi.fn() }));
vi.mock("../../lib/api", async (orig) => ({
  ...(await orig<typeof import("../../lib/api")>()),
  ...api,
}));

import type { Overview } from "../../lib/types";
import { ProgramThumb } from "../ProgramThumb";

/** 可手动触发“进入可视区”的 IntersectionObserver 替身。 */
class FakeObserver {
  static instances: FakeObserver[] = [];
  private readonly cb: IntersectionObserverCallback;
  constructor(cb: IntersectionObserverCallback) {
    this.cb = cb;
    FakeObserver.instances.push(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  fire(isIntersecting: boolean) {
    this.cb([{ isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

const overview = (): Overview => ({
  durationUs: 1_000_000,
  buckets: 2,
  universes: [1],
  change: [Uint8Array.from([255, 0])],
  level: [Uint8Array.from([200, 0])],
  frames: 2,
  skippedFrames: 0,
});

function renderThumb(valid = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ProgramThumb path="D:/rec/a.artrec" valid={valid} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  FakeObserver.instances = [];
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  api.playerOverview.mockReset();
  api.playerOverview.mockResolvedValue(overview());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ProgramThumb", () => {
  it("进入可视区之前不请求概览", () => {
    renderThumb();
    expect(api.playerOverview).not.toHaveBeenCalled();
  });

  it("进入可视区后才请求一次概览，并渲染画布", async () => {
    const { container } = renderThumb();
    act(() => FakeObserver.instances[0].fire(true));
    await waitFor(() => expect(api.playerOverview).toHaveBeenCalledWith("D:/rec/a.artrec"));
    await waitFor(() => expect(container.querySelector("canvas")).toBeTruthy());
    expect(api.playerOverview).toHaveBeenCalledTimes(1);
  });

  it("文件损坏时即使可见也不请求", () => {
    renderThumb(false);
    act(() => FakeObserver.instances[0].fire(true));
    expect(api.playerOverview).not.toHaveBeenCalled();
  });

  it("对读屏隐藏（纯装饰）", () => {
    const { getByTestId } = renderThumb();
    expect(getByTestId("program-thumb").getAttribute("aria-hidden")).toBe("true");
  });
});
