// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import i18n from "@/shared/i18n";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() },
}));
vi.mock("@/shared/tauri/tauriStorage", () => ({
  createTauriPersistStorage: () => ({
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  }),
}));

import { useEngineStatusStore } from "@/shared/stores/engineStatusStore";
import { useRecordingStore } from "@/features/recording/stores/useRecordingStore";
import { EMPTY_STATUS } from "@/features/recording/lib/types";
import { HeaderBar } from "../HeaderBar";

const renderBar = () =>
  render(
    <MemoryRouter>
      <HeaderBar />
    </MemoryRouter>,
  );

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  useEngineStatusStore.setState({
    appMode: "live",
    receivers: "bound",
    sender: "ready",
    recording: false,
    playing: false,
    clusterRole: "none",
    guardianEnabled: false,
  });
  useRecordingStore.setState({ status: EMPTY_STATUS });
});

afterEach(() => cleanup());

describe("HeaderBar", () => {
  it("同时提供模式开关与录制按钮", () => {
    renderBar();
    expect(screen.getByRole("radiogroup", { name: "运行模式" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "录制" })).toBeTruthy();
  });

  it("实时模式用普通底边；播放器模式换成强调色底边 + 淡底色，让人在任何页面一眼看出模式", () => {
    const { container, rerender } = renderBar();
    const header = container.querySelector("header")!;
    expect(header.className).toContain("border-border");
    expect(header.className).not.toContain("border-primary");

    useEngineStatusStore.setState({ appMode: "player", receivers: "suspended" });
    rerender(
      <MemoryRouter>
        <HeaderBar />
      </MemoryRouter>,
    );
    expect(container.querySelector("header")!.className).toContain("border-primary/60");
    expect(container.querySelector("header")!.className).toContain("bg-primary/5");
  });

  it("“播放中”徽章只在真正播放时出现；不再有重复的“录制中”徽章", () => {
    const { rerender } = renderBar();
    expect(screen.queryByText("播放中")).toBeNull();

    useEngineStatusStore.setState({ playing: true });
    useRecordingStore.setState({ status: { ...EMPTY_STATUS, recording: true, elapsedUs: 1_000_000 } });
    rerender(
      <MemoryRouter>
        <HeaderBar />
      </MemoryRouter>,
    );
    expect(screen.getByText("播放中")).toBeTruthy();
    // 录制状态由录制按钮自己表达（停止按钮），顶栏不再重复一个“录制中”徽章
    expect(screen.queryByText("录制中")).toBeNull();
    expect(screen.getByRole("button", { name: "停止录制" })).toBeTruthy();
  });
});
