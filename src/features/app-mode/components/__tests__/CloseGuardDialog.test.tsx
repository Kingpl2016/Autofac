// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import i18n from "@/shared/i18n";

const toast = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() }));
const api = vi.hoisted(() => ({ appQuit: vi.fn() }));

vi.mock("sonner", () => ({ toast }));
vi.mock("../../lib/api", () => api);
vi.mock("@/shared/tauri/events", async () => (await import("@/test/mockTauriEvents")).tauriEventsModule);
import { tauriEvents } from "@/test/mockTauriEvents";

import { CloseGuardDialog } from "../CloseGuardDialog";

const requestClose = (payload: {
  recording: boolean;
  playing: boolean;
  showOutput?: boolean;
  showUnsaved?: boolean;
  baking?: boolean;
}) =>
  act(() => tauriEvents.emit("app:close-requested", payload));

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  vi.clearAllMocks();
  tauriEvents.reset();
  api.appQuit.mockResolvedValue(undefined);
});

afterEach(() => cleanup());

describe("CloseGuardDialog", () => {
  it("默认不显示；收到关闭请求后才弹出", async () => {
    render(<CloseGuardDialog />);
    await waitFor(() => expect(tauriEvents.has("app:close-requested")).toBe(true));
    expect(screen.queryByRole("dialog")).toBeNull();
    requestClose({ recording: true, playing: false });
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("只列出正在进行的工作，并写明后果；默认聚焦“继续使用”", async () => {
    render(<CloseGuardDialog />);
    await waitFor(() => expect(tauriEvents.has("app:close-requested")).toBe(true));
    requestClose({ recording: true, playing: true });
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("正在录制的节目会先停止并保存。");
    expect(dialog.textContent).toContain("现场灯光将不再更新");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "继续使用" })));
  });

  it("只在录制时不提播放；只在播放时不提录制", async () => {
    render(<CloseGuardDialog />);
    await waitFor(() => expect(tauriEvents.has("app:close-requested")).toBe(true));
    requestClose({ recording: false, playing: true });
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).not.toContain("正在录制的节目");
    expect(dialog.textContent).toContain("正在播放的节目");
  });

  it("节目编辑器：输出灯光、未保存修改、正在烘焙各自列出后果", async () => {
    render(<CloseGuardDialog />);
    await waitFor(() => expect(tauriEvents.has("app:close-requested")).toBe(true));
    requestClose({ recording: false, playing: false, showOutput: true, showUnsaved: true, baking: true });
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("节目编辑器正在输出灯光");
    expect(dialog.textContent).toContain("节目编辑器里有未保存的修改");
    expect(dialog.textContent).toContain("正在生成回放文件");
    expect(dialog.textContent).not.toContain("正在录制的节目");
  });
  it("“继续使用”只关闭对话框，不退出", async () => {
    render(<CloseGuardDialog />);
    await waitFor(() => expect(tauriEvents.has("app:close-requested")).toBe(true));
    requestClose({ recording: true, playing: false });
    fireEvent.click(await screen.findByRole("button", { name: "继续使用" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.appQuit).not.toHaveBeenCalled();
  });

  it("“停止并退出”调用 app_quit；失败时提示原因并保留对话框以便重试", async () => {
    api.appQuit.mockRejectedValue(new Error("录制线程异常退出"));
    render(<CloseGuardDialog />);
    await waitFor(() => expect(tauriEvents.has("app:close-requested")).toBe(true));
    requestClose({ recording: true, playing: false });
    fireEvent.click(await screen.findByRole("button", { name: "停止并退出" }));
    await waitFor(() => expect(api.appQuit).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.error.mock.calls[0][0]).toContain("录制线程异常退出");
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect((screen.getByRole("button", { name: "停止并退出" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
