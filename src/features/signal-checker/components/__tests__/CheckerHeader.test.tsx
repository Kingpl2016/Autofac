// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

vi.mock("@/shared/tauri/tauriStorage", () => ({
  createTauriPersistStorage: () => ({
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  }),
}));

import i18n from "@/shared/i18n";
import { makeStatus } from "../../__tests__/helpers";
import { useSenderStore } from "../../stores/useSenderStore";
import { CheckerHeader } from "../CheckerHeader";

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  useSenderStore.setState({ status: null });
});

afterEach(() => cleanup());

describe("CheckerHeader", () => {
  it("收到第一次状态前显示“未发送”，频率为 --", () => {
    render(<CheckerHeader />);
    expect(screen.getByRole("heading", { level: 1, name: "信号检测器" })).toBeTruthy();
    expect(screen.getByText("未发送")).toBeTruthy();
    expect(screen.getByText("--Hz · 0 uni")).toBeTruthy();
    expect(screen.queryByText(/包$/)).toBeNull();
  });

  it("发送中显示状态文字、已发包数和实测频率", () => {
    useSenderStore.setState({
      status: makeStatus({ running: true, packetsSent: 1204332, measuredHz: 43.6, universeCount: 51 }),
    });
    render(<CheckerHeader />);
    expect(screen.getByText("发送中")).toBeTruthy();
    expect(screen.getByText("1,204,332 包")).toBeTruthy();
    expect(screen.getByText("44Hz · 51 uni")).toBeTruthy();
  });

  it("刚开始发送、频率还没结算时显示 --，而不是 0Hz", () => {
    useSenderStore.setState({ status: makeStatus({ running: true, measuredHz: 0, universeCount: 2 }) });
    render(<CheckerHeader />);
    expect(screen.getByText("--Hz · 2 uni")).toBeTruthy();
  });

  it("停止后不再显示包数，即使状态里还留着频率", () => {
    useSenderStore.setState({ status: makeStatus({ running: true, packetsSent: 10, measuredHz: 44 }) });
    render(<CheckerHeader />);
    act(() => useSenderStore.setState({ status: makeStatus({ running: false, packetsSent: 10, measuredHz: 44 }) }));
    expect(screen.getByText("未发送")).toBeTruthy();
    expect(screen.queryByText("10 包")).toBeNull();
    expect(screen.getByText("--Hz · 1 uni")).toBeTruthy();
  });
});
