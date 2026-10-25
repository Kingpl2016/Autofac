// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/shared/tauri/tauriStorage", () => ({
  createTauriPersistStorage: () => ({
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  }),
}));

import i18n from "@/shared/i18n";
import { ChannelGrid } from "../ChannelGrid";

const data = Array.from({ length: 512 }, (_, i) => (i === 9 ? 200 : 0));

beforeEach(async () => {
  await i18n.changeLanguage("zh");
});

afterEach(() => cleanup());

const cell = (channel: number) => document.querySelector<HTMLElement>(`[data-ch="${channel}"]`)!;

describe("ChannelGrid", () => {
  it("显示 512 个色块，并按给定数据着色 / 标出数值", () => {
    render(<ChannelGrid universe={3} valueFormat="decimal" data={data} />);
    expect(document.querySelectorAll("[data-ch]")).toHaveLength(512);
    expect(cell(10).textContent).toBe("200");
    expect(cell(11).textContent).toBe("");
    expect(cell(10).title).toBe("CH10: 200");
  });

  it("没有提供点击回调时，色块不可点（没有手型光标）", () => {
    render(<ChannelGrid universe={0} valueFormat="decimal" data={data} />);
    expect(cell(1).className).not.toContain("cursor-pointer");
    fireEvent.click(cell(5)); // 不应抛错
  });

  it("提供 onChannelClick 后，点击色块以 1 起始的通道号回调", () => {
    const onChannelClick = vi.fn();
    render(<ChannelGrid universe={0} valueFormat="decimal" data={data} onChannelClick={onChannelClick} />);
    fireEvent.click(cell(1));
    fireEvent.click(cell(512));
    expect(onChannelClick.mock.calls).toEqual([[1], [512]]);
    expect(cell(1).className).toContain("cursor-pointer");
  });

  it("selectedChannel 高亮对应色块，并通过 data-selected 暴露状态", () => {
    render(<ChannelGrid universe={0} valueFormat="decimal" data={data} selectedChannel={42} />);
    expect(cell(42).dataset.selected).toBe("true");
    expect(cell(42).className).toContain("ring-primary");
    expect(document.querySelectorAll("[data-selected]")).toHaveLength(1);
    expect(screen.getByRole("grid")).toBeTruthy();
  });
});
