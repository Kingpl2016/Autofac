// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@/shared/tauri/invoke", () => ({ invoke }));

import i18n from "@/shared/i18n";
import { useEngineStatusStore } from "@/shared/stores/engineStatusStore";
import { usePrefsStore } from "@/shared/stores/prefsStore";
import { Sidebar } from "../Sidebar";

function renderSidebar() {
  return render(
    <MemoryRouter>
      <Sidebar />
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  usePrefsStore.setState({ sidebarCollapsed: false });
  useEngineStatusStore.setState({ appMode: "live" });
});

afterEach(() => cleanup());

describe("Sidebar 与播放器模式", () => {
  it("导航里没有独立的“播放器”入口：播放模式从顶栏的“播放器”按钮进入", () => {
    renderSidebar();
    const labels = screen.getAllByRole("link").map((l) => l.getAttribute("aria-label"));
    expect(labels).not.toContain("播放器");
    expect(labels).toContain("录制");
  });

  it("实时模式下没有“已暂停”标记", () => {
    renderSidebar();
    expect(screen.getAllByRole("link").some((l) => /已暂停/.test(l.getAttribute("aria-label") ?? ""))).toBe(false);
  });

  it("播放器模式下，依赖实时信号的页面仍可进入，但在名称里写明“已暂停”（不只靠图标）", () => {
    useEngineStatusStore.setState({ appMode: "player" });
    renderSidebar();
    const paused = screen
      .getAllByRole("link")
      .filter((l) => /已暂停/.test(l.getAttribute("aria-label") ?? ""))
      .map((l) => l.getAttribute("aria-label"));
    expect(paused).toEqual([
      "Universe 视图（播放器模式下已暂停）",
      "设备发现（播放器模式下已暂停）",
      "录制（播放器模式下已暂停）",
    ]);
    // 转发、信号流等不依赖实时信号的页面不受影响
    expect(screen.getByRole("link", { name: "信号转发" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "信号流" })).toBeTruthy();
  });
});

describe("Sidebar 的“工具”分组", () => {
  it("信号检测器是按钮而不是页面链接：点击打开独立窗口", () => {
    renderSidebar();
    expect(screen.getByText("工具")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "信号检测器" })).toBeNull();

    const button = screen.getByRole("button", { name: "信号检测器" });
    expect(button.getAttribute("aria-keyshortcuts")).toBe("Control+Shift+T");
    fireEvent.click(button);
    expect(invoke).toHaveBeenCalledWith("signal_checker_open");
  });

  it("折叠后按钮仍可访问，样式与导航链接一致（图标位置不跳）", () => {
    renderSidebar();
    const link = screen.getAllByRole("link")[0];
    const button = screen.getByRole("button", { name: "信号检测器" });
    fireEvent.click(screen.getByRole("button", { name: "收起侧栏" }));
    expect(screen.getByRole("button", { name: "信号检测器" })).toBe(button);
    for (const token of ["flex", "items-center", "gap-3", "px-2.5", "overflow-hidden"]) {
      expect(button.className.split(/\s+/)).toContain(token);
      expect(link.className.split(/\s+/)).toContain(token);
    }
  });
});

describe("Sidebar", () => {
  it("展开时为宽栏并显示导航文字", () => {
    const { container } = renderSidebar();
    expect(container.querySelector("aside")?.className).toContain("w-52");
    expect(screen.getByText("仪表盘")).toBeTruthy();
  });

  it("边缘把手切换折叠：收窄为图标栏，并更新 aria-expanded 与 store", () => {
    const { container } = renderSidebar();
    const handle = screen.getByRole("button", { name: "收起侧栏" });
    expect(handle.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(handle);

    expect(usePrefsStore.getState().sidebarCollapsed).toBe(true);
    expect(container.querySelector("aside")?.className).toContain("w-16");
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
    expect(link.className).toContain("px-2.5");
    expect(link.className).toContain("overflow-hidden");
  });

  // 回归：TooltipTrigger asChild 的 Slot 会把函数形式的 className 转成字符串，
  // 页面上表现为链接样式整体失效（图标与文字上下堆叠、无内边距、无选中高亮）。
  it("链接的 class 是真正的类名，而不是被字符串化的函数", () => {
    renderSidebar();
    for (const link of screen.getAllByRole("link")) {
      const cls = link.getAttribute("class") ?? "";
      expect(cls).not.toMatch(/=>|isActive|\(|\)/);
      for (const token of ["flex", "items-center", "gap-3", "px-2.5", "py-2"]) {
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
    expect(container.querySelector("aside")?.className).toContain("w-52");
  });
});
