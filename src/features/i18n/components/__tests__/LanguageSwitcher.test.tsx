// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/shared/tauri/tauriStorage", () => ({
  createTauriPersistStorage: () => ({
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  }),
}));

import i18n from "@/shared/i18n";
import { usePrefsStore } from "@/shared/stores/prefsStore";
import { startLanguageSync } from "../../lib/runtime";
import { LanguageSwitcher } from "../LanguageSwitcher";

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  usePrefsStore.setState({ language: "zh" });
});

afterEach(() => cleanup());

describe("LanguageSwitcher", () => {
  it("菜单列出两种语言（各用自己的名字），当前语言被选中；选择后更新偏好", () => {
    render(<LanguageSwitcher />);
    fireEvent.keyDown(screen.getByRole("button", { name: "切换语言" }), { key: "Enter" });

    const zh = screen.getByRole("menuitemradio", { name: "简体中文" });
    const en = screen.getByRole("menuitemradio", { name: "English" });
    expect(zh.getAttribute("aria-checked")).toBe("true");
    expect(en.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(en);
    expect(usePrefsStore.getState().language).toBe("en");
  });
});

describe("startLanguageSync", () => {
  it("语言变化时同步 <html lang> 与 i18n，退订后不再同步", async () => {
    const sub = startLanguageSync();
    expect(document.documentElement.lang).toBe("zh-CN");

    await act(async () => {
      usePrefsStore.setState({ language: "en" });
    });
    expect(document.documentElement.lang).toBe("en");
    expect(i18n.language).toBe("en");

    sub.unsubscribe();
    await act(async () => {
      usePrefsStore.setState({ language: "zh" });
    });
    expect(i18n.language).toBe("en");
  });
});
