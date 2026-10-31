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

import { AUTOSAVE_INTERVAL_MS } from "../../hooks/useShowFile";
import { useRecentFilesStore } from "../../stores/useRecentFilesStore";
import type { ShowProject } from "../../lib/project";
import { callsOf, dirty, fileItem, installBackend, makeDirty, openFileMenu, openRecent, origin, project, renderEditor, sample, toast, setupFileFlow } from "./fileFlowKit";

setupFileFlow();

describe("未保存修改的确认", () => {
  it("新建：取消保持原样，不保存则丢弃修改", async () => {
    installBackend();
    renderEditor();
    makeDirty();
    openFileMenu();
    fireEvent.click(await fileItem("新建节目"));
    let dialog = await screen.findByRole("dialog", { name: "有未保存的修改" });
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(project().fixtures).toHaveLength(1);

    openFileMenu();
    fireEvent.click(await fileItem("新建节目"));
    dialog = await screen.findByRole("dialog", { name: "有未保存的修改" });
    fireEvent.click(within(dialog).getByRole("button", { name: "不保存" }));
    await waitFor(() => expect(project().fixtures).toHaveLength(0));
    expect(dirty()).toBe(false);
  });

  it("选择保存：库内节目先保存再继续；没保存过的先起名，保存成功后继续", async () => {
    installBackend();
    renderEditor();
    makeDirty();
    openFileMenu();
    fireEvent.click(await fileItem("新建节目"));
    const unsaved = await screen.findByRole("dialog", { name: "有未保存的修改" });
    fireEvent.click(within(unsaved).getByRole("button", { name: "保存" }));
    const nameDialog = await screen.findByRole("dialog", { name: "保存到节目库" });
    fireEvent.change(within(nameDialog).getByLabelText("节目名称"), { target: { value: "先存一下" } });
    fireEvent.click(within(nameDialog).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(callsOf("show_project_save")).toHaveLength(1));
    await waitFor(() => expect(project().fixtures).toHaveLength(0));
    expect(origin()).toEqual({ kind: "none" });
  });
});

