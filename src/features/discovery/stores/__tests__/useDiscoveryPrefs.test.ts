// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => {
  const data = new Map<string, unknown>();
  return {
    data,
    get: vi.fn(async (k: string) => data.get(k)),
    set: vi.fn(async (k: string, v: unknown) => void data.set(k, v)),
    delete: vi.fn(async (k: string) => data.delete(k)),
  };
});
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    get = store.get;
    set = store.set;
    delete = store.delete;
  },
}));

import { DEFAULT_PREFS, sanitizePrefs, useDiscoveryPrefs } from "../useDiscoveryPrefs";

beforeEach(async () => {
  useDiscoveryPrefs.setState({ ...DEFAULT_PREFS });
  // 等重置触发的异步写盘落定后再清空，避免污染各用例的调用计数
  await new Promise((r) => setTimeout(r, 0));
  store.data.clear();
  vi.clearAllMocks();
});

afterEach(() => vi.restoreAllMocks());

describe("sanitizePrefs", () => {
  it("非法或缺失字段回落默认值", () => {
    expect(sanitizePrefs(undefined)).toEqual(DEFAULT_PREFS);
    expect(
      sanitizePrefs({ category: "nope", status: 3, sort: { key: "x", dir: "up" } }),
    ).toEqual(DEFAULT_PREFS);
  });

  it("保留合法字段", () => {
    expect(
      sanitizePrefs({
        category: "sacn",
        status: "online",
        sort: { key: "ip", dir: "desc" },
      }),
    ).toEqual({ category: "sacn", status: "online", sort: { key: "ip", dir: "desc" } });
  });
});

describe("useDiscoveryPrefs 持久化", () => {
  it("Tauri 环境写入 Store 插件，只保存偏好字段", async () => {
    useDiscoveryPrefs.getState().setCategory("artNet");
    useDiscoveryPrefs.getState().setSort({ key: "ip", dir: "desc" });
    await vi.waitFor(() => expect(store.set).toHaveBeenCalled());

    const saved = store.data.get("discovery") as {
      state: Record<string, unknown>;
      version: number;
    };
    expect(saved.version).toBe(1);
    expect(saved.state).toEqual({
      category: "artNet",
      status: "all",
      sort: { key: "ip", dir: "desc" },
    });
  });

  it("重新水合时读回已保存的偏好，并清洗非法值", async () => {
    store.data.set("discovery", {
      state: { category: "cluster", status: "bogus", sort: { key: "name", dir: "asc" } },
      version: 1,
    });
    await useDiscoveryPrefs.persist.rehydrate();

    const s = useDiscoveryPrefs.getState();
    expect(s.category).toBe("cluster");
    expect(s.status).toBe("all");
    expect(s.sort).toEqual({ key: "name", dir: "asc" });
  });

  it("存储读取失败时不抛错，保持当前值", async () => {
    store.get.mockRejectedValueOnce(new Error("boom"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    useDiscoveryPrefs.setState({ category: "sacn" });
    await useDiscoveryPrefs.persist.rehydrate();
    expect(useDiscoveryPrefs.getState().category).toBe("sacn");
  });

  it("clearFilters 只清分类与状态，保留排序", () => {
    useDiscoveryPrefs.setState({
      category: "sacn",
      status: "online",
      sort: { key: "ip", dir: "desc" },
    });
    useDiscoveryPrefs.getState().clearFilters();
    const s = useDiscoveryPrefs.getState();
    expect([s.category, s.status]).toEqual(["all", "all"]);
    expect(s.sort).toEqual({ key: "ip", dir: "desc" });
  });
});
