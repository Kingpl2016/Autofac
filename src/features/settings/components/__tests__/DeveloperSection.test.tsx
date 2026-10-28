// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@/shared/tauri/invoke", () => ({ invoke }));

import i18n from "@/shared/i18n";
import { usePrefsStore } from "@/shared/stores/prefsStore";
import { DeveloperSection } from "../DeveloperSection";

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  invoke.mockReset();
  usePrefsStore.setState({ nativeContextMenu: false });
});
afterEach(() => cleanup());

describe("开发者分区", () => {
  it("读取状态；开关调用后端打开 / 关闭开发者工具；可临时保留浏览器右键菜单", async () => {
    invoke.mockImplementation(async (cmd: string, args?: { open?: boolean }) =>
      cmd === "devtools_state" ? { available: true, open: false } : { available: true, open: args?.open ?? false },
    );
    render(<DeveloperSection />);
    const devtools = screen.getByRole("switch", { name: "开发者工具" });
    await waitFor(() => expect(devtools.hasAttribute("disabled")).toBe(false));
    expect(devtools.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(devtools);
    await waitFor(() => expect(devtools.getAttribute("aria-checked")).toBe("true"));
    expect(invoke).toHaveBeenCalledWith("devtools_set", { open: true });

    fireEvent.click(screen.getByRole("switch", { name: "保留浏览器右键菜单" }));
    expect(usePrefsStore.getState().nativeContextMenu).toBe(true);
  });

  it("不支持时开关不可用；出错时提示", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "devtools_state") return { available: false, open: false };
      throw "unsupported";
    });
    render(<DeveloperSection />);
    const devtools = screen.getByRole("switch", { name: "开发者工具" });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("devtools_state"));
    expect(devtools.hasAttribute("disabled")).toBe(true);
    invoke.mockRejectedValueOnce("boom");
    fireEvent.focus(window);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("无法切换开发者工具"));
  });
});
