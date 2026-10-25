// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

import { announce, useAnnouncerStore } from "@/shared/stores/announcerStore";
import { LiveAnnouncer } from "../LiveAnnouncer";

afterEach(() => {
  cleanup();
  useAnnouncerStore.setState({ message: "", seq: 0 });
});

describe("LiveAnnouncer", () => {
  it("全应用唯一的 role=status 区域：礼貌（polite）、整体原子更新、视觉上隐藏", () => {
    render(<LiveAnnouncer />);
    const region = screen.getByRole("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.getAttribute("aria-atomic")).toBe("true");
    expect(region.className).toContain("sr-only");
  });

  it("announce 会更新内容", () => {
    render(<LiveAnnouncer />);
    act(() => announce("已进入播放器模式"));
    expect(screen.getByRole("status").textContent).toContain("已进入播放器模式");
  });

  it("连续播报同一句话时内容仍会变化，保证读屏重新朗读", () => {
    render(<LiveAnnouncer />);
    act(() => announce("重复模式：循环"));
    const first = screen.getByRole("status").textContent;
    act(() => announce("重复模式：循环"));
    const second = screen.getByRole("status").textContent;
    expect(first).not.toBe(second);
    expect(second?.replace("\u200B", "")).toBe("重复模式：循环");
  });
});
