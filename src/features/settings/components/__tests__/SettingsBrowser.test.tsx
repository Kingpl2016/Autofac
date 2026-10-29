// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import i18n from "@/shared/i18n";

vi.mock("../../hooks/useNetworkInterfaces", () => ({
  useNetworkInterfaces: () => ({ data: [{ name: "全部接口", ip: "0.0.0.0", isLoopback: false }] }),
}));

import { DEFAULT_SETTINGS } from "../../lib/api";
import { SettingsBrowser } from "../SettingsBrowser";

/** 可手动触发“进入视口”的 IntersectionObserver 替身。 */
class FakeObserver {
  static last: FakeObserver | null = null;
  readonly cb: IntersectionObserverCallback;
  readonly targets: Element[] = [];
  constructor(cb: IntersectionObserverCallback) {
    this.cb = cb;
    FakeObserver.last = this;
  }
  observe(el: Element) {
    this.targets.push(el);
  }
  unobserve() {}
  disconnect() {}
  fire(id: string, isIntersecting: boolean) {
    const target = this.targets.find((e) => e.id === id)!;
    this.cb([{ target, isIntersecting } as unknown as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  vi.stubGlobal("IntersectionObserver", FakeObserver);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const renderBrowser = () => render(<SettingsBrowser settings={DEFAULT_SETTINGS} update={vi.fn()} />);
const nav = () => screen.getByRole("navigation", { name: "设置分区" });

describe("SettingsBrowser", () => {
  it("目录列出各分区，不再有快捷键；默认第一项为当前", () => {
    renderBrowser();
    const links = within(nav()).getAllByRole("link");
    expect(links.map((a) => a.textContent)).toContain("网络");
    expect(links.map((a) => a.textContent)).not.toContain("快捷键");
    expect(links[0].getAttribute("aria-current")).toBe("location");
    expect(screen.queryByText("开始录制")).toBeNull();
  });

  it("滚动到某分区后目录高亮跟随", () => {
    renderBrowser();
    act(() => FakeObserver.last!.fire("merge", true));
    expect(within(nav()).getByRole("link", { name: "合并" }).getAttribute("aria-current")).toBe("location");
  });

  it("点击目录项立即高亮", () => {
    renderBrowser();
    fireEvent.click(within(nav()).getByRole("link", { name: "录制" }));
    expect(within(nav()).getByRole("link", { name: "录制" }).getAttribute("aria-current")).toBe("location");
  });

  it("搜索行标签只留命中的分区和行", () => {
    renderBrowser();
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索设置" }), { target: { value: "art-net 端口" } });
    expect(screen.getByText("Art-Net 端口")).toBeTruthy();
    expect(screen.queryByText("启用 sACN")).toBeNull();
    expect(screen.queryByRole("region", { name: "合并" })).toBeNull();
    expect(within(nav()).getAllByRole("link").map((a) => a.textContent)).toEqual(["协议"]);
    expect(screen.getByText("Art-Net 端口").closest('[data-slot="setting-row"]')?.hasAttribute("data-match")).toBe(true);
  });

  it("搜索分区名时显示分区内全部行", () => {
    renderBrowser();
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索设置" }), { target: { value: "合并" } });
    const region = screen.getByRole("region", { name: "合并" });
    expect(region.querySelectorAll('[data-slot="setting-row"]').length).toBe(2);
  });

  it("没有结果时显示空状态，清除后恢复", () => {
    renderBrowser();
    const box = screen.getByRole("searchbox", { name: "搜索设置" });
    fireEvent.change(box, { target: { value: "zzzz" } });
    expect(screen.getByText("没有与“zzzz”匹配的设置")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "清除搜索" }).at(-1)!);
    expect(screen.getByRole("region", { name: "网络" })).toBeTruthy();
  });

  it("Esc 清空搜索", () => {
    renderBrowser();
    const box = screen.getByRole("searchbox", { name: "搜索设置" });
    fireEvent.change(box, { target: { value: "zzzz" } });
    fireEvent.keyDown(box, { key: "Escape" });
    expect((box as HTMLInputElement).value).toBe("");
  });
});
