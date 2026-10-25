// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/shared/tauri/tauriStorage", () => ({
  createTauriPersistStorage: () => ({
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  }),
}));

import i18n from "@/shared/i18n";
import { usePrefsStore, DEFAULT_RECORD_HOTKEYS } from "@/shared/stores/prefsStore";
import { ShortcutsSection } from "../ShortcutsSection";

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  usePrefsStore.setState({ recordHotkeys: { ...DEFAULT_RECORD_HOTKEYS } });
});

afterEach(() => cleanup());

describe("ShortcutsSection", () => {
  it("展示当前录制热键", () => {
    render(<ShortcutsSection />);
    expect(screen.getByText(DEFAULT_RECORD_HOTKEYS.start)).toBeTruthy();
    expect(screen.getByText(DEFAULT_RECORD_HOTKEYS.stop)).toBeTruthy();
  });

  it("捕获新组合键写回 prefs", () => {
    render(<ShortcutsSection />);
    fireEvent.click(screen.getByText(DEFAULT_RECORD_HOTKEYS.start));
    fireEvent.keyDown(screen.getByText("按下组合键…"), {
      key: "p",
      ctrlKey: true,
      altKey: true,
    });
    expect(usePrefsStore.getState().recordHotkeys.start).toBe("CommandOrControl+Alt+P");
  });

  it("恢复默认重置两个热键", () => {
    usePrefsStore.setState({ recordHotkeys: { start: "F9", stop: "F10" } });
    render(<ShortcutsSection />);
    fireEvent.click(screen.getByRole("button", { name: "恢复默认" }));
    expect(usePrefsStore.getState().recordHotkeys).toEqual(DEFAULT_RECORD_HOTKEYS);
  });
});
