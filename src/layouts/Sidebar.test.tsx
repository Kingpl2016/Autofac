// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import i18n from "@/shared/i18n";
import { usePrefsStore } from "@/shared/stores/prefsStore";
import { Sidebar } from "./Sidebar";

function renderSidebar() {
  return render(
    <MemoryRouter>
      <Sidebar />
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  usePrefsStore.setState({ sidebarCollapsed: false });
});

afterEach(() => cleanup());

describe("Sidebar", () => {
  it("展开时为宽栏并显示导航文字", () => {
    const { container } = renderSidebar();
    expect(container.querySelector("aside")?.className).toContain("w-60");
    expect(screen.getByText("仪表盘")).toBeTruthy();
  });

  it("边缘把手切换折叠：收窄为图标栏，并更新 aria-expanded 与 store", () => {
    const { container } = renderSidebar();
    const handle = screen.getByRole("button", { name: "收起侧栏" });
    expect(handle.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(handle);

    expect(usePrefsStore.getState().sidebarCollapsed).toBe(true);
    expect(container.querySelector("aside")?.className).toContain("w-20");
    expect(
      screen.getByRole("button", { name: "展开侧栏" }).getAttribute("aria-expanded"),
    ).toBe("false");
    // 折叠后链接仍有可访问名称
    expect(
      screen.getAllByRole("link").every((l) => l.getAttribute("aria-label")),
    ).toBe(true);
  });

  it("折叠 / 展开时 DOM 结构不变：链接不重挂载，只切换标签的可见性", () => {
    renderSidebar();
    const linksBefore = screen.getAllByRole("link");
    const label = screen.getByText("仪表盘");
    expect(label.getAttribute("aria-hidden")).toBe("false");
    expect(label.className).toContain("opacity-100");

    fireEvent.click(screen.getByRole("button", { name: "收起侧栏" }));

    // 同一批 DOM 节点（没有卸载重建），文字仍在但淡出并对读屏隐藏
    const linksAfter = screen.getAllByRole("link");
    expect(linksAfter).toHaveLength(linksBefore.length);
    linksAfter.forEach((l, i) => expect(l).toBe(linksBefore[i]));
    expect(screen.getByText("仪表盘")).toBe(label);
    expect(label.getAttribute("aria-hidden")).toBe("true");
    expect(label.className).toContain("opacity-0");
    expect(label.className).toContain("whitespace-nowrap");
  });

  it("图标位置在折叠前后保持一致（链接内边距不随折叠变化）", () => {
    renderSidebar();
    const link = screen.getAllByRole("link")[0];
    const before = link.className;
    fireEvent.click(screen.getByRole("button", { name: "收起侧栏" }));
    expect(link.className).toBe(before);
    expect(link.className).toContain("px-3.5");
    expect(link.className).toContain("overflow-hidden");
  });

  // 回归：TooltipTrigger asChild 的 Slot 会把函数形式的 className 转成字符串，
  // 页面上表现为链接样式整体失效（图标与文字上下堆叠、无内边距、无选中高亮）。
  it("链接的 class 是真正的类名，而不是被字符串化的函数", () => {
    renderSidebar();
    for (const link of screen.getAllByRole("link")) {
      const cls = link.getAttribute("class") ?? "";
      expect(cls).not.toMatch(/=>|isActive|\(|\)/);
      for (const token of ["flex", "items-center", "gap-4", "px-3.5", "py-2.5"]) {
        expect(cls.split(/\s+/)).toContain(token);
      }
    }
  });

  it("当前页的链接带 aria-current，并由它驱动选中样式", () => {
    renderSidebar();
    const current = screen
      .getAllByRole("link")
      .filter((l) => l.getAttribute("aria-current") === "page");
    expect(current).toHaveLength(1);
    expect(current[0].getAttribute("aria-label")).toBe("仪表盘");
    expect(current[0].className).toContain("aria-[current=page]:bg-sidebar-accent");
  });

  it("分组标题折叠时淡出并显示分隔线，展开时相反", () => {
    const { container } = renderSidebar();
    const title = screen.getByText("信号");
    const divider = title.nextElementSibling as HTMLElement;
    expect(title.className).toContain("opacity-100");
    expect(divider.className).toContain("opacity-0");

    fireEvent.click(screen.getByRole("button", { name: "收起侧栏" }));
    expect(title.className).toContain("opacity-0");
    expect(divider.className).toContain("opacity-100");
    // 折叠时隐藏滚动条，避免挤偏仅 40px 宽的图标列
    expect(container.querySelector("nav")?.className).toContain("scrollbar-width:none");
  });

  it("再次点击把手可展开回宽栏", () => {
    const { container } = renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "收起侧栏" }));
    fireEvent.click(screen.getByRole("button", { name: "展开侧栏" }));
    expect(usePrefsStore.getState().sidebarCollapsed).toBe(false);
    expect(container.querySelector("aside")?.className).toContain("w-60");
  });
});
