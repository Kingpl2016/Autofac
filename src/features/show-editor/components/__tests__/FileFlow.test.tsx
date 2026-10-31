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
import { callsOf, client, dirty, fileItem, installBackend, invoke, makeDirty, openFileMenu, origin, pickers, project, renderEditor, sample, toast, toolbar, setupFileFlow } from "./fileFlowKit";

setupFileFlow();

describe("保存到节目库", () => {
  it("没保存过：弹出对话框，名称不能为空；提交后写入库、关闭对话框、刷新节目库列表", async () => {
    installBackend();
    renderEditor();
    makeDirty();
    fireEvent.click(within(toolbar()).getByRole("button", { name: "保存" }));

    // 文件里的第一个用例要冷启动整个编辑器，机器忙时放宽等待
    const dialog = await screen.findByRole("dialog", { name: "保存到节目库" }, { timeout: 5000 });
    const name = within(dialog).getByLabelText("节目名称");
    fireEvent.change(name, { target: { value: "  " } });
    expect(within(dialog).getByText("请填写节目名称")).toBeTruthy();
    expect((within(dialog).getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(name, { target: { value: "春晚彩排" } });
    fireEvent.change(within(dialog).getByLabelText("备注"), { target: { value: "A 厅" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const args = callsOf("show_project_save")[0][1]?.args as { path?: string; name: string; notes: string; fileStem: string };
    expect(args).toMatchObject({ name: "春晚彩排", notes: "A 厅", fileStem: "春晚彩排" });
    expect(args.path).toBeUndefined();
    expect(origin()).toEqual({ kind: "library", path: "D:/rec/春晚彩排.artrec" });
    expect(dirty()).toBe(false);
    expect(toast.success).toHaveBeenCalledWith("已保存到节目库：春晚彩排");
    expect(client.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["recordings"] });
  });

  it("已在库里：直接覆盖保存，不弹对话框", async () => {
    installBackend();
    useDocumentStore.getState().setOrigin({ kind: "library", path: "D:/rec/开场.artrec" });
    renderEditor();
    makeDirty();
    fireEvent.click(within(toolbar()).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("已保存"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect((callsOf("show_project_save")[0][1]?.args as { path?: string }).path).toBe("D:/rec/开场.artrec");
    expect(dirty()).toBe(false);
  });

  it("有未保存修改时通知后端（退出守卫据此确认），保存后复位", async () => {
    installBackend({ autosave: null });
    renderEditor();
    makeDirty();
    await waitFor(() => expect(callsOf("show_set_dirty").at(-1)?.[1]).toEqual({ dirty: true }));
    act(() => useProjectStore.getState().markSaved());
    await waitFor(() => expect(callsOf("show_set_dirty").at(-1)?.[1]).toEqual({ dirty: false }));
  });

  it("Ctrl+S 等同于点击保存，在输入框里也生效", async () => {
    installBackend();
    useDocumentStore.getState().setOrigin({ kind: "library", path: "D:/rec/开场.artrec" });
    renderEditor();
    makeDirty();
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await waitFor(() => expect(callsOf("show_project_save")).toHaveLength(1));
  });

  it("保存失败：toast 说明原因，工程仍是未保存", async () => {
    installBackend();
    renderEditor();
    makeDirty();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "show_project_save") throw "project_too_large";
      return null;
    });
    fireEvent.click(within(toolbar()).getByRole("button", { name: "保存" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("工程文件太大，超过 64 MB"));
    expect(dirty()).toBe(true);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("“另存为新节目”总是新建，即使当前工程已在库里", async () => {
    installBackend();
    useDocumentStore.getState().setOrigin({ kind: "library", path: "D:/rec/开场.artrec" });
    renderEditor();
    openFileMenu();
    fireEvent.click(await fileItem("另存为新节目…"));
    const dialog = await screen.findByRole("dialog", { name: "另存为新节目" });
    fireEvent.change(within(dialog).getByLabelText("节目名称"), { target: { value: "副本" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(callsOf("show_project_save")).toHaveLength(1));
    expect((callsOf("show_project_save")[0][1]?.args as { path?: string }).path).toBeUndefined();
    expect(origin()).toEqual({ kind: "library", path: "D:/rec/副本.artrec" });
  });
});

describe("库外文件", () => {
  it("导出工程副本：选路径后写文件，当前节目仍在原位置、未保存状态不变；取消则什么都不做", async () => {
    installBackend();
    useDocumentStore.getState().setOrigin({ kind: "library", path: "D:/rec/开场.artrec" });
    renderEditor();
    makeDirty();
    openFileMenu();
    pickers.pickArtshowSavePath.mockResolvedValueOnce(null);
    fireEvent.click(await fileItem("导出工程副本…"));
    await waitFor(() => expect(pickers.pickArtshowSavePath).toHaveBeenCalledTimes(1));
    expect(callsOf("show_external_save")).toHaveLength(0);

    openFileMenu();
    pickers.pickArtshowSavePath.mockResolvedValueOnce("D:/桌面/备份.artshow");
    fireEvent.click(await fileItem("导出工程副本…"));
    await waitFor(() => expect(callsOf("show_external_save")).toHaveLength(1));
    expect(callsOf("show_external_save")[0][1]?.path).toBe("D:/桌面/备份.artshow");
    expect(origin()).toEqual({ kind: "library", path: "D:/rec/开场.artrec" });
    expect(dirty()).toBe(true);
  });

  it("另存为工程文件：之后保存都写到这个文件", async () => {
    installBackend();
    renderEditor();
    makeDirty();
    openFileMenu();
    pickers.pickArtshowSavePath.mockResolvedValueOnce("D:/桌面/新.artshow");
    fireEvent.click(await fileItem("另存为工程文件…"));
    await waitFor(() => expect(origin()).toEqual({ kind: "external", path: "D:/桌面/新.artshow" }));
    expect(dirty()).toBe(false);
  });

  it("打开文件：载入工程，来源为该文件，之后保存回写原路径", async () => {
    const store = installBackend();
    store.set("D:/桌面/别人的.artshow", JSON.stringify(sample("别人的")));
    renderEditor();
    pickers.pickArtshowFile.mockResolvedValue("D:/桌面/别人的.artshow");
    openFileMenu();
    fireEvent.click(await fileItem("打开工程文件…"));
    await waitFor(() => expect(project().name).toBe("别人的"));
    expect(origin()).toEqual({ kind: "external", path: "D:/桌面/别人的.artshow" });
    makeDirty();
    fireEvent.click(within(toolbar()).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(callsOf("show_external_save")).toHaveLength(1));
    expect(callsOf("show_project_save")).toHaveLength(0);
  });

  it("打开损坏的文件：提示，当前工程不受影响", async () => {
    const store = installBackend();
    store.set("D:/坏.artshow", "{不是json");
    renderEditor();
    pickers.pickArtshowFile.mockResolvedValue("D:/坏.artshow");
    openFileMenu();
    fireEvent.click(await fileItem("打开工程文件…"));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("工程文件已损坏或不是节目编辑器的工程"));
    expect(origin()).toEqual({ kind: "none" });
  });
});

describe("从节目库打开", () => {
  it("只列出可编辑的节目，未导出的带标记；选中后载入", async () => {
    installBackend();
    renderEditor();
    openFileMenu();
    fireEvent.click(await fileItem("从节目库打开…"));
    const dialog = await screen.findByRole("dialog", { name: "从节目库打开" });
    expect(await within(dialog).findByText("开场")).toBeTruthy();
    expect(within(dialog).queryByText("录制来的")).toBeNull();
    expect(within(dialog).getByText("未导出")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: /^开场/ }));
    await waitFor(() => expect(project().name).toBe("开场"));
    expect(origin()).toEqual({ kind: "library", path: "D:/rec/开场.artrec" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("地址栏的 ?open= 参数直接打开那个节目（来自节目库页的“在编辑器中打开”）", async () => {
    installBackend();
    renderEditor(`/editor?open=${encodeURIComponent("D:/rec/开场.artrec")}`);
    await waitFor(() => expect(project().name).toBe("开场"));
    expect(origin()).toEqual({ kind: "library", path: "D:/rec/开场.artrec" });
  });

  it("有未保存修改时，?open= 先询问", async () => {
    installBackend();
    makeDirty();
    renderEditor(`/editor?open=${encodeURIComponent("D:/rec/开场.artrec")}`);
    const dialog = await screen.findByRole("dialog", { name: "有未保存的修改" });
    expect(project().name).toBe("");
    fireEvent.click(within(dialog).getByRole("button", { name: "不保存" }));
    await waitFor(() => expect(project().name).toBe("开场"));
  });
});
