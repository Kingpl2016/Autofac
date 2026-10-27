// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const toast = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }));
const api = vi.hoisted(() => ({ recordingStart: vi.fn(), recordingStop: vi.fn() }));

vi.mock("sonner", () => ({ toast }));
vi.mock("@/shared/tauri/tauriStorage", () => ({
  createTauriPersistStorage: () => ({
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  }),
}));
vi.mock("../api", () => api);

import i18n from "@/shared/i18n";
import { useRecordingPresetStore } from "../../stores/useRecordingPresetStore";
import { useRecordingStore } from "../../stores/useRecordingStore";
import { EMPTY_PRESET } from "../recordingPreset";
import { startRecording } from "../recordControl";

const t = i18n.getFixedT("zh");

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  vi.clearAllMocks();
  useRecordingPresetStore.setState({ ...EMPTY_PRESET, sacnEnabled: false });
  useRecordingStore.setState({ last: null });
  api.recordingStart.mockResolvedValue({ path: "x", plan: { accepted: [1, 2] } });
});

describe("startRecording", () => {
  it("按当前预设构造参数；成功后序号加一并提示节目名称", async () => {
    useRecordingPresetStore.setState({
      sources: ["10.0.0.1"],
      universeTokens: ["0-3"],
      nameTemplate: "舞台A-{nn}",
      nextIndex: 4,
    });
    await expect(startRecording(t, { notes: " 备注 " })).resolves.toBe(true);

    const args = api.recordingStart.mock.calls[0][0];
    expect(args.name).toBe("舞台A-04");
    expect(args.notes).toBe("备注");
    expect(args.filter.sources).toEqual(["10.0.0.1"]);
    expect(args.filter.universes).toEqual([{ start: 0, end: 3 }]);
    expect(useRecordingPresetStore.getState().nextIndex).toBe(5);
    expect(toast.success).toHaveBeenCalledWith("开始录制“舞台A-04”，共 2 个 Universe");
  });

  it("失败时序号不变，给出可读错误", async () => {
    api.recordingStart.mockRejectedValue(new Error("no_universes"));
    useRecordingPresetStore.setState({ nameTemplate: "A-{n}", nextIndex: 2 });
    await expect(startRecording(t)).resolves.toBe(false);
    expect(useRecordingPresetStore.getState().nextIndex).toBe(2);
    expect(toast.error.mock.calls[0][0]).toContain("没有符合过滤条件的活跃 Universe");
  });

  it("模板不含序号时序号不变", async () => {
    useRecordingPresetStore.setState({ nameTemplate: "彩排", nextIndex: 2 });
    await startRecording(t);
    expect(useRecordingPresetStore.getState().nextIndex).toBe(2);
  });

  it("协议开关缺省取 store 里同步的值，显式传入时以传入为准", async () => {
    useRecordingPresetStore.setState({ protocols: ["sacn"], sacnEnabled: true });
    await startRecording(t);
    expect(api.recordingStart.mock.calls[0][0].filter.protocols).toEqual(["sacn"]);
    await startRecording(t, { sacnEnabled: false });
    expect(api.recordingStart.mock.calls[1][0].filter.protocols).toEqual([]);
  });

  it("开始前清掉上一次的结果", async () => {
    useRecordingStore.setState({ last: { files: [], error: null, dropped: 3, stoppedBy: "disk" } });
    await startRecording(t);
    expect(useRecordingStore.getState().last).toBeNull();
  });
});
