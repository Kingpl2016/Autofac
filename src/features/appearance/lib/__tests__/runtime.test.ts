// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
}));

vi.mock("@/shared/tauri/tauriStorage", () => ({
  createTauriPersistStorage: () => ({
    getItem: async (name: string) => storage.data.get(name) ?? null,
    setItem: async (name: string, value: unknown) => void storage.data.set(name, value),
    removeItem: async (name: string) => void storage.data.delete(name),
  }),
}));

import { getDefaultSettings } from "../appearanceSettings";
import { loadAppearance, startAppearanceSync } from "../runtime";
import { APPEARANCE_SNAPSHOT_KEY } from "../snapshot";
import { readSystemMode, systemMode$ } from "../systemTheme";
import { useAppearanceStore } from "../../stores/useAppearanceStore";

/** 可手动触发变化的 matchMedia 替身。 */
function installMatchMedia(initialDark: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const state = { dark: initialDark };
  const query = {
    get matches() {
      return state.dark;
    },
    addEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => listeners.delete(fn),
  };
  vi.stubGlobal("matchMedia", () => query);
  window.matchMedia = (() => query) as unknown as typeof window.matchMedia;
  return {
    setDark(dark: boolean) {
      state.dark = dark;
      for (const fn of listeners) fn({ matches: dark } as MediaQueryListEvent);
    },
    listenerCount: () => listeners.size,
  };
}

const root = document.documentElement;

beforeEach(async () => {
  useAppearanceStore.getState().replaceSettings(getDefaultSettings());
  // 重置设置会触发一次异步落盘；等它写完再清空，保证每个用例从“磁盘上什么都没有”开始
  await new Promise((resolve) => setTimeout(resolve, 0));
  storage.data.clear();
  localStorage.clear();
  root.className = "";
  root.removeAttribute("style");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("systemMode$", () => {
  it("订阅时先发出当前系统偏好，系统切换时发出新值，退订即移除监听", () => {
    const media = installMatchMedia(false);
    const seen: string[] = [];
    const sub = systemMode$.subscribe((m) => seen.push(m));
    expect(seen).toEqual(["light"]);
    expect(media.listenerCount()).toBe(1);

    media.setDark(true);
    expect(seen).toEqual(["light", "dark"]);

    sub.unsubscribe();
    expect(media.listenerCount()).toBe(0);
    expect(readSystemMode()).toBe("dark");
  });
});

describe("startAppearanceSync", () => {
  it("把明暗与变量同步到 <html>，并写入防闪烁快照", () => {
    installMatchMedia(false);
    const sub = startAppearanceSync(root);

    expect(root.classList.contains("dark")).toBe(true);

    useAppearanceStore.getState().update({ mode: "light", accent: { id: "rose", color: "#e11d48" }, radius: 1 });
    expect(root.classList.contains("dark")).toBe(false);
    expect(root.style.colorScheme).toBe("light");
    expect(root.style.getPropertyValue("--radius")).toBe("1rem");
    expect(root.style.getPropertyValue("--accent-h")).not.toBe("");

    const snapshot = JSON.parse(localStorage.getItem(APPEARANCE_SNAPSHOT_KEY) ?? "null");
    expect(snapshot.mode).toBe("light");
    expect(snapshot.vars.light["--radius"]).toBe("1rem");

    // 恢复默认后不残留旧变量
    useAppearanceStore.getState().reset();
    expect(root.style.getPropertyValue("--radius")).toBe("");
    expect(root.style.getPropertyValue("--accent-h")).toBe("");
    sub.unsubscribe();
  });

  it("跟随系统：系统明暗变化时立即重新应用", () => {
    const media = installMatchMedia(true);
    useAppearanceStore.getState().setMode("system");
    const sub = startAppearanceSync(root);
    expect(root.classList.contains("dark")).toBe(true);

    media.setDark(false);
    expect(root.classList.contains("dark")).toBe(false);
    expect(root.style.colorScheme).toBe("light");

    media.setDark(true);
    expect(root.classList.contains("dark")).toBe(true);
    sub.unsubscribe();
  });

  it("选择固定模式时忽略系统变化", () => {
    const media = installMatchMedia(true);
    useAppearanceStore.getState().setMode("light");
    const sub = startAppearanceSync(root);
    media.setDark(true);
    expect(root.classList.contains("dark")).toBe(false);
    sub.unsubscribe();
  });
});

describe("loadAppearance", () => {
  it("读回已保存的设置，且不触发旧偏好迁移", async () => {
    storage.data.set("appearance", { state: { ...getDefaultSettings(), mode: "system", radius: 0.75 }, version: 1 });
    storage.data.set("prefs", { state: { theme: "light", accent: "rose" }, version: 1 });

    await loadAppearance();

    const state = useAppearanceStore.getState();
    expect(state.mode).toBe("system");
    expect(state.radius).toBe(0.75);
    expect(state.accent).toBeNull();
  });

  it("首次运行：一次性迁移旧偏好里的主题与强调色，并落盘", async () => {
    storage.data.set("prefs", { state: { theme: "light", accent: "rose" }, version: 1 });

    await loadAppearance();

    const state = useAppearanceStore.getState();
    expect(state.mode).toBe("light");
    expect(state.accent?.id).toBe("rose");
    await vi.waitFor(() => expect(storage.data.has("appearance")).toBe(true));
  });

  it("磁盘上的数据被改坏时回到安全的默认值", async () => {
    storage.data.set("appearance", { state: { mode: "neon", radius: 999, density: 3 }, version: 1 });
    await loadAppearance();
    const state = useAppearanceStore.getState();
    expect(state.mode).toBe("dark");
    expect(state.radius).toBeNull();
    expect(state.density).toBe("default");
  });
});
