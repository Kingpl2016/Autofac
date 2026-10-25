import { describe, expect, it } from "vitest";

import { diagnosticHints, isLocalIp, startReasons } from "../guard";
import type { CheckerContext, SignalConfig } from "../types";

const context = (over: Partial<CheckerContext> = {}): CheckerContext => ({
  appMode: "live",
  receiveInterface: "0.0.0.0",
  multiNic: false,
  forwardingEnabled: 0,
  localIps: ["127.0.0.1", "192.168.1.10"],
  ...over,
});

const config = (over: Partial<SignalConfig> = {}): SignalConfig => ({
  targetIp: "127.0.0.1",
  port: 6454,
  protocol: "artNet",
  universes: "0",
  ...over,
});

describe("isLocalIp", () => {
  it("回环网段与本机网卡 IP 都算“发给自己”", () => {
    const local = ["192.168.1.10"];
    expect(isLocalIp("127.0.0.1", local)).toBe(true);
    expect(isLocalIp("127.5.6.7", local)).toBe(true);
    expect(isLocalIp(" 192.168.1.10 ", local)).toBe(true);
    expect(isLocalIp("192.168.1.11", local)).toBe(false);
    expect(isLocalIp("10.0.0.1", local)).toBe(false);
  });

  it("不认识本机地址时只认回环", () => {
    expect(isLocalIp("127.0.0.1", [])).toBe(true);
    expect(isLocalIp("192.168.1.10", [])).toBe(false);
  });

  it("广播地址不是本机", () => {
    expect(isLocalIp("255.255.255.255", ["192.168.1.10"])).toBe(false);
    expect(isLocalIp("192.168.1.255", ["192.168.1.10"])).toBe(false);
  });
});

describe("startReasons", () => {
  const base = { mode: "auto" as const, flashing: false, strobeAcknowledged: false };

  it("发给本机、没有转发、不闪烁：不用确认", () => {
    expect(startReasons({ ...base, config: config(), context: context() })).toEqual([]);
  });

  it("目标不是本机：要确认，并写出 IP", () => {
    expect(
      startReasons({ ...base, config: config({ targetIp: " 10.0.0.9 " }), context: context() }),
    ).toEqual([{ kind: "remote", ip: "10.0.0.9" }]);
    expect(
      startReasons({ ...base, config: config({ targetIp: "255.255.255.255" }), context: context() }),
    ).toEqual([{ kind: "remote", ip: "255.255.255.255" }]);
  });

  it("发给本机且转发表有启用的目的地：要确认（信号会被转发到真实设备）", () => {
    expect(
      startReasons({ ...base, config: config(), context: context({ forwardingEnabled: 3 }) }),
    ).toEqual([{ kind: "forwarding", count: 3 }]);
    // 发给本机网卡 IP 同样会被自己接收并转发
    expect(
      startReasons({
        ...base,
        config: config({ targetIp: "192.168.1.10" }),
        context: context({ forwardingEnabled: 1 }),
      }),
    ).toEqual([{ kind: "forwarding", count: 1 }]);
  });

  it("播放器模式下实时接收已停止，不会被转发，所以不为转发而确认", () => {
    expect(
      startReasons({
        ...base,
        config: config(),
        context: context({ appMode: "player", forwardingEnabled: 3 }),
      }),
    ).toEqual([]);
  });

  it("目标是外部设备时，转发表与此无关，只报“非本机”", () => {
    expect(
      startReasons({
        ...base,
        config: config({ targetIp: "10.0.0.9" }),
        context: context({ forwardingEnabled: 3 }),
      }),
    ).toEqual([{ kind: "remote", ip: "10.0.0.9" }]);
  });

  it("频闪：自动模式下本会话首次要确认，确认过就不再问；手动模式不涉及图案", () => {
    const flashing = { ...base, flashing: true, config: config(), context: context() };
    expect(startReasons(flashing)).toEqual([{ kind: "strobe" }]);
    expect(startReasons({ ...flashing, strobeAcknowledged: true })).toEqual([]);
    expect(startReasons({ ...flashing, mode: "manual" })).toEqual([]);
  });

  it("多个原因同时出现时都列出来", () => {
    expect(
      startReasons({
        ...base,
        flashing: true,
        config: config({ targetIp: "10.0.0.9" }),
        context: context(),
      }),
    ).toEqual([{ kind: "remote", ip: "10.0.0.9" }, { kind: "strobe" }]);
  });

  it("取不到运行环境时保守判断：只认回环为本机，不报转发", () => {
    expect(startReasons({ ...base, config: config(), context: undefined })).toEqual([]);
    expect(
      startReasons({ ...base, config: config({ targetIp: "192.168.1.10" }), context: undefined }),
    ).toEqual([{ kind: "remote", ip: "192.168.1.10" }]);
  });
});

describe("diagnosticHints", () => {
  it("目标不是本机，或环境未知：没有提示", () => {
    expect(diagnosticHints(config({ targetIp: "10.0.0.9" }), context({ forwardingEnabled: 2 }))).toEqual([]);
    expect(diagnosticHints(config(), undefined)).toEqual([]);
  });

  it("全部接口 + 没有转发：自测路径畅通，没有提示", () => {
    expect(diagnosticHints(config(), context())).toEqual([]);
  });

  it("播放器模式：只给这一条（实时接收都停了，其它提示没有意义）", () => {
    expect(
      diagnosticHints(config(), context({ appMode: "player", forwardingEnabled: 2, receiveInterface: "192.168.1.10" })),
    ).toEqual([{ kind: "playerMode" }]);
  });

  it("接收绑定在具体网卡：发往 127.0.0.1 收不到（Art-Net），并告诉用户改发哪个 IP", () => {
    expect(diagnosticHints(config(), context({ receiveInterface: "192.168.1.10" }))).toEqual([
      { kind: "receiverBinding", ip: "192.168.1.10" },
    ]);
  });

  it("多网卡模式：同样收不到，但没有单一的接收 IP 可指", () => {
    expect(diagnosticHints(config(), context({ multiNic: true }))).toEqual([
      { kind: "receiverBinding", ip: null },
    ]);
  });

  it("sACN 接收始终绑 0.0.0.0，不受网卡绑定影响；直接发给本机网卡 IP 也没问题", () => {
    expect(
      diagnosticHints(config({ protocol: "sacn", port: 5568 }), context({ receiveInterface: "192.168.1.10" })),
    ).toEqual([]);
    expect(
      diagnosticHints(config({ targetIp: "192.168.1.10" }), context({ receiveInterface: "192.168.1.10" })),
    ).toEqual([]);
  });

  it("转发表有启用的目的地：提醒信号会被转发出去，并和绑定提示并存", () => {
    expect(diagnosticHints(config(), context({ forwardingEnabled: 2 }))).toEqual([
      { kind: "forwarding", count: 2 },
    ]);
    expect(
      diagnosticHints(config(), context({ forwardingEnabled: 2, receiveInterface: "192.168.1.10" })),
    ).toEqual([
      { kind: "receiverBinding", ip: "192.168.1.10" },
      { kind: "forwarding", count: 2 },
    ]);
  });
});
