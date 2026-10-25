// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import i18n from "@/shared/i18n";

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));
const api = vi.hoisted(() => ({
  recordingStart: vi.fn(),
  recordingStop: vi.fn(),
}));
const tauri = vi.hoisted(() => ({ isTauri: vi.fn(() => true) }));

vi.mock("sonner", () => ({ toast }));
vi.mock("@/shared/tauri/invoke", () => tauri);
vi.mock("../lib/api", async (orig) => ({
  ...(await orig<typeof import("../lib/api")>()),
  ...api,
}));

import { useEngineDataStore } from "@/shared/stores/engineDataStore";
import { useRecordingStore } from "../hooks/useRecordingStore";
import { EMPTY_STATUS } from "../lib/types";
import { RecordPanel } from "./RecordPanel";

const universe = (u: number, ips: string[]) => ({
  universe: u,
  protocol: "artNet" as const,
  sourceIps: ips,
  sourceCount: ips.length,
  activeChannels: 1,
  conflictChannels: 0,
  totalPackets: 1,
});

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  vi.clearAllMocks();
  tauri.isTauri.mockReturnValue(true);
  useEngineDataStore.setState({
    universes: [universe(1, ["10.0.0.1"]), universe(2, ["10.0.0.2"])],
    devices: [],
  });
  useRecordingStore.setState({
    status: EMPTY_STATUS,
    last: null,
    sources: [
      { ip: "10.0.0.1", protocol: "artNet", universes: [1], packets: 10 },
      { ip: "10.0.0.2", protocol: "artNet", universes: [2], packets: 20 },
    ],
  });
});

afterEach(() => cleanup());

describe("RecordPanel", () => {
  it("勾选设备后只预览并提交该设备的 Universe", async () => {
    api.recordingStart.mockResolvedValue({
      path: "x.artrec",
      plan: { accepted: [1], rejectedOutOfRange: [], rejectedOverCapacity: [] },
    });
    render(<RecordPanel />);

    expect(screen.getByText("将录制 2 个 Universe")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /10\.0\.0\.1/ }));
    expect(screen.getByText("将录制 1 个 Universe")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("节目名称"), { target: { value: "开场" } });
    fireEvent.click(screen.getByRole("button", { name: "开始录制" }));

    await waitFor(() => expect(api.recordingStart).toHaveBeenCalledTimes(1));
    const args = api.recordingStart.mock.calls[0][0];
    expect(args.filter.sources).toEqual(["10.0.0.1"]);
    expect(args.filter.excludeSources).toBe(false);
    expect(args.filter.protocols).toEqual([]);
    expect(args.name).toBe("开场");
    expect(args.fileStem).toMatch(/^\d{8}-\d{6}_开场$/);
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it("排除模式把所选设备作为黑名单", async () => {
    api.recordingStart.mockResolvedValue({
      path: "x.artrec",
      plan: { accepted: [2], rejectedOutOfRange: [], rejectedOverCapacity: [] },
    });
    render(<RecordPanel />);

    fireEvent.click(screen.getByRole("checkbox", { name: /10\.0\.0\.1/ }));
    fireEvent.click(screen.getByRole("switch"));
    expect(screen.getByText("将录制 1 个 Universe")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "开始录制" }));
    await waitFor(() => expect(api.recordingStart).toHaveBeenCalled());
    expect(api.recordingStart.mock.calls[0][0].filter.excludeSources).toBe(true);
  });

  it("后端错误码被翻译为可读文案", async () => {
    api.recordingStart.mockRejectedValue(new Error("no_universes"));
    render(<RecordPanel />);

    fireEvent.click(screen.getByRole("button", { name: "开始录制" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.error.mock.calls[0][0]).toContain("没有符合过滤条件的活跃 Universe");
  });

  it("录制中显示停止按钮并锁定过滤输入", async () => {
    useRecordingStore.setState({
      status: { ...EMPTY_STATUS, recording: true, part: 1, universes: [1] },
    });
    api.recordingStop.mockResolvedValue({
      files: [{ path: "a.artrec", durationUs: 1000, frames: 5, bytes: 100, sources: [] }],
      error: null,
      dropped: 0,
    });
    render(<RecordPanel />);

    expect((screen.getByLabelText("节目名称") as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "开始录制" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "停止录制" }));
    await waitFor(() => expect(api.recordingStop).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it("非桌面环境直接提示而不调用后端", () => {
    tauri.isTauri.mockReturnValue(false);
    render(<RecordPanel />);

    fireEvent.click(screen.getByRole("button", { name: "开始录制" }));
    expect(api.recordingStart).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledTimes(1);
  });
});
