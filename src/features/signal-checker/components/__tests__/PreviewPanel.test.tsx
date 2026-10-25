// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@/shared/tauri/invoke", () => ({ invoke }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/features/settings", () => ({
  useSettingsQuery: () => ({ data: { display: { valueFormat: "decimal" } } }),
}));
vi.mock("@/shared/tauri/tauriStorage", () => ({
  createTauriPersistStorage: () => ({
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  }),
}));

import i18n from "@/shared/i18n";
import { makeFrame, makeStatus, renderWithQuery } from "../../__tests__/helpers";
import { useSenderStore } from "../../stores/useSenderStore";
import { PreviewPanel } from "../PreviewPanel";

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  vi.clearAllMocks();
  invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) =>
    cmd === "signal_checker_frame" ? makeFrame({ 9: args!.universe === 3 ? 200 : 77 }) : undefined,
  );
  useSenderStore.setState({
    status: makeStatus({ universes: [3, 5], universeCount: 2 }),
    error: null,
    preview: null,
  });
});

afterEach(() => cleanup());

const cell = (ch: number) => document.querySelector<HTMLElement>(`[data-ch="${ch}"]`)!;
const previewCalls = () =>
  invoke.mock.calls.filter(([cmd]) => cmd === "signal_checker_set_preview").map(([, a]) => a);

describe("PreviewPanel", () => {
  it("默认查看发送范围内第一个 Universe，并让后端只推送这一路", async () => {
    renderWithQuery(<PreviewPanel />);
    expect((screen.getByLabelText("查看 Universe") as HTMLSelectElement).value).toBe("3");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["3", "5"]);
    await waitFor(() => expect(cell(10).textContent).toBe("200"));
    expect(previewCalls()).toEqual([{ universe: 3 }]);
    expect(screen.getByRole("grid", { name: /Universe 3/ })).toBeTruthy();
  });

  it("切换 Universe：重新取数并改推另一路", async () => {
    renderWithQuery(<PreviewPanel />);
    await waitFor(() => expect(cell(10).textContent).toBe("200"));
    fireEvent.change(screen.getByLabelText("查看 Universe"), { target: { value: "5" } });
    await waitFor(() => expect(cell(10).textContent).toBe("77"));
    expect(previewCalls()).toEqual([{ universe: 3 }, { universe: null }, { universe: 5 }]);
  });

  it("发送中直接显示后端推送的预览帧（约 9Hz），而不是再去取", async () => {
    useSenderStore.setState({ status: makeStatus({ running: true, universes: [3, 5] }) });
    renderWithQuery(<PreviewPanel />);
    await waitFor(() => expect(cell(10).textContent).toBe("200"));
    act(() =>
      useSenderStore.getState().setPreview({ universe: 3, data: makeFrame({ 9: 33 }) }),
    );
    expect(cell(10).textContent).toBe("33");
    // 别的 Universe 的预览帧不会串进来
    act(() => useSenderStore.getState().setPreview({ universe: 5, data: makeFrame({ 9: 99 }) }));
    expect(cell(10).textContent).toBe("200");
  });

  it("所选 Universe 不在新的发送范围内时，自动回落到范围内第一个", async () => {
    renderWithQuery(<PreviewPanel />);
    fireEvent.change(screen.getByLabelText("查看 Universe"), { target: { value: "5" } });
    await waitFor(() => expect(cell(10).textContent).toBe("77"));
    act(() => useSenderStore.setState({ status: makeStatus({ universes: [8, 9] }) }));
    expect((screen.getByLabelText("查看 Universe") as HTMLSelectElement).value).toBe("8");
  });

  it("卸载时关闭预览推送", async () => {
    const { unmount } = renderWithQuery(<PreviewPanel />);
    await waitFor(() => expect(previewCalls()).toEqual([{ universe: 3 }]));
    unmount();
    expect(previewCalls().at(-1)).toEqual({ universe: null });
  });

  it("还没有状态（没有可看的 Universe）时下拉置灰、不显示栅格", () => {
    useSenderStore.setState({ status: null });
    renderWithQuery(<PreviewPanel />);
    expect((screen.getByLabelText("查看 Universe") as HTMLSelectElement).disabled).toBe(true);
    expect(screen.queryByRole("grid")).toBeNull();
  });
});
