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
  recordingDiskInfo: vi.fn(),
}));
const flags = vi.hoisted(() => ({ sacnEnabled: false }));

vi.mock("sonner", () => ({ toast }));
vi.mock("@/features/settings", () => ({
  useProtocolFlags: () => ({ sacnEnabled: flags.sacnEnabled }),
}));
vi.mock("@/shared/tauri/tauriStorage", () => ({
  createTauriPersistStorage: () => ({
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  }),
}));
vi.mock("../../lib/api", async (orig) => ({
  ...(await orig<typeof import("../../lib/api")>()),
  ...api,
}));

import { useEngineDataStore } from "@/shared/stores/engineDataStore";
import { EMPTY_PRESET } from "../../lib/recordingPreset";
import { useRecordingPresetStore } from "../../stores/useRecordingPresetStore";
import { useRecordingStore } from "../../stores/useRecordingStore";
import { EMPTY_STATUS } from "../../lib/types";
import { RecordPanel } from "../RecordPanel";

const universe = (u: number, ips: string[]) => ({
  universe: u,
  protocol: "artNet" as const,
  sourceIps: ips,
  sourceCount: ips.length,
  activeChannels: 1,
  conflictChannels: 0,
  totalPackets: 1,
  packetRate: 0,
  sources: [],
});

