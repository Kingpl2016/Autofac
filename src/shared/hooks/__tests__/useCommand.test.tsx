// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { createTestQueryClient } from "@/test/renderWithProviders";
import { useCommand, type CommandOptions } from "../useCommand";

let client: ReturnType<typeof createTestQueryClient>;
beforeEach(() => {
  vi.clearAllMocks();
  client = createTestQueryClient();
  vi.spyOn(client, "invalidateQueries");
});

function setup<V>(options: CommandOptions<V>) {
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(() => useCommand(options), { wrapper });
}

describe("useCommand", () => {
  it("成功：提示成功文案、调用 onSuccess、刷新查询，返回 true", async () => {
    const onSuccess = vi.fn();
    const { result } = setup<number>({
      run: async () => undefined,
      success: (n) => `已切换到 ${n}`,
      onSuccess,
      invalidate: (n) => [["status", n]],
    });
    let ok = false;
    await act(async () => {
      ok = await result.current.run(3);
    });
    expect(ok).toBe(true);
    expect(toast.success).toHaveBeenCalledWith("已切换到 3");
    expect(onSuccess).toHaveBeenCalledWith(3);
    expect(client.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["status", 3] });
  });

  it("失败：用 describe 提示，不抛出，默认仍刷新查询（以服务端为准）", async () => {
    const { result } = setup<void>({
      run: () => Promise.reject("busy"),
      describe: (e) => `失败：${String(e)}`,
      invalidate: [["status"]],
    });
    let ok = true;
    await act(async () => {
      ok = await result.current.run();
    });
    expect(ok).toBe(false);
    expect(toast.error).toHaveBeenCalledWith("失败：busy");
    expect(toast.success).not.toHaveBeenCalled();
    expect(client.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["status"] });
  });

  it("invalidateOn=success 时失败不刷新", async () => {
    const { result } = setup<void>({
      run: () => Promise.reject(new Error("x")),
      invalidate: [["ota"]],
      invalidateOn: "success",
    });
    await act(async () => void (await result.current.run()));
    expect(toast.error).toHaveBeenCalledWith("x");
    expect(client.invalidateQueries).not.toHaveBeenCalled();
  });

  it("执行期间 pending 为 true，variables 是本次参数", async () => {
    let finish: () => void = () => undefined;
    const { result } = setup<number>({ run: () => new Promise<void>((r) => (finish = r)) });
    expect(result.current.pending).toBe(false);
    let done: Promise<boolean> = Promise.resolve(true);
    act(() => {
      done = result.current.run(5);
    });
    await waitFor(() => expect(result.current.pending).toBe(true));
    expect(result.current.variables).toBe(5);
    await act(async () => {
      finish();
      await done;
    });
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.variables).toBeUndefined();
  });
});
