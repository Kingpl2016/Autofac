// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import i18n from "@/shared/i18n";

const toast = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() }));
const api = vi.hoisted(() => ({
  appModeSet: vi.fn(),
  appModeGet: vi.fn(),
  stopRecordingForModeChange: vi.fn(),
}));

vi.mock("sonner", () => ({ toast }));
vi.mock("../../lib/api", () => api);

import { useEngineStatusStore } from "@/shared/stores/engineStatusStore";
import { useAppModeStore } from "../../stores/useAppModeStore";
import { useModeDialogStore } from "../../stores/useModeDialogStore";
import { EnterPlayerCard } from "../EnterPlayerCard";
import { LiveOnly } from "../LiveOnly";
import { ModeConfirmDialog } from "../ModeConfirmDialog";
import { ModeGuardNotice } from "../ModeGuardNotice";
import { PlayerModeBanner } from "../PlayerModeBanner";

function renderIn(ui: React.ReactNode) {
  return render(
    <MemoryRouter>
      {ui}
      <ModeConfirmDialog />
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  vi.clearAllMocks();
  useEngineStatusStore.setState({
    appMode: "player",
    receivers: "suspended",
    sender: "ready",
    recording: false,
    playing: false,
  });
  useAppModeStore.setState({ transitioning: false });
  useModeDialogStore.setState({ request: null });
  api.appModeSet.mockResolvedValue({ mode: "live", receivers: "bound", sender: "ready" });
});

afterEach(() => cleanup());

describe("PlayerModeBanner", () => {
  it("常驻横幅：模式说明 + 输出状态 + 唯一的“退出播放器模式”入口", () => {
    renderIn(<PlayerModeBanner />);
    expect(screen.getByText("播放器模式")).toBeTruthy();
    expect(screen.getByText("实时接收已停止，输出走转发表或指定设备")).toBeTruthy();
    expect(screen.getByText("输出就绪")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "退出播放器模式" })).toHaveLength(1);
  });

  it.each([
    ["ready", "输出就绪"],
    ["reconnecting", "输出重连中…"],
    ["down", "输出不可用"],
  ] as const)("发送器 %s 时用文字标明（不只靠颜色）", (sender, text) => {
    useEngineStatusStore.setState({ sender });
    renderIn(<PlayerModeBanner />);
    expect(screen.getByText(text)).toBeTruthy();
  });

  it("没有在播放时点击退出直接切回实时", async () => {
    renderIn(<PlayerModeBanner />);
    fireEvent.click(screen.getByRole("button", { name: "退出播放器模式" }));
    await waitFor(() => expect(api.appModeSet).toHaveBeenCalledWith("live"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("切换进行中禁用退出按钮", () => {
    useAppModeStore.setState({ transitioning: true });
    renderIn(<PlayerModeBanner />);
    expect((screen.getByRole("button", { name: "退出播放器模式" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("EnterPlayerCard", () => {
  beforeEach(() => useEngineStatusStore.setState({ appMode: "live", receivers: "bound" }));

  it("说清楚进入后的三件事，只有一个主按钮", () => {
    renderIn(<EnterPlayerCard />);
    expect(screen.getByText("停止实时接收，并释放 Art-Net / sACN 接收端口")).toBeTruthy();
    expect(screen.getByText("输出走转发表，或你指定的设备")).toBeTruthy();
    expect(screen.getByText("录制不可用；随时可在顶栏切回实时模式")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "进入播放器模式" })).toHaveLength(1);
  });

  it("点击主按钮不会隐式切换，而是先弹确认", async () => {
    renderIn(<EnterPlayerCard />);
    fireEvent.click(screen.getByRole("button", { name: "进入播放器模式" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(api.appModeSet).not.toHaveBeenCalled();
  });
});

describe("ModeGuardNotice / LiveOnly", () => {
  it("守卫面板解释原因并给出两条出路", () => {
    renderIn(<ModeGuardNotice />);
    expect(screen.getByText("播放器模式下实时接收已停止")).toBeTruthy();
    expect(screen.getByRole("button", { name: "退出播放器模式" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "前往播放器" }).getAttribute("href")).toBe("/player");
  });

  it("可以自定义说明文案", () => {
    renderIn(<ModeGuardNotice description="播放器模式下无法录制。" />);
    expect(screen.getByText("播放器模式下无法录制。")).toBeTruthy();
  });

  it("LiveOnly：播放器模式下换成守卫面板，实时模式下原样渲染页面", () => {
    const { rerender } = renderIn(
      <LiveOnly>
        <p>实时页面</p>
      </LiveOnly>,
    );
    expect(screen.queryByText("实时页面")).toBeNull();
    expect(screen.getByText("播放器模式下实时接收已停止")).toBeTruthy();

    useEngineStatusStore.setState({ appMode: "live" });
    rerender(
      <MemoryRouter>
        <LiveOnly>
          <p>实时页面</p>
        </LiveOnly>
      </MemoryRouter>,
    );
    expect(screen.getByText("实时页面")).toBeTruthy();
  });
});
