// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import "@/shared/i18n";
import i18n from "@/shared/i18n";
import { usePrefsStore } from "@/shared/stores/prefsStore";
import { PersonalizationPanel } from "./PersonalizationPanel";

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  usePrefsStore.setState({ accent: "blue", language: "zh" });
});

afterEach(() => cleanup());

describe("PersonalizationPanel", () => {
  it("点击头部按钮后弹出面板，默认不显示", () => {
    render(<PersonalizationPanel />);
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "个性化" }));

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getAllByRole("radio")).toHaveLength(6);
  });

  it("选择强调色会更新 store 与选中状态", () => {
    render(<PersonalizationPanel />);
    fireEvent.click(screen.getByRole("button", { name: "个性化" }));

    fireEvent.click(screen.getByRole("radio", { name: "玫红" }));

    expect(usePrefsStore.getState().accent).toBe("rose");
    expect(
      screen.getByRole("radio", { name: "玫红" }).getAttribute("aria-checked"),
    ).toBe("true");
  });
});
