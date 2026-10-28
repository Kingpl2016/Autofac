// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

import i18n from "@/shared/i18n";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@/shared/tauri/invoke", () => ({ invoke }));
const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import type { Command } from "../../lib/commands";
import { useEditorUiStore } from "../../stores/useEditorUiStore";
import { useKeymapStore } from "../../stores/useKeymapStore";
import { HelpMenu } from "../HelpMenu";
import { ShortcutSheetDialog } from "../ShortcutSheetDialog";

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

const writeText = vi.fn(async () => undefined);

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  invoke.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  writeText.mockClear();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  useEditorUiStore.setState({ helpOpen: false, shortcutSheetOpen: false, keymapOpen: false });
  await act(async () => {
    await useKeymapStore.setState({ overrides: {} });
  });
});

afterEach(() => cleanup());

function Location() {
  const loc = useLocation();
  return <span data-testid="location">{loc.pathname}</span>;
}

const renderMenu = () =>
  render(
    <MemoryRouter initialEntries={["/editor"]}>
      <HelpMenu />
      <Routes>
        <Route path="*" element={<Location />} />
      </Routes>
    </MemoryRouter>,
  );

const openMenu = () => act(() => useEditorUiStore.getState().setHelpOpen(true));

describe("帮助菜单的新增项", () => {
  it("快捷键速查打开速查表；新功能列出更新说明", async () => {
    renderMenu();
    openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "快捷键速查" }));
    expect(useEditorUiStore.getState().shortcutSheetOpen).toBe(true);

    openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "新功能" }));
    const dialog = await screen.findByRole("dialog", { name: "新功能" });
    expect(within(dialog).getByText("拖拽添加灯具")).toBeTruthy();
  });

  it("复制诊断信息：版本、环境与节目规模写进剪贴板；打开日志文件夹", async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "app_info"
        ? { name: "Art-Net Studio", version: "1.2.3", identifier: "x", tauriVersion: "2", os: "windows", arch: "x86_64", profile: "release" }
        : "D:/data/logs",
    );
    renderMenu();
    openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "复制诊断信息" }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const text = String((writeText.mock.calls[0] as unknown[])[0]);
    expect(text).toContain("Art-Net Studio 1.2.3");
    expect(text).toContain("台灯具");
    expect(toast.success).toHaveBeenCalled();

    openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "打开日志文件夹" }));
    await waitFor(() => expect(invoke.mock.calls.some((c) => c[0] === "logs_reveal")).toBe(true));
  });

  it("关于：跳到关于页", async () => {
    renderMenu();
    openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "关于 Art-Net Studio" }));
    expect(screen.getByTestId("location").textContent).toBe("/about");
  });
});

describe("快捷键速查表", () => {
  const commands: Command[] = [
    { id: "file.save", titleKey: "editor.commands.save", category: "file", keys: ["mod+s"], run: () => {} },
    { id: "transport.play", titleKey: "editor.commands.playPause", category: "transport", keys: ["space"], run: () => {} },
    { id: "edit.none", titleKey: "editor.commands.undo", category: "edit", run: () => {} },
  ];

  it("按分类列出有快捷键的命令，含自定义；可搜索；可转到自定义", async () => {
    await act(async () => {
      await useKeymapStore.setState({ overrides: { "transport.play": ["mod+p"] } });
    });
    useEditorUiStore.setState({ shortcutSheetOpen: true });
    render(<ShortcutSheetDialog commands={commands} />);
    const dialog = screen.getByRole("dialog", { name: "快捷键速查" });
    expect(within(dialog).getAllByRole("region").map((r) => r.getAttribute("aria-label"))).toHaveLength(2);
    expect(within(dialog).getByText("Ctrl+P")).toBeTruthy();
    expect(within(dialog).getByText("Ctrl+S")).toBeTruthy();

    fireEvent.change(within(dialog).getByRole("searchbox"), { target: { value: "zzzz" } });
    expect(within(dialog).queryByText("Ctrl+S")).toBeNull();

    fireEvent.click(within(dialog).getByRole("button", { name: "自定义快捷键…" }));
    expect(useEditorUiStore.getState().keymapOpen).toBe(true);
    expect(useEditorUiStore.getState().shortcutSheetOpen).toBe(false);
  });
});
