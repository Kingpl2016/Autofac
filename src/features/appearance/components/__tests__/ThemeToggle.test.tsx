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
import { getDefaultSettings } from "../../lib/appearanceSettings";
import { useAppearanceStore } from "../../stores/useAppearanceStore";
import { ThemeToggle } from "../ThemeToggle";

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  useAppearanceStore.getState().replaceSettings(getDefaultSettings());
});

afterEach(() => cleanup());

describe("ThemeToggle", () => {
  it("菜单提供 浅色 / 深色 / 跟随系统，当前模式被选中", () => {
    render(<ThemeToggle />);
    fireEvent.keyDown(screen.getByRole("button", { name: "切换主题" }), { key: "Enter" });

    expect(screen.getAllByRole("menuitemradio").map((el) => el.textContent)).toEqual(["浅色", "深色", "跟随系统"]);
    expect(screen.getByRole("menuitemradio", { name: "深色" }).getAttribute("aria-checked")).toBe("true");
  });

  it("选择“跟随系统”会更新模式", () => {
    render(<ThemeToggle />);
    fireEvent.keyDown(screen.getByRole("button", { name: "切换主题" }), { key: "Enter" });

    fireEvent.click(screen.getByRole("menuitemradio", { name: "跟随系统" }));

    expect(useAppearanceStore.getState().mode).toBe("system");
  });
});
