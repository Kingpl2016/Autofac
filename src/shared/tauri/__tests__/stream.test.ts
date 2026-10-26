import { beforeEach, describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => {
  /** 记录构造过的通道，测试里直接调用其回调模拟后端推送。 */
  const channels: Array<{ deliver: (buf: ArrayBuffer) => void }> = [];
  class Channel {
    readonly deliver: (buf: ArrayBuffer) => void;
    constructor(onmessage: (buf: ArrayBuffer) => void) {
      this.deliver = onmessage;
      channels.push(this);
    }
  }
  return { Channel, channels, invoke: vi.fn() };
});

vi.mock("@tauri-apps/api/core", () => ({ Channel: core.Channel, invoke: core.invoke }));

beforeEach(() => {
  // demoBridge 有模块级状态：每个用例重新加载，互不影响
  vi.resetModules();
  core.channels.length = 0;
  core.invoke.mockReset();
});

describe("subscribeDmxStream", () => {
  it("真实模式：经 Channel 订阅，取消时按 id 退订，取消后的在途帧被丢弃", async () => {
    core.invoke.mockResolvedValue(7);
    const { subscribeDmxStream } = await import("../stream");
    const onFrame = vi.fn();
    const cancel = await subscribeDmxStream(onFrame);

    expect(core.channels).toHaveLength(1);
    expect(core.invoke).toHaveBeenCalledWith("dmx_stream_subscribe", { channel: core.channels[0] });

    const buf = new ArrayBuffer(6);
    core.channels[0].deliver(buf);
    expect(onFrame).toHaveBeenCalledWith(buf);

    core.invoke.mockResolvedValue(undefined);
    cancel();
    cancel(); // 重复取消只退订一次
    expect(core.invoke).toHaveBeenLastCalledWith("dmx_stream_unsubscribe", { id: 7 });
    expect(core.invoke).toHaveBeenCalledTimes(2);

    core.channels[0].deliver(new ArrayBuffer(6));
    expect(onFrame).toHaveBeenCalledTimes(1);
  });

  it("演示模式：走注册的提供者，不构造 Tauri Channel、不调用命令", async () => {
    const { installDemoStream } = await import("../demoBridge");
    const off = vi.fn();
    const provider = { subscribe: vi.fn(() => off) };
    installDemoStream(provider);
    const { subscribeDmxStream } = await import("../stream");

    const onFrame = vi.fn();
    const cancel = await subscribeDmxStream(onFrame);
    expect(provider.subscribe).toHaveBeenCalledWith(onFrame);
    expect(core.channels).toHaveLength(0);
    expect(core.invoke).not.toHaveBeenCalled();
    cancel();
    expect(off).toHaveBeenCalledTimes(1);
  });
});
