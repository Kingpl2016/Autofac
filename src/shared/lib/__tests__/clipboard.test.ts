// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { copyText } from "../clipboard";

const writeText = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(() => {
  Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
});

describe("copyText", () => {
  it("成功时写入剪贴板并提示", async () => {
    writeText.mockResolvedValue(undefined);
    expect(await copyText("10.0.0.2", { success: "已复制" })).toBe(true);
    expect(writeText).toHaveBeenCalledWith("10.0.0.2");
    expect(toast.success).toHaveBeenCalledWith("已复制");
  });

  it("失败时按需提示，不抛出", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    expect(await copyText("x", { failure: "复制失败" })).toBe(false);
    expect(toast.error).toHaveBeenCalledWith("复制失败");
    expect(await copyText("x")).toBe(false);
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it("剪贴板不可用时返回 false", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    expect(await copyText("x", { failure: "复制失败" })).toBe(false);
    expect(toast.error).toHaveBeenCalledWith("复制失败");
  });
});
