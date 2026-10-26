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

import {
  DEFAULT_DASHBOARD_PREFS,
  sanitizeDashboardPrefs,
  useDashboardPrefs,
} from "../useDashboardPrefs";

beforeEach(async () => {
  useDashboardPrefs.setState({ ...DEFAULT_DASHBOARD_PREFS });
  await new Promise((r) => setTimeout(r, 0));
  store.data.clear();
  vi.clearAllMocks();
});

afterEach(() => vi.restoreAllMocks());

describe("sanitizeDashboardPrefs", () => {
  it("非法或缺失字段回落默认值", () => {
    expect(sanitizeDashboardPrefs(undefined)).toEqual(DEFAULT_DASHBOARD_PREFS);
    expect(sanitizeDashboardPrefs({ universeView: "grid" })).toEqual(DEFAULT_DASHBOARD_PREFS);
  });

  it("保留合法值", () => {
    expect(sanitizeDashboardPrefs({ universeView: "table" })).toEqual({ universeView: "table" });
  });
});

describe("useDashboardPrefs 持久化", () => {
  it("切换视图会写入 Store 插件", async () => {
    useDashboardPrefs.getState().setUniverseView("table");
    await vi.waitFor(() => expect(store.set).toHaveBeenCalled());
    const saved = store.data.get("dashboard") as { state: unknown; version: number };
    expect(saved.version).toBe(1);
    expect(saved.state).toEqual({ universeView: "table" });
  });

  it("重新水合时读回已保存的视图，并清洗非法值", async () => {
    store.data.set("dashboard", { state: { universeView: "table" }, version: 1 });
    await useDashboardPrefs.persist.rehydrate();
    expect(useDashboardPrefs.getState().universeView).toBe("table");

    store.data.set("dashboard", { state: { universeView: 42 }, version: 1 });
    await useDashboardPrefs.persist.rehydrate();
    expect(useDashboardPrefs.getState().universeView).toBe("cards");
  });
});