describe("自动存档与恢复", () => {
  it("上次留下了自动存档：询问；恢复后内容回来且仍是未保存", async () => {
    installBackend({ autosave: JSON.stringify(sample("崩溃前")) });
    renderEditor();
    const dialog = await screen.findByRole("dialog", { name: "恢复上次未保存的工程？" });
    fireEvent.click(within(dialog).getByRole("button", { name: "恢复" }));
    await waitFor(() => expect(project().name).toBe("崩溃前"));
    expect(dirty()).toBe(true);
    expect(toast.success).toHaveBeenCalledWith("已恢复上次未保存的工程");
  });

  it("放弃恢复会删除存档；同一次运行里不会再问第二次", async () => {
    installBackend({ autosave: JSON.stringify(sample("崩溃前")) });
    const first = renderEditor();
    const dialog = await screen.findByRole("dialog", { name: "恢复上次未保存的工程？" });
    fireEvent.click(within(dialog).getByRole("button", { name: "放弃" }));
    await waitFor(() => expect(callsOf("show_autosave_clear")).toHaveLength(1));
    first.unmount();
    renderEditor();
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(callsOf("show_autosave_read")).toHaveLength(1);
  });

  it("工程已有内容时不询问恢复", async () => {
    installBackend({ autosave: JSON.stringify(sample("崩溃前")) });
    makeDirty();
    renderEditor();
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("有未保存修改时每 30 秒写一次自动存档；干净时不写", async () => {
    installBackend();
    renderEditor();
    await act(async () => {
      await Promise.resolve();
    });
    vi.useFakeTimers();
    await act(async () => {
      vi.advanceTimersByTime(AUTOSAVE_INTERVAL_MS * 2);
    });
    expect(callsOf("show_autosave_write")).toHaveLength(0);

    makeDirty();
    await act(async () => {
      vi.advanceTimersByTime(AUTOSAVE_INTERVAL_MS);
    });
    expect(callsOf("show_autosave_write")).toHaveLength(1);
    const written = JSON.parse(callsOf("show_autosave_write")[0][1]?.json as string) as ShowProject;
    expect(written.fixtures).toHaveLength(1);
  });
});

describe("最近文件", () => {
  it("打开后记入最近文件；文件菜单与空节目的预览区都列出，点击再次打开", async () => {
    installBackend();
    renderEditor(`/editor?open=${encodeURIComponent("D:/rec/开场.artrec")}`);
    await waitFor(() => expect(project().name).toBe("开场"));
    expect(useRecentFilesStore.getState().items).toEqual([expect.objectContaining({ path: "D:/rec/开场.artrec", kind: "library", name: "开场" })]);

    // 新建空节目：预览区列出最近文件
    openFileMenu();
    fireEvent.click(await fileItem("新建节目"));
    await waitFor(() => expect(project().name).toBe(""));
    const preview = screen.getByRole("region", { name: "预览" });
    fireEvent.click(within(within(preview).getByRole("list", { name: "最近文件" })).getByRole("button", { name: /开场/ }));
    await waitFor(() => expect(project().name).toBe("开场"));
  });

  it("文件已不存在：提示并可从列表移除；清空列表", async () => {
    installBackend();
    act(() => {
      useRecentFilesStore.getState().record({ path: "D:/丢了.artshow", kind: "external", name: "丢了", openedAt: Date.now() });
      useRecentFilesStore.getState().record({ path: "D:/rec/开场.artrec", kind: "library", name: "开场", openedAt: Date.now() });
    });
    renderEditor();
    await openRecent();
    fireEvent.click(await fileItem("丢了"));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    const [message, opts] = toast.error.mock.calls.at(-1) as unknown as [string, { action: { onClick: () => void } }];
    expect(message).toContain("找不到“丢了”");
    act(() => void opts.action.onClick());
    expect(useRecentFilesStore.getState().items.map((x) => x.name)).toEqual(["开场"]);

    await openRecent();
    fireEvent.click(await fileItem("清空列表"));
    expect(useRecentFilesStore.getState().items).toEqual([]);
  });

  it("置顶：排在最前、清空列表时保留；键盘 P 切换、Delete 移除", async () => {
    installBackend();
    act(() => {
      useRecentFilesStore.getState().record({ path: "D:/a.artshow", kind: "external", name: "甲", openedAt: 1 });
      useRecentFilesStore.getState().record({ path: "D:/b.artshow", kind: "external", name: "乙", openedAt: 2 });
    });
    renderEditor();
    await openRecent();
    const a = await fileItem("甲");
    fireEvent.click(within(a).getByRole("button", { name: "置顶 甲" }));
    expect(useRecentFilesStore.getState().items.find((x) => x.name === "甲")?.pinned).toBe(true);
    const names = within(screen.getByRole("menu", { name: "最近文件" }))
      .getAllByRole("menuitem")
      .map((el) => el.textContent ?? "");
    expect(names[0]).toContain("甲");

    fireEvent.click(await fileItem("清空列表（保留置顶）"));
    expect(useRecentFilesStore.getState().items.map((x) => x.name)).toEqual(["甲"]);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    await openRecent();
    fireEvent.keyDown(await fileItem("甲"), { key: "p" });
    expect(useRecentFilesStore.getState().items[0].pinned).toBeUndefined();
    fireEvent.keyDown(await fileItem("甲"), { key: "Delete" });
    expect(useRecentFilesStore.getState().items).toEqual([]);
  });

  it("清除失效项：查询每个文件，不存在的移除", async () => {
    installBackend();
    act(() => {
      useRecentFilesStore.getState().record({ path: "D:/丢了.artshow", kind: "external", name: "丢了", openedAt: 1 });
      useRecentFilesStore.getState().record({ path: "D:/rec/开场.artrec", kind: "library", name: "开场", openedAt: 2 });
    });
    renderEditor();
    await openRecent();
    fireEvent.click(await fileItem("清除失效项"));
    await waitFor(() => expect(useRecentFilesStore.getState().items.map((x) => x.name)).toEqual(["开场"]));
    expect(toast.success).toHaveBeenCalledWith("已移除 1 个找不到的文件");
  });
});