const started = (accepted: number[]) => ({
  path: "x.artrec",
  plan: { accepted, rejectedOutOfRange: [], rejectedOverCapacity: [] },
});

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  vi.clearAllMocks();
  flags.sacnEnabled = false;
  api.recordingDiskInfo.mockRejectedValue(new Error("no disk"));
  useRecordingPresetStore.setState({ ...EMPTY_PRESET, sacnEnabled: false });
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
  it("勾选设备后只预览并提交该设备的 Universe，选择写入录制预设", async () => {
    api.recordingStart.mockResolvedValue(started([1]));
    render(<RecordPanel />);

    expect(screen.getByText("将录制 2 个 Universe")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /10\.0\.0\.1/ }));
    expect(screen.getByText("将录制 1 个 Universe")).toBeTruthy();
    expect(useRecordingPresetStore.getState().sources).toEqual(["10.0.0.1"]);
    // 来源分段旁与走带条都给出即时摘要
    expect(screen.getByText("仅录制所选的 1 个设备")).toBeTruthy();
    expect(screen.getByText(/仅 1 个来源/)).toBeTruthy();

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
    api.recordingStart.mockResolvedValue(started([2]));
    render(<RecordPanel />);

    fireEvent.click(screen.getByRole("checkbox", { name: /10\.0\.0\.1/ }));
    fireEvent.click(screen.getByRole("switch"));
    expect(screen.getByText("将录制 1 个 Universe")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "开始录制" }));
    await waitFor(() => expect(api.recordingStart).toHaveBeenCalled());
    expect(api.recordingStart.mock.calls[0][0].filter.excludeSources).toBe(true);
  });

  it("Universe 片段输入即时影响预览与提交的过滤条件", async () => {
    api.recordingStart.mockResolvedValue(started([2]));
    render(<RecordPanel />);

    const range = screen.getByLabelText("Universe 范围过滤", { selector: "input" });
    fireEvent.change(range, { target: { value: "2" } });
    fireEvent.keyDown(range, { key: "Enter" });
    expect(screen.getByText("将录制 1 个 Universe")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "开始录制" }));
    await waitFor(() => expect(api.recordingStart).toHaveBeenCalled());
    expect(api.recordingStart.mock.calls[0][0].filter.universes).toEqual([{ start: 2, end: 2 }]);
  });

  it("名称模板：预览下一个名称，开始成功后序号加一、备注清空", async () => {
    api.recordingStart.mockResolvedValue(started([1, 2]));
    render(<RecordPanel />);

    fireEvent.change(screen.getByLabelText("节目名称"), { target: { value: "舞台A-{nn}" } });
    fireEvent.change(screen.getByLabelText("备注（仅本次）"), { target: { value: "首场" } });
    expect(screen.getAllByText(/舞台A-01/).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "开始录制" }));
    await waitFor(() => expect(api.recordingStart).toHaveBeenCalledTimes(1));
    const args = api.recordingStart.mock.calls[0][0];
    expect(args.name).toBe("舞台A-01");
    expect(args.notes).toBe("首场");
    await waitFor(() => expect(useRecordingPresetStore.getState().nextIndex).toBe(2));
    expect((screen.getByLabelText("备注（仅本次）") as HTMLInputElement).value).toBe("");
    expect(screen.getAllByText(/舞台A-02/).length).toBeGreaterThan(0);
  });

  it("“恢复为全量”清除过滤条件", () => {
    useRecordingPresetStore.setState({ sources: ["10.0.0.1"], universeTokens: ["1"] });
    render(<RecordPanel />);
    expect(screen.getByText("将录制 1 个 Universe")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "恢复为全量" }));
    expect(screen.getByText("将录制 2 个 Universe")).toBeTruthy();
    expect(useRecordingPresetStore.getState().universeTokens).toEqual([]);
  });

  it("后端错误码被翻译为可读文案", async () => {
    api.recordingStart.mockRejectedValue(new Error("no_universes"));
    render(<RecordPanel />);

    fireEvent.click(screen.getByRole("button", { name: "开始录制" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.error.mock.calls[0][0]).toContain("没有符合过滤条件的活跃 Universe");
  });

  it("录制中：设置收成只读摘要，显示停止按钮", async () => {
    useRecordingPresetStore.setState({ sources: ["10.0.0.1"] });
    useRecordingStore.setState({
      status: { ...EMPTY_STATUS, recording: true, part: 1, universes: [1] },
    });
    api.recordingStop.mockResolvedValue({
      files: [{ path: "a.artrec", durationUs: 1000, frames: 5, bytes: 100, sources: [] }],
      error: null,
      dropped: 0,
    });
    render(<RecordPanel />);

    expect(screen.getByText("录制中不可修改")).toBeTruthy();
    expect(screen.queryByLabelText("节目名称")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByText("仅录制所选的 1 个设备")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "开始录制" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "停止录制" }));
    await waitFor(() => expect(api.recordingStop).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it("sACN 关闭时不显示协议过滤，空来源提示只提 Art-Net", () => {
    useRecordingStore.setState({ sources: [] });
    render(<RecordPanel />);

    expect(screen.queryByRole("checkbox", { name: "sACN" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Art-Net" })).toBeNull();
    expect(screen.queryByText(/sACN/)).toBeNull();
  });

  it("sACN 开启时显示协议过滤，取消 Art-Net 后只提交 sACN；唯一选中的协议不能取消", async () => {
    flags.sacnEnabled = true;
    api.recordingStart.mockResolvedValue(started([1]));
    render(<RecordPanel />);

    fireEvent.click(screen.getByRole("checkbox", { name: "Art-Net" }));
    expect((screen.getByRole("checkbox", { name: "sACN" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "开始录制" }));

    await waitFor(() => expect(api.recordingStart).toHaveBeenCalledTimes(1));
    expect(api.recordingStart.mock.calls[0][0].filter.protocols).toEqual(["sacn"]);
  });

  it("关闭 sACN 后，此前在隐藏界面里取消的协议选择不再生效", async () => {
    flags.sacnEnabled = true;
    api.recordingStart.mockResolvedValue(started([1]));
    const { rerender } = render(<RecordPanel />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Art-Net" }));

    flags.sacnEnabled = false;
    rerender(<RecordPanel />);
    fireEvent.click(screen.getByRole("button", { name: "开始录制" }));

    await waitFor(() => expect(api.recordingStart).toHaveBeenCalledTimes(1));
    expect(api.recordingStart.mock.calls[0][0].filter.protocols).toEqual([]);
  });
});
