// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import i18n from "@/shared/i18n";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
const api = vi.hoisted(() => ({ saveForwarding: vi.fn() }));
const files = vi.hoisted(() => ({ openTextFile: vi.fn(), saveTextFile: vi.fn() }));

vi.mock("sonner", () => ({ toast }));
vi.mock("@/features/settings", () => ({ useProtocolFlags: () => ({ sacnEnabled: false }) }));
vi.mock("../../lib/api", async (orig) => ({
  ...(await orig<typeof import("../../lib/api")>()),
  ...api,
}));
vi.mock("@/shared/tauri/files", () => files);

import { newDestination, type ForwardDestination } from "../../lib/types";
import { ForwardingEditor } from "../ForwardingEditor";

const dest = (id: string, name: string, ip = "10.0.0.5"): ForwardDestination => ({
  ...newDestination(),
  id,
  name,
  targetIp: ip,
});

const table = { destinations: [dest("a", "舞台左", "10.0.0.5"), dest("b", "舞台右", "10.0.0.6")] };

/** 点击后让导入等异步流程落定。 */
async function click(el: HTMLElement) {
  await act(async () => {
    fireEvent.click(el);
  });
}

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  vi.clearAllMocks();
  api.saveForwarding.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("删除确认", () => {
  it("点击删除先弹出确认框，写明名称与 IP，此时不删除", async () => {
    render(<ForwardingEditor initial={table} />);
    await click(screen.getByRole("button", { name: "删除 舞台左" }));

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("删除目的地“舞台左”？");
    expect(dialog.textContent).toContain("10.0.0.5");
    expect(screen.getAllByText("舞台左").length).toBeGreaterThan(0);
    expect(api.saveForwarding).not.toHaveBeenCalled();
  });

  it("取消：目的地保留", async () => {
    render(<ForwardingEditor initial={table} />);
    await click(screen.getByRole("button", { name: "删除 舞台左" }));
    await click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("舞台左")).toBeTruthy();
  });

  it("确认：删除该目的地并自动保存", async () => {
    vi.useFakeTimers();
    render(<ForwardingEditor initial={table} />);
    await click(screen.getByRole("button", { name: "删除 舞台左" }));
    await click(screen.getByRole("button", { name: "删除" }));

    expect(screen.queryByText("舞台左")).toBeNull();
    expect(screen.getByText("舞台右")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    const saved = api.saveForwarding.mock.calls[0][0] as { destinations: ForwardDestination[] };
    expect(saved.destinations.map((d) => d.id)).toEqual(["b"]);
  });
});

describe("导入", () => {
  const exported = JSON.stringify([dest("n1", "导入A", "10.0.1.1"), dest("n2", "导入B", "10.0.1.2")]);

  it("用户取消选择文件时什么也不发生", async () => {
    files.openTextFile.mockResolvedValue(null);
    render(<ForwardingEditor initial={table} />);
    await click(screen.getByRole("button", { name: "导入" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("文件有误：拒绝并指出第几项的哪个字段，现有数据不受影响", async () => {
    files.openTextFile.mockResolvedValue(
      JSON.stringify([dest("n1", "好", "10.0.1.1"), { ...dest("n2", "坏"), targetIp: "999.0.0.1" }]),
    );
    render(<ForwardingEditor initial={table} />);
    await click(screen.getByRole("button", { name: "导入" }));

    const msg = toast.error.mock.calls[0][0] as string;
    expect(msg).toContain("第 2 个");
    expect(msg).toContain("目标 IP");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("舞台左")).toBeTruthy();
  });

  it("不是 JSON：给出明确提示", async () => {
    files.openTextFile.mockResolvedValue("not json");
    render(<ForwardingEditor initial={table} />);
    await click(screen.getByRole("button", { name: "导入" }));
    expect(toast.error.mock.calls[0][0]).toContain("不是有效的 JSON");
  });

  it("已有目的地：弹出选择框，选“替换”后只剩导入的内容", async () => {
    files.openTextFile.mockResolvedValue(exported);
    render(<ForwardingEditor initial={table} />);
    await click(screen.getByRole("button", { name: "导入" }));

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("导入 2 个目的地");
    expect(dialog.textContent).toContain("当前已有 2 个");

    await click(screen.getByRole("button", { name: "替换当前" }));
    expect(screen.queryByText("舞台左")).toBeNull();
    expect(screen.getByText("导入A")).toBeTruthy();
    expect(screen.getByText("导入B")).toBeTruthy();
    expect(toast.success).toHaveBeenCalledWith("已导入 2 个目的地");
  });

  it("选“合并”：保留现有并追加导入的", async () => {
    files.openTextFile.mockResolvedValue(exported);
    render(<ForwardingEditor initial={table} />);
    await click(screen.getByRole("button", { name: "导入" }));
    await click(screen.getByRole("button", { name: "合并追加" }));

    for (const name of ["舞台左", "舞台右", "导入A", "导入B"]) {
      expect(screen.getByText(name)).toBeTruthy();
    }
  });

  it("选择框里取消：保持原样", async () => {
    files.openTextFile.mockResolvedValue(exported);
    render(<ForwardingEditor initial={table} />);
    await click(screen.getByRole("button", { name: "导入" }));
    await click(screen.getByRole("button", { name: "取消" }));
    expect(screen.getByText("舞台左")).toBeTruthy();
    expect(screen.queryByText("导入A")).toBeNull();
  });

  it("当前没有目的地时直接导入，不再确认", async () => {
    files.openTextFile.mockResolvedValue(exported);
    render(<ForwardingEditor initial={{ destinations: [] }} />);
    await click(screen.getByRole("button", { name: "导入" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("导入A")).toBeTruthy();
  });
});

describe("保存失败提示", () => {
  it("自动保存失败时在页面顶部提示，点击重试后消失", async () => {
    vi.useFakeTimers();
    api.saveForwarding.mockRejectedValueOnce(new Error("磁盘已满"));
    render(<ForwardingEditor initial={table} />);

    fireEvent.click(screen.getAllByRole("switch")[0]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByRole("alert").textContent).toContain("转发配置保存失败");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "重试" }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(api.saveForwarding).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("列表摘要使用本地化文案", () => {
  it("偏移、延迟、覆盖条数显示为中文", () => {
    const d = {
      ...dest("a", "舞台左"),
      universeOffset: 100,
      defaultDelayMs: 30,
      overrides: [{ sourceUniverse: 1, action: "forward" as const }],
    };
    render(<ForwardingEditor initial={{ destinations: [d] }} />);
    expect(screen.getByText("10.0.0.5:6454 · 偏移 100 · 延迟 30ms · 1 条覆盖")).toBeTruthy();
  });
});