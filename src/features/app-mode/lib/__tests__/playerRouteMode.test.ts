import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ appModeSet: vi.fn(), stopRecordingForModeChange: vi.fn() }));
vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), ...api }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { useEngineStatusStore } from "@/shared/stores/engineStatusStore";
import { isAutoEntered, resetPlayerRouteMode, syncPlayerRouteMode } from "../playerRouteMode";

const mode = () => useEngineStatusStore.getState().appMode;

beforeEach(() => {
  vi.clearAllMocks();
  resetPlayerRouteMode();
  useEngineStatusStore.setState({ appMode: "live", recording: false });
  api.appModeSet.mockImplementation(async (m: "live" | "player") => ({
    mode: m,
    receivers: m === "player" ? "suspended" : "bound",
    sender: "ready",
  }));
  api.stopRecordingForModeChange.mockResolvedValue(undefined);
});

describe("页面自动进入 / 退出播放器模式", () => {
  it("进入节目库等页面直接进入播放器模式；离开到普通页面时退回实时模式", async () => {
    await syncPlayerRouteMode(true, false);
    expect(api.appModeSet).toHaveBeenCalledWith("player");
    expect(mode()).toBe("player");
    expect(isAutoEntered()).toBe(true);

    // 在这类页面之间切换不重复切换
    await syncPlayerRouteMode(true, false);
    expect(api.appModeSet).toHaveBeenCalledTimes(1);

    await syncPlayerRouteMode(false, false);
    expect(api.appModeSet).toHaveBeenLastCalledWith("live");
    expect(mode()).toBe("live");
  });

  it("录制进行中：与进入播放器模式一样先停止并保存录制", async () => {
    useEngineStatusStore.setState({ recording: true });
    await syncPlayerRouteMode(true, false);
    expect(api.stopRecordingForModeChange).toHaveBeenCalled();
    expect(api.stopRecordingForModeChange.mock.invocationCallOrder[0]).toBeLessThan(
      api.appModeSet.mock.invocationCallOrder[0],
    );
  });

  it("用户自己进入的播放器模式不会被自动退出；去播放器页时保留播放器模式", async () => {
    useEngineStatusStore.setState({ appMode: "player" });
    await syncPlayerRouteMode(true, false);
    await syncPlayerRouteMode(false, false);
    expect(api.appModeSet).not.toHaveBeenCalled();
    expect(mode()).toBe("player");

    useEngineStatusStore.setState({ appMode: "live" });
    await syncPlayerRouteMode(true, false);
    await syncPlayerRouteMode(false, true);
    expect(api.appModeSet).toHaveBeenCalledTimes(1);
    expect(mode()).toBe("player");
    // 之后视为用户主动进入，离开播放器页也不再自动退出
    await syncPlayerRouteMode(false, false);
    expect(api.appModeSet).toHaveBeenCalledTimes(1);
  });
});
