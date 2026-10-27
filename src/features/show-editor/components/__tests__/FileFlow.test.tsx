// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { produce } from "immer";

import i18n from "@/shared/i18n";

const invoke = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const pickers = vi.hoisted(() => ({ pickArtshowFile: vi.fn(), pickArtshowSavePath: vi.fn() }));
vi.mock("@/shared/tauri/invoke", () => ({ invoke }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/shared/tauri/pickers", async (orig) => ({ ...(await orig<typeof import("@/shared/tauri/pickers")>()), ...pickers }));

import { addFixtures } from "../../lib/ops";
import { createEmptyProject, type ShowProject } from "../../lib/project";
import { RGBW } from "../../lib/__tests__/testkit";
import { AUTOSAVE_INTERVAL_MS, resetRecoveryCheck } from "../../hooks/useShowFile";
import { useDocumentStore } from "../../stores/useDocumentStore";
import { selectDirty, useProjectStore } from "../../stores/useProjectStore";
import { ShowEditorView } from "../ShowEditorView";

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

const project = () => useProjectStore.getState().project;
const dirty = () => selectDirty(useProjectStore.getState());
const origin = () => useDocumentStore.getState().origin;
const callsOf = (cmd: string) => invoke.mock.calls.filter((c) => c[0] === cmd);

/** 节目库里的两条记录：一个可编辑（只有工程），一个录制得到的。 */
const LIBRARY = [
  { path: "D:/rec/开场.artrec", fileName: "开场.artrec", name: "开场", notes: "", bytes: 1, modifiedUnixMs: 1_700_000_000_000, durationUs: 0, frames: 0, universes: [], sources: [], recovered: false, valid: false, editable: true, exported: false },
  { path: "D:/rec/录制.artrec", fileName: "录制.artrec", name: "录制来的", notes: "", bytes: 1, modifiedUnixMs: 1_700_000_100_000, durationUs: 1, frames: 1, universes: [0], sources: [], recovered: false, valid: true, editable: false, exported: true },
];

function sample(name = "演出"): ShowProject {
  return produce(createEmptyProject(name), (d) => void addFixtures(d, RGBW, 2));
}

/** 模拟后端：命令按名称分发，保存的工程按路径记在内存里。 */
function installBackend(opts: { autosave?: string | null } = {}) {
  const store = new Map<string, string>([["D:/rec/开场.artrec", JSON.stringify(sample("开场"))]]);
  invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "recordings_list":
        return structuredClone(LIBRARY);
      case "show_project_save": {
        const a = args?.args as { path?: string; fileStem?: string; name: string; json: string };
        const path = a.path ?? `D:/rec/${a.fileStem ?? a.name}.artrec`;
        store.set(path, a.json);
        return path;
      }
      case "show_project_open": {
        const text = store.get(args?.path as string);
        if (!text) throw "not_found";
        return text;
      }
      case "show_external_save":
        store.set(args?.path as string, args?.json as string);
        return undefined;
      case "show_external_read": {
        const text = store.get(args?.path as string);
        if (!text) throw "not_found";
        return text;
      }
      case "show_autosave_read":
        return opts.autosave ?? null;
      case "show_autosave_write":
      case "show_autosave_clear":
        return undefined;
      default:
        throw new Error(`unexpected command ${cmd}`);
    }
  });
  return store;
}

let client: QueryClient;

