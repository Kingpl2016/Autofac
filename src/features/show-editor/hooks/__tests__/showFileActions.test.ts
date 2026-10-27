import { produce } from "immer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  showProjectSave: vi.fn(),
  showProjectOpen: vi.fn(),
  showExternalSave: vi.fn(),
  showExternalRead: vi.fn(),
  showAutosaveClear: vi.fn(),
}));
vi.mock("../../lib/showFile", async (orig) => ({ ...(await orig<typeof import("../../lib/showFile")>()), ...api }));

import { addFixtures } from "../../lib/ops";
import { createEmptyProject, type ShowProject } from "../../lib/project";
import { RGBW } from "../../lib/__tests__/testkit";
import { useDocumentStore } from "../../stores/useDocumentStore";
import { useEditorUiStore } from "../../stores/useEditorUiStore";
import { selectDirty, useProjectStore } from "../../stores/useProjectStore";
import {
  newProject,
  openFromFile,
  openFromLibrary,
  restoreFromAutosave,
  saveInPlace,
  saveToFile,
  saveToLibrary,
} from "../showFileActions";

const project = () => useProjectStore.getState().project;
const origin = () => useDocumentStore.getState().origin;
const dirty = () => selectDirty(useProjectStore.getState());

function sample(): ShowProject {
  return produce(createEmptyProject("演出"), (d) => {
    addFixtures(d, RGBW, 2);
  });
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.showAutosaveClear.mockResolvedValue(undefined);
  useProjectStore.getState().load(createEmptyProject(""));
  useDocumentStore.getState().setOrigin({ kind: "none" });
});

describe("保存到节目库", () => {
  it("首次保存：名称与备注写入工程，文件名主干取名称，成功后记为库内节目并清除脏标记与自动存档", async () => {
    api.showProjectSave.mockResolvedValue("D:/rec/开场.artrec");
    useProjectStore.getState().update((d) => void addFixtures(d, RGBW, 1));
    expect(dirty()).toBe(true);

    const path = await saveToLibrary({ name: "  开场 ", notes: "第一场" });

    expect(path).toBe("D:/rec/开场.artrec");
    const args = api.showProjectSave.mock.calls[0][0] as { path?: string; name: string; notes: string; fileStem: string; json: string };
    expect(args).toMatchObject({ path: undefined, name: "开场", notes: "第一场", fileStem: "开场" });
    expect(JSON.parse(args.json)).toMatchObject({ name: "开场", notes: "第一场" });
    expect(project()).toMatchObject({ name: "开场", notes: "第一场" });
    expect(origin()).toEqual({ kind: "library", path: "D:/rec/开场.artrec" });
    expect(dirty()).toBe(false);
    expect(api.showAutosaveClear).toHaveBeenCalled();
  });

  it("已在库里的节目再次保存是覆盖（带原路径）；asNew 则另存为新节目", async () => {
    api.showProjectSave.mockResolvedValueOnce("D:/rec/a.artrec").mockResolvedValueOnce("D:/rec/a.artrec").mockResolvedValueOnce("D:/rec/b.artrec");
    await saveToLibrary({ name: "a", notes: "" });
    await saveToLibrary({ name: "a", notes: "" });
    expect((api.showProjectSave.mock.calls[1][0] as { path?: string }).path).toBe("D:/rec/a.artrec");
    await saveToLibrary({ name: "b", notes: "", asNew: true });
    expect((api.showProjectSave.mock.calls[2][0] as { path?: string }).path).toBeUndefined();
    expect(origin()).toEqual({ kind: "library", path: "D:/rec/b.artrec" });
  });

  it("保存期间继续编辑：基线是写入磁盘时的快照，之后的编辑仍然是未保存", async () => {
    let finish: (path: string) => void = () => undefined;
    api.showProjectSave.mockReturnValue(new Promise<string>((resolve) => (finish = resolve)));
    const saving = saveToLibrary({ name: "a", notes: "" });
    useProjectStore.getState().update((d) => void addFixtures(d, RGBW, 1));
    finish("D:/rec/a.artrec");
    await saving;
    expect(dirty()).toBe(true);
  });

  it("保存失败：抛出错误码，来源与脏标记保持不变", async () => {
    api.showProjectSave.mockRejectedValue("project_too_large");
    useProjectStore.getState().update((d) => void addFixtures(d, RGBW, 1));
    await expect(saveToLibrary({ name: "a", notes: "" })).rejects.toBe("project_too_large");
    expect(origin()).toEqual({ kind: "none" });
    expect(dirty()).toBe(true);
    expect(api.showAutosaveClear).not.toHaveBeenCalled();
  });

  it("清除自动存档失败不影响保存结果", async () => {
    api.showProjectSave.mockResolvedValue("D:/rec/a.artrec");
    api.showAutosaveClear.mockRejectedValue("io");
    await expect(saveToLibrary({ name: "a", notes: "" })).resolves.toBe("D:/rec/a.artrec");
    expect(dirty()).toBe(false);
  });
});

