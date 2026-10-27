// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 偏好存储不落盘：测试里用内存即可
vi.mock("@/shared/tauri/tauriStorage", () => ({
  createTauriPersistStorage: () => ({
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  }),
}));

import {
  applyLanguageAttr,
  detectSystemLanguage,
  usePrefsStore,
} from "../prefsStore";

const initial = usePrefsStore.getState();

beforeEach(() => {
  usePrefsStore.setState({
    ...initial,
    sidebarCollapsed: false,
    language: "zh",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("detectSystemLanguage", () => {
  it("系统语言为中文时返回 zh", () => {
    vi.spyOn(navigator, "language", "get").mockReturnValue("zh-CN");
    expect(detectSystemLanguage()).toBe("zh");
  });

  it("其它语言返回 en", () => {
    vi.spyOn(navigator, "language", "get").mockReturnValue("en-US");
    expect(detectSystemLanguage()).toBe("en");
  });
});

describe("prefsStore", () => {
  it("toggleSidebar 切换折叠状态", () => {
    usePrefsStore.getState().toggleSidebar();
    expect(usePrefsStore.getState().sidebarCollapsed).toBe(true);
    usePrefsStore.getState().toggleSidebar();
    expect(usePrefsStore.getState().sidebarCollapsed).toBe(false);
  });

  it("setLanguage 更新状态", () => {
    usePrefsStore.getState().setLanguage("en");
    expect(usePrefsStore.getState().language).toBe("en");
  });
});

describe("DOM 应用函数", () => {
  it("applyLanguageAttr 写入 lang", () => {
    applyLanguageAttr("en");
    expect(document.documentElement.lang).toBe("en");
    applyLanguageAttr("zh");
    expect(document.documentElement.lang).toBe("zh-CN");
  });
});