function renderEditor(url = "/editor") {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(client, "invalidateQueries");
  return render(
    <MemoryRouter initialEntries={[url]}>
      <QueryClientProvider client={client}>
        <ShowEditorView />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const toolbar = () => screen.getByRole("toolbar", { name: "编辑工具条" });

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  invoke.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  pickers.pickArtshowFile.mockReset();
  pickers.pickArtshowSavePath.mockReset();
  resetRecoveryCheck();
  useProjectStore.getState().load(createEmptyProject(""));
  useDocumentStore.getState().setOrigin({ kind: "none" });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const makeDirty = () => act(() => useProjectStore.getState().update((d) => void addFixtures(d, RGBW, 1)));

describe("保存到节目库", () => {
  it("没保存过：弹出对话框，名称不能为空；提交后写入库、关闭对话框、刷新节目库列表", async () => {
    installBackend();
    renderEditor();
    makeDirty();
    fireEvent.click(within(toolbar()).getByRole("button", { name: "保存" }));

    const dialog = await screen.findByRole("dialog", { name: "保存到节目库" });
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
    fireEvent.click(within(toolbar()).getByRole("button", { name: "文件" }));
    fireEvent.click(await screen.findByRole("button", { name: "另存为新节目…" }));
    const dialog = await screen.findByRole("dialog", { name: "另存为新节目" });
    fireEvent.change(within(dialog).getByLabelText("节目名称"), { target: { value: "副本" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(callsOf("show_project_save")).toHaveLength(1));
    expect((callsOf("show_project_save")[0][1]?.args as { path?: string }).path).toBeUndefined();
    expect(origin()).toEqual({ kind: "library", path: "D:/rec/副本.artrec" });
  });
});

describe("库外文件", () => {
  it("导出工程副本：选路径后写文件，取消则什么都不做", async () => {
    installBackend();
    renderEditor();
    fireEvent.click(within(toolbar()).getByRole("button", { name: "文件" }));
    pickers.pickArtshowSavePath.mockResolvedValueOnce(null);
    fireEvent.click(await screen.findByRole("button", { name: "导出工程副本…" }));
    await waitFor(() => expect(pickers.pickArtshowSavePath).toHaveBeenCalledTimes(1));
    expect(callsOf("show_external_save")).toHaveLength(0);

    fireEvent.click(within(toolbar()).getByRole("button", { name: "文件" }));
    pickers.pickArtshowSavePath.mockResolvedValueOnce("D:/桌面/备份.artshow");
    fireEvent.click(await screen.findByRole("button", { name: "导出工程副本…" }));
    await waitFor(() => expect(callsOf("show_external_save")).toHaveLength(1));
    expect(callsOf("show_external_save")[0][1]?.path).toBe("D:/桌面/备份.artshow");
    expect(origin()).toEqual({ kind: "external", path: "D:/桌面/备份.artshow" });
  });

  it("打开文件：载入工程，来源为该文件，之后保存回写原路径", async () => {
    const store = installBackend();
    store.set("D:/桌面/别人的.artshow", JSON.stringify(sample("别人的")));
    renderEditor();
    pickers.pickArtshowFile.mockResolvedValue("D:/桌面/别人的.artshow");
    fireEvent.click(within(toolbar()).getByRole("button", { name: "文件" }));
    fireEvent.click(await screen.findByRole("button", { name: "打开工程文件…" }));
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
    fireEvent.click(within(toolbar()).getByRole("button", { name: "文件" }));
    fireEvent.click(await screen.findByRole("button", { name: "打开工程文件…" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("工程文件已损坏或不是节目编辑器的工程"));
    expect(origin()).toEqual({ kind: "none" });
  });
});

describe("从节目库打开", () => {
  it("只列出可编辑的节目，未导出的带标记；选中后载入", async () => {
    installBackend();
    renderEditor();
    fireEvent.click(within(toolbar()).getByRole("button", { name: "文件" }));
    fireEvent.click(await screen.findByRole("button", { name: "从节目库打开…" }));
    const dialog = await screen.findByRole("dialog", { name: "从节目库打开" });
    expect(await within(dialog).findByText("开场")).toBeTruthy();
    expect(within(dialog).queryByText("录制来的")).toBeNull();
    expect(within(dialog).getByText("未导出")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: /开场/ }));
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

describe("未保存修改的确认", () => {
  it("新建：取消保持原样，不保存则丢弃修改", async () => {
    installBackend();
    renderEditor();
    makeDirty();
    fireEvent.click(within(toolbar()).getByRole("button", { name: "文件" }));
    fireEvent.click(await screen.findByRole("button", { name: "新建节目" }));
    let dialog = await screen.findByRole("dialog", { name: "有未保存的修改" });
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(project().fixtures).toHaveLength(1);

    fireEvent.click(within(toolbar()).getByRole("button", { name: "文件" }));
    fireEvent.click(await screen.findByRole("button", { name: "新建节目" }));
    dialog = await screen.findByRole("dialog", { name: "有未保存的修改" });
    fireEvent.click(within(dialog).getByRole("button", { name: "不保存" }));
    await waitFor(() => expect(project().fixtures).toHaveLength(0));
    expect(dirty()).toBe(false);
  });

  it("选择保存：库内节目先保存再继续；没保存过的先起名，保存成功后继续", async () => {
    installBackend();
    renderEditor();
    makeDirty();
    fireEvent.click(within(toolbar()).getByRole("button", { name: "文件" }));
    fireEvent.click(await screen.findByRole("button", { name: "新建节目" }));
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