describe("saveInPlace（Ctrl+S）", () => {
  it("没保存过：要求先起名，不调用后端", async () => {
    expect(await saveInPlace()).toBe("needs-name");
    expect(api.showProjectSave).not.toHaveBeenCalled();
    expect(api.showExternalSave).not.toHaveBeenCalled();
  });

  it("库内节目：覆盖保存，沿用工程里的名称与备注", async () => {
    api.showProjectSave.mockResolvedValue("D:/rec/a.artrec");
    useProjectStore.getState().load({ ...createEmptyProject("旧名"), notes: "n" });
    useDocumentStore.getState().setOrigin({ kind: "library", path: "D:/rec/a.artrec" });
    useProjectStore.getState().update((d) => void addFixtures(d, RGBW, 1));
    expect(await saveInPlace()).toBe("saved");
    expect(api.showProjectSave.mock.calls[0][0]).toMatchObject({ path: "D:/rec/a.artrec", name: "旧名", notes: "n" });
    expect(dirty()).toBe(false);
  });

  it("库外文件：回写原路径，不碰节目库", async () => {
    api.showExternalSave.mockResolvedValue(undefined);
    useDocumentStore.getState().setOrigin({ kind: "external", path: "D:/备份/a.artshow" });
    useProjectStore.getState().update((d) => void addFixtures(d, RGBW, 1));
    expect(await saveInPlace()).toBe("saved");
    expect(api.showExternalSave).toHaveBeenCalledWith("D:/备份/a.artshow", expect.any(String));
    expect(api.showProjectSave).not.toHaveBeenCalled();
    expect(dirty()).toBe(false);
  });
});

describe("保存到库外文件", () => {
  it("另存为：来源变成该文件", async () => {
    api.showExternalSave.mockResolvedValue(undefined);
    await saveToFile("D:/桌面/副本.artshow");
    expect(origin()).toEqual({ kind: "external", path: "D:/桌面/副本.artshow" });
    expect(JSON.parse(api.showExternalSave.mock.calls[0][1] as string).version).toBe(1);
  });

  it("失败时抛出错误码", async () => {
    api.showExternalSave.mockRejectedValue("bad_path");
    await expect(saveToFile("x.txt")).rejects.toBe("bad_path");
    expect(origin()).toEqual({ kind: "none" });
  });
});

describe("打开", () => {
  it("打开库内工程：载入、清空撤销历史与选择、来源为库内节目、不算未保存", async () => {
    api.showProjectOpen.mockResolvedValue(JSON.stringify(sample()));
    useProjectStore.getState().update((d) => void addFixtures(d, RGBW, 1));
    useEditorUiStore.setState({ selectedCueIds: ["x"], playheadMs: 5000, clipboard: [] });

    await openFromLibrary("D:/rec/a.artrec");

    expect(project().name).toBe("演出");
    expect(project().fixtures).toHaveLength(2);
    expect(origin()).toEqual({ kind: "library", path: "D:/rec/a.artrec" });
    expect(dirty()).toBe(false);
    expect(useProjectStore.temporal.getState().pastStates).toHaveLength(0);
    expect(useEditorUiStore.getState()).toMatchObject({ selectedCueIds: [], playheadMs: 0 });
  });

  it("打开库外文件", async () => {
    api.showExternalRead.mockResolvedValue(JSON.stringify(sample()));
    await openFromFile("D:/备份/a.artshow");
    expect(origin()).toEqual({ kind: "external", path: "D:/备份/a.artshow" });
    expect(project().fixtures).toHaveLength(2);
  });

  it("文件内容损坏或引用不完整：报 invalid_project，当前工程不受影响", async () => {
    useProjectStore.getState().update((d) => void addFixtures(d, RGBW, 1));
    const before = project();
    api.showProjectOpen.mockResolvedValue("{不是json");
    await expect(openFromLibrary("D:/rec/a.artrec")).rejects.toBe("invalid_project");
    const broken = produce(sample(), (d) => {
      d.fixtureModels = [];
    });
    api.showExternalRead.mockResolvedValue(JSON.stringify(broken));
    await expect(openFromFile("D:/x.artshow")).rejects.toBe("invalid_project");
    expect(project()).toBe(before);
  });

  it("后端错误原样抛出", async () => {
    api.showProjectOpen.mockRejectedValue("not_found");
    await expect(openFromLibrary("D:/rec/ghost.artrec")).rejects.toBe("not_found");
  });
});

describe("新建与恢复", () => {
  it("新建：空工程、来源为未保存、历史清空", () => {
    useProjectStore.getState().update((d) => void addFixtures(d, RGBW, 1));
    useDocumentStore.getState().setOrigin({ kind: "library", path: "x" });
    newProject();
    expect(project().fixtures).toEqual([]);
    expect(origin()).toEqual({ kind: "none" });
    expect(dirty()).toBe(false);
  });

  it("从自动存档恢复：载入内容但仍是未保存状态，来源未知", () => {
    restoreFromAutosave(JSON.stringify(sample()));
    expect(project().fixtures).toHaveLength(2);
    expect(dirty()).toBe(true);
    expect(origin()).toEqual({ kind: "none" });
    expect(useProjectStore.temporal.getState().pastStates).toHaveLength(0);
    expect(() => restoreFromAutosave("坏的")).toThrow();
  });
});
