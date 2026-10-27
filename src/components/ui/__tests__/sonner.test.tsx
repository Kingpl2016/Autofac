// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { toast } from "sonner";

import i18n from "@/shared/i18n";
import { Toaster } from "../sonner";

beforeEach(async () => {
  await i18n.changeLanguage("zh");
});
afterEach(() => {
  act(() => void toast.dismiss());
  cleanup();
});

describe("Toaster", () => {
  it("在屏幕上方居中弹出，容器有本地化的无障碍名称", async () => {
    const { container } = render(<Toaster />);
    act(() => void toast.success("已保存"));
    const item = await screen.findByText("已保存");
    const li = item.closest("li") as HTMLElement;
    expect(li.getAttribute("data-y-position")).toBe("top");
    expect(li.getAttribute("data-x-position")).toBe("center");
    expect(container.ownerDocument.querySelector("section")?.getAttribute("aria-label")).toContain("通知");
  });

  it("用自定义样式而不是 Sonner 默认样式；图标带语义色圆底，成功 / 错误各有强调色", async () => {
    render(<Toaster />);
    act(() => {
      toast.success("已保存");
      toast.error("保存失败", { description: "磁盘已满" });
    });
    const ok = (await screen.findByText("已保存")).closest("li") as HTMLElement;
    const bad = (await screen.findByText("保存失败")).closest("li") as HTMLElement;

    expect(ok.getAttribute("data-styled")).toBe("false");
    expect(ok.className).toContain("rounded-2xl");
    expect(ok.className).toContain("--toast-accent:var(--success)");
    expect(bad.className).toContain("--toast-accent:var(--destructive)");
    expect(ok.querySelector("[data-icon]")?.className).toContain("rounded-full");
    expect(screen.getByText("磁盘已满")).toBeTruthy();
  });

  it("有关闭按钮，名称是本地化的“关闭”", async () => {
    render(<Toaster />);
    act(() => void toast("提示"));
    await screen.findByText("提示");
    expect(screen.getByRole("button", { name: "关闭" })).toBeTruthy();
  });
});
