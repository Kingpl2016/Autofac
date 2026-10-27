// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args) as unknown,
  convertFileSrc: (p: string) => `asset://localhost/${encodeURIComponent(p)}`,
}));

import { useStageBackground } from "../useStageBackground";

/** 假图片：设置 src 后下一拍按文件名决定成功或失败。 */
class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  #src = "";
  get src() {
    return this.#src;
  }
  set src(v: string) {
    this.#src = v;
    queueMicrotask(() => (v.includes("broken") ? this.onerror?.() : this.onload?.()));
  }
}

beforeAll(() => vi.stubGlobal("Image", FakeImage));
afterAll(() => vi.unstubAllGlobals());

describe("useStageBackground", () => {
  it("没有路径时为 none；放行后加载图片；换路径时先回到加载中", async () => {
    invoke.mockResolvedValue(undefined);
    const { result, rerender } = renderHook(({ path }) => useStageBackground(path), {
      initialProps: { path: null as string | null },
    });
    expect(result.current.status).toBe("none");
    expect(invoke).not.toHaveBeenCalled();

    rerender({ path: "C:/a.png" });
    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(invoke).toHaveBeenCalledWith("stage_image_authorize", { path: "C:/a.png" });
    const image = result.current.status === "ready" ? (result.current.image as unknown as FakeImage) : null;
    expect(image?.src).toBe(`asset://localhost/${encodeURIComponent("C:/a.png")}`);

    rerender({ path: "C:/broken.png" });
    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.status).toBe("error"));
  });

  it("后端拒绝（文件不存在等）时报告错误", async () => {
    invoke.mockRejectedValueOnce("not_found");
    const { result } = renderHook(() => useStageBackground("C:/ghost.png"));
    await act(async () => {});
    await waitFor(() => expect(result.current).toEqual({ status: "error", error: "not_found" }));
  });
});
