// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

vi.mock("@/shared/tauri/tauriStorage", () => ({
  createTauriPersistStorage: () => ({
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  }),
}));

import i18n from "@/shared/i18n";
import { usePrefsStore } from "@/shared/stores/prefsStore";
import { useAppearanceSync } from "../useAppearanceSync";

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  usePrefsStore.setState({ theme: "dark", accent: "blue", language: "zh" });
  document.documentElement.className = "";
  delete document.documentElement.dataset.accent;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useAppearanceSync", () => {
  it("把主题 / 强调色 / 语言应用到 <html> 与 i18n，并随偏好变化更新", async () => {
    renderHook(() => useAppearanceSync());
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.dataset.accent).toBe("blue");
    expect(document.documentElement.lang).toBe("zh-CN");

    await act(async () => {
      usePrefsStore.setState({ theme: "light", accent: "rose", language: "en" });
    });
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.dataset.accent).toBe("rose");
    expect(document.documentElement.lang).toBe("en");
    expect(i18n.language).toBe("en");
  });

  it("默认不在窗口获得焦点时重读偏好", () => {
    const rehydrate = vi.spyOn(usePrefsStore.persist, "rehydrate").mockResolvedValue(undefined);
    renderHook(() => useAppearanceSync());
    window.dispatchEvent(new Event("focus"));
    expect(rehydrate).not.toHaveBeenCalled();
  });

  it("rehydrateOnFocus：获得焦点时重读，卸载后不再重读", () => {
    const rehydrate = vi.spyOn(usePrefsStore.persist, "rehydrate").mockResolvedValue(undefined);
    const { unmount } = renderHook(() => useAppearanceSync({ rehydrateOnFocus: true }));
    window.dispatchEvent(new Event("focus"));
    expect(rehydrate).toHaveBeenCalledTimes(1);
    unmount();
    window.dispatchEvent(new Event("focus"));
    expect(rehydrate).toHaveBeenCalledTimes(1);
  });
});
