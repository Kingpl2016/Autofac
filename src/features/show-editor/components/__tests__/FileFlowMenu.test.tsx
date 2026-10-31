// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";

// mock 只对声明它的文件生效（共用的取用方式见 fileFlowKit.tsx）
vi.mock("@/shared/tauri/invoke", () => ({ invoke: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), loading: vi.fn(() => "t1"), dismiss: vi.fn() } }));
vi.mock("@/shared/tauri/pickers", async (orig) => ({
  ...(await orig<typeof import("@/shared/tauri/pickers")>()),
  pickArtshowFile: vi.fn(),
  pickArtshowSavePath: vi.fn(),
  pickArtrecSavePath: vi.fn(),
}));

import { useDocumentStore } from "../../stores/useDocumentStore";
import { useProjectStore } from "../../stores/useProjectStore";
import type { ShowProject } from "../../lib/project";
import { callsOf, dirty, fileItem, installBackend, makeDirty, openFileMenu, pickers, project, renderEditor, toast, setupFileFlow } from "./fileFlowKit";

setupFileFlow();

describe("文件菜单的其它操作", () => {
  it("当前节目没保存过时，重新载入 / 显示位置 / 复制路径不可用；菜单项显示快捷键", async () => {
    installBackend();
    renderEditor();
    openFileMenu();
    expect((await fileItem("重新载入")).getAttribute("aria-disabled")).toBe("true");
    expect((await fileItem("在文件管理器中显示")).getAttribute("aria-disabled")).toBe("true");
    expect((await fileItem("复制文件路径")).getAttribute("aria-disabled")).toBe("true");
    expect((await fileItem("新建节目")).textContent).toContain("Ctrl+N");
    expect((await fileItem("导入节目…")).textContent).toContain("Ctrl+I");
  });

  it("重新载入：有修改时先确认，放弃修改后恢复成磁盘上的内容", async () => {
    installBackend();
    renderEditor(`/editor?open=${encodeURIComponent("D:/rec/开场.artrec")}`);
    await waitFor(() => expect(project().name).toBe("开场"));
    makeDirty();
    expect(project().fixtures).toHaveLength(3);
    openFileMenu();
    fireEvent.click(await fileItem("重新载入"));
    const dialog = await screen.findByRole("dialog", { name: "放弃修改并重新载入？" });
    fireEvent.click(within(dialog).getByRole("button", { name: "放弃修改并重新载入" }));
    await waitFor(() => expect(project().fixtures).toHaveLength(2));
    expect(dirty()).toBe(false);
    expect(toast.success).toHaveBeenCalledWith("已从磁盘重新载入");
  });

  it("在文件管理器中显示、复制文件路径", async () => {
    installBackend();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    useDocumentStore.getState().setOrigin({ kind: "library", path: "D:/rec/开场.artrec" });
    renderEditor();
    openFileMenu();
    fireEvent.click(await fileItem("在文件管理器中显示"));
    await waitFor(() => expect(callsOf("show_reveal")).toHaveLength(1));
    expect(callsOf("show_reveal")[0][1]).toEqual({ kind: "library", path: "D:/rec/开场.artrec" });
    openFileMenu();
    fireEvent.click(await fileItem("复制文件路径"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("D:/rec/开场.artrec"));
  });

  it("导出 ArtRec：选路径后烘焙当前工程（含未保存修改），完成后报告帧数", async () => {
    installBackend();
    renderEditor();
    makeDirty();
    pickers.pickArtrecSavePath.mockResolvedValueOnce("D:/导出/秀.artrec");
    openFileMenu();
    fireEvent.click(await fileItem("导出 ArtRec 回放文件…"));
    await waitFor(() => expect(callsOf("show_export_artrec")).toHaveLength(1));
    const args = callsOf("show_export_artrec")[0][1] as { path: string; json: string };
    expect(args.path).toBe("D:/导出/秀.artrec");
    expect((JSON.parse(args.json) as ShowProject).fixtures).toHaveLength(1);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("12 帧"), expect.anything()));
    expect(dirty()).toBe(true);
  });

  it("Ctrl+Shift+E 导出 ArtRec，Ctrl+N 新建（命令表与菜单共用）", async () => {
    installBackend();
    renderEditor();
    pickers.pickArtrecSavePath.mockResolvedValueOnce(null);
    fireEvent.keyDown(window, { key: "E", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(pickers.pickArtrecSavePath).toHaveBeenCalledTimes(1));
    makeDirty();
    fireEvent.keyDown(window, { key: "n", ctrlKey: true });
    expect(await screen.findByRole("dialog", { name: "有未保存的修改" })).toBeTruthy();
  });

  it("导入节目：从节目库选一个，合并灯具与时间线（一步撤销）", async () => {
    installBackend();
    renderEditor();
    makeDirty();
    const before = project().fixtures.length;
    openFileMenu();
    fireEvent.click(await fileItem("导入节目…"));
    const dialog = await screen.findByRole("dialog", { name: "导入节目" });
    fireEvent.click(await within(dialog).findByRole("button", { name: /^开场/ }));
    expect(await within(dialog).findByText(/2 台灯具/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "导入" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(project().fixtures).toHaveLength(before + 2);
    // 重新配接：不与原有的灯冲突
    const spots = project().fixtures.map((f) => `${f.universe}@${f.address}`);
    expect(new Set(spots).size).toBe(spots.length);
    act(() => useProjectStore.temporal.getState().undo());
    expect(project().fixtures).toHaveLength(before);
  });

  it("节目信息：位置、文件大小与内容统计", async () => {
    installBackend();
    useDocumentStore.getState().setOrigin({ kind: "library", path: "D:/rec/开场.artrec" });
    renderEditor();
    makeDirty();
    openFileMenu();
    fireEvent.click(await fileItem("节目信息…"));
    const dialog = await screen.findByRole("dialog", { name: "节目信息" });
    expect(within(dialog).getByText("D:/rec/开场.artrec")).toBeTruthy();
    expect(await within(dialog).findByText(/KB/)).toBeTruthy();
    expect(within(dialog).getByText("还没生成（保存后自动生成）")).toBeTruthy();
    expect(within(dialog).getByText("有未保存的修改")).toBeTruthy();
    expect(within(dialog).getByText(/1 台灯具/)).toBeTruthy();
  });
});
