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
  DEFAULT_SIGNAL_FLOW_PREFS,
  clampThreshold,
  sanitizeSignalFlowPrefs,
  useSignalFlowPrefs,
} from "../useSignalFlowPrefs";

beforeEach(async () => {
  useSignalFlowPrefs.setState({ ...DEFAULT_SIGNAL_FLOW_PREFS });
  await new Promise((r) => setTimeout(r, 0));
  store.data.clear();
  vi.clearAllMocks();
});
afterEach(() => vi.restoreAllMocks());

describe("clampThreshold", () => {
  it("取整并限制在 1 到 9999", () => {
    expect(clampThreshold(0)).toBe(1);
    expect(clampThreshold(-5)).toBe(1);
    expect(clampThreshold(12.6)).toBe(13);
    expect(clampThreshold(100000)).toBe(9999);
  });

  it("非数值回落默认值 50", () => {
    expect(clampThreshold(Number.NaN)).toBe(50);
    expect(clampThreshold("30")).toBe(50);
    expect(clampThreshold(undefined)).toBe(50);
  });
});

describe("sanitizeSignalFlowPrefs", () => {
  it("非法字段回落默认值", () => {
    expect(sanitizeSignalFlowPrefs(undefined)).toEqual(DEFAULT_SIGNAL_FLOW_PREFS);
    expect(sanitizeSignalFlowPrefs({ simplifyThreshold: "x", view: "cards" })).toEqual(
      DEFAULT_SIGNAL_FLOW_PREFS,
    );
  });

  it("保留合法值", () => {
    expect(sanitizeSignalFlowPrefs({ simplifyThreshold: 80, view: "list" })).toEqual({
      simplifyThreshold: 80,
      view: "list",
    });
  });
});

describe("useSignalFlowPrefs", () => {
  it("setSimplifyThreshold 会规整输入", () => {
    useSignalFlowPrefs.getState().setSimplifyThreshold(0);
    expect(useSignalFlowPrefs.getState().simplifyThreshold).toBe(1);
    useSignalFlowPrefs.getState().setSimplifyThreshold(75);
    expect(useSignalFlowPrefs.getState().simplifyThreshold).toBe(75);
  });

  it("修改会落盘（阈值与视图）", async () => {
    useSignalFlowPrefs.getState().setSimplifyThreshold(120);
    useSignalFlowPrefs.getState().setView("list");
    await vi.waitFor(() => expect(store.set).toHaveBeenCalled());
    const saved = store.data.get("signalFlow") as { state: unknown; version: number };
    expect(saved.version).toBe(1);
    expect(saved.state).toEqual({ simplifyThreshold: 120, view: "list" });
  });

  it("重新水合时读回已保存的值并清洗非法值", async () => {
    store.data.set("signalFlow", { state: { simplifyThreshold: 7, view: "list" }, version: 1 });
    await useSignalFlowPrefs.persist.rehydrate();
    expect(useSignalFlowPrefs.getState()).toMatchObject({ simplifyThreshold: 7, view: "list" });

    store.data.set("signalFlow", { state: { simplifyThreshold: -3, view: 1 }, version: 1 });
    await useSignalFlowPrefs.persist.rehydrate();
    expect(useSignalFlowPrefs.getState()).toMatchObject({ simplifyThreshold: 1, view: "graph" });
  });
});