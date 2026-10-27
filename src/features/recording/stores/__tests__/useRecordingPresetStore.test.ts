import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/shared/tauri/tauriStorage", () => ({
  createTauriPersistStorage: () => ({
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  }),
}));

import { EMPTY_PRESET } from "../../lib/recordingPreset";
import { getRecordingPreset, useRecordingPresetStore } from "../useRecordingPresetStore";

const state = () => useRecordingPresetStore.getState();

beforeEach(() => {
  useRecordingPresetStore.setState({ ...EMPTY_PRESET, sacnEnabled: false });
});

describe("useRecordingPresetStore", () => {
  it("切换来源：勾选与取消勾选", () => {
    state().toggleSource("10.0.0.1");
    state().toggleSource("10.0.0.2");
    state().toggleSource("10.0.0.1");
    expect(state().sources).toEqual(["10.0.0.2"]);
  });

  it("协议至少保留一个，重新勾选时保持固定顺序", () => {
    state().toggleProtocol("artNet");
    expect(state().protocols).toEqual(["sacn"]);
    state().toggleProtocol("sacn");
    expect(state().protocols).toEqual(["sacn"]);
    state().toggleProtocol("artNet");
    expect(state().protocols).toEqual(["artNet", "sacn"]);
  });

  it("序号加一、重置；恢复为全量只清过滤条件，保留名称模板与序号", () => {
    state().setNameTemplate("A-{n}");
    state().advanceIndex();
    state().advanceIndex();
    expect(state().nextIndex).toBe(3);
    state().toggleSource("10.0.0.1");
    state().setUniverseTokens(["0-3"]);
    state().setExtraTokens(["5"]);
    state().resetFilters();
    expect(getRecordingPreset().preset).toEqual({ ...EMPTY_PRESET, nameTemplate: "A-{n}", nextIndex: 3 });
    state().resetIndex();
    expect(state().nextIndex).toBe(1);
  });

  it("名称模板超长时截断", () => {
    state().setNameTemplate("x".repeat(200));
    expect(state().nameTemplate.length).toBe(80);
  });

  it("getRecordingPreset 只返回预设字段与协议开关", () => {
    state().setSacnEnabled(true);
    const { preset, sacnEnabled } = getRecordingPreset();
    expect(sacnEnabled).toBe(true);
    expect(Object.keys(preset).sort()).toEqual(Object.keys(EMPTY_PRESET).sort());
  });
});
