import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
const created = vi.hoisted(() => [] as string[]);
vi.mock("../invoke", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    constructor(path: string) {
      created.push(path);
    }
    get = vi.fn(async () => undefined);
    set = vi.fn(async () => undefined);
    delete = vi.fn(async () => undefined);
  },
}));

import { dataFilePath, getDataDir, resetDataDirCache } from "../dataDir";
import { createTauriPersistStorage } from "../tauriStorage";

beforeEach(() => {
  invoke.mockReset();
  created.length = 0;
  resetDataDirCache();
});

describe("数据目录", () => {
  it("Windows 路径用反斜杠拼接，去掉末尾分隔符", async () => {
    invoke.mockResolvedValue({ path: "C:\\Apps\\ArtNet\\data\\", fallbackUsed: false });
    expect(await dataFilePath("ui-prefs.json")).toBe("C:\\Apps\\ArtNet\\data\\ui-prefs.json");
  });

  it("POSIX 路径用斜杠拼接", async () => {
    invoke.mockResolvedValue({ path: "/opt/app/data", fallbackUsed: true });
    expect(await dataFilePath("a.json")).toBe("/opt/app/data/a.json");
    expect((await getDataDir())?.fallbackUsed).toBe(true);
  });

  it("查询只发生一次（结果被缓存）", async () => {
    invoke.mockResolvedValue({ path: "D:\\data", fallbackUsed: false });
    await dataFilePath("a.json");
    await dataFilePath("b.json");
    await getDataDir();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("data_dir_info");
  });

  it("没有后端（查询失败）时退回相对文件名", async () => {
    invoke.mockRejectedValue(new Error("no tauri"));
    expect(await getDataDir()).toBeNull();
    expect(await dataFilePath("ui-prefs.json")).toBe("ui-prefs.json");
  });
});

describe("界面偏好存储", () => {
  it("用数据目录下的绝对路径打开存储文件，每个文件只打开一次", async () => {
    invoke.mockResolvedValue({ path: "D:\\app\\data", fallbackUsed: false });
    const storage = createTauriPersistStorage<{ a: number }>("signal-checker.json");
    await storage.getItem("k");
    await storage.setItem("k", { state: { a: 1 }, version: 0 });
    await storage.removeItem("k");
    expect(created).toEqual(["D:\\app\\data\\signal-checker.json"]);
  });

  it("取不到数据目录时仍可使用（相对路径）", async () => {
    invoke.mockRejectedValue(new Error("no tauri"));
    const storage = createTauriPersistStorage<{ a: number }>("ui-prefs.json");
    await storage.setItem("k", { state: { a: 1 }, version: 0 });
    expect(created).toEqual(["ui-prefs.json"]);
  });
});
