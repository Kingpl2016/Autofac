import { describe, expect, it } from "vitest";

import { DEFAULT_DRAFT, configToDraft, draftToConfig, parsePort, sameConfig } from "../draft";
import type { SignalConfig } from "../types";

const config: SignalConfig = { targetIp: "10.0.0.5", port: 6454, protocol: "artNet", universes: "0-9" };

describe("parsePort", () => {
  it("接受 1 到 65535 的纯数字，忽略首尾空白", () => {
    expect(parsePort("1")).toBe(1);
    expect(parsePort(" 6454 ")).toBe(6454);
    expect(parsePort("65535")).toBe(65535);
  });

  it("拒绝 0、越界、空、小数、负数、带字母的输入", () => {
    for (const bad of ["0", "65536", "99999", "100000", "", "  ", "6454.5", "-1", "64a4", "0x10", "+80"]) {
      expect(parsePort(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("draftToConfig", () => {
  it("端口转数字，IP 与范围去掉首尾空白", () => {
    expect(
      draftToConfig({ targetIp: " 10.0.0.5 ", port: "6454", protocol: "artNet", universes: " 0-9 " }),
    ).toEqual(config);
  });

  it("端口不合法时为 null", () => {
    expect(draftToConfig({ ...DEFAULT_DRAFT, port: "abc" })).toBeNull();
  });

  it("默认草稿是本机回环 Art-Net Universe 0", () => {
    expect(draftToConfig(DEFAULT_DRAFT)).toEqual({
      targetIp: "127.0.0.1",
      port: 6454,
      protocol: "artNet",
      universes: "0",
    });
  });
});

describe("sameConfig / configToDraft", () => {
  it("忽略首尾空白，其余字段逐一比较", () => {
    expect(sameConfig(config, { ...config, targetIp: " 10.0.0.5 ", universes: "0-9 " })).toBe(true);
    expect(sameConfig(config, { ...config, port: 6455 })).toBe(false);
    expect(sameConfig(config, { ...config, protocol: "sacn" })).toBe(false);
    expect(sameConfig(config, { ...config, universes: "0-10" })).toBe(false);
    expect(sameConfig(config, { ...config, targetIp: "10.0.0.6" })).toBe(false);
  });

  it("配置还原成草稿后再转回配置，内容不变", () => {
    expect(draftToConfig(configToDraft(config))).toEqual(config);
  });
});
