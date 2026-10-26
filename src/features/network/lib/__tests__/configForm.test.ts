import { describe, expect, it } from "vitest";

import { diffConfig, isIpv4, patchNeedsReboot, toDraft, validateConfig, type ConfigDraft } from "../configForm";
import type { DeviceConfig } from "../types";

const base: DeviceConfig = {
  artnetEnabled: true,
  sacnEnabled: false,
  targetMode: 0,
  sacnMulticast: 1,
  sacnPriority: 100,
  stopBehavior: 0,
  keepaliveMs: 1000,
  sourceName: "ArtNet Core",
  uartOutputEnabled: true,
  netOutputEnabled: true,
  forwardUniStart: 0,
  forwardUniCount: 8,
  forwardSacn: false,
  dhcp: true,
  ip: "0.0.0.0",
  netmask: "255.255.255.0",
  gateway: "192.168.1.1",
  hostname: "artnet-core",
  tokenSet: true,
};

const draft = (over: Partial<ConfigDraft> = {}): ConfigDraft => ({ ...toDraft(base), ...over });

describe("validateConfig", () => {
  it("默认配置合法", () => {
    expect(validateConfig(draft())).toEqual({});
  });

  it("数值范围边界", () => {
    expect(validateConfig(draft({ sacnPriority: 200, keepaliveMs: 600_000, forwardUniStart: 32_767, forwardUniCount: 512 }))).toEqual({});
    const bad = validateConfig(
      draft({ sacnPriority: 201, keepaliveMs: -1, forwardUniStart: 32_768, forwardUniCount: 0 }),
    );
    expect(Object.keys(bad).sort()).toEqual(["forwardUniCount", "forwardUniStart", "keepaliveMs", "sacnPriority"]);
    expect(validateConfig(draft({ sacnPriority: 1.5 })).sacnPriority).toBeDefined();
    expect(validateConfig(draft({ sacnPriority: Number.NaN })).sacnPriority).toBeDefined();
  });

  it("源名称按字节计，且不能有控制字符", () => {
    expect(validateConfig(draft({ sourceName: "" })).sourceName).toBeDefined();
    expect(validateConfig(draft({ sourceName: "a".repeat(63) })).sourceName).toBeUndefined();
    expect(validateConfig(draft({ sourceName: "a".repeat(64) })).sourceName).toBeDefined();
    expect(validateConfig(draft({ sourceName: "汉".repeat(21) })).sourceName).toBeUndefined();
    expect(validateConfig(draft({ sourceName: "汉".repeat(22) })).sourceName).toBeDefined();
    expect(validateConfig(draft({ sourceName: "a\tb" })).sourceName).toBeDefined();
  });

  it("主机名是 RFC1123 子集：不含点，不以连字符开头或结尾", () => {
    for (const ok of ["core", "art-net-1", "A1"]) expect(validateConfig(draft({ hostname: ok })).hostname, ok).toBeUndefined();
    for (const bad of ["", "-a", "a-", "a.b", "a b", "主舞台", "a".repeat(64)]) {
      expect(validateConfig(draft({ hostname: bad })).hostname, bad).toBeDefined();
    }
  });

  it("DHCP 开启时不校验静态地址；关闭后必须合法且 IP 非 0", () => {
    expect(validateConfig(draft({ dhcp: true, ip: "garbage" }))).toEqual({});
    const r = validateConfig(draft({ dhcp: false, ip: "0.0.0.0", netmask: "255.255.255", gateway: "x" }));
    expect(r.ip).toBe("network.config.err.ipZero");
    expect(r.netmask).toBe("network.config.err.ipv4");
    expect(r.gateway).toBe("network.config.err.ipv4");
    expect(validateConfig(draft({ dhcp: false, ip: "10.0.0.9" }))).toEqual({});
  });
});

describe("isIpv4", () => {
  it("镜像固件 parse_ipv4", () => {
    expect(isIpv4("192.168.1.200")).toBe(true);
    expect(isIpv4("001.002.003.004")).toBe(true);
    for (const bad of ["1.2.3", "1.2.3.4.5", "256.1.1.1", "1..2.3", "a.b.c.d", "1.2.3.4 ", "1.2.3.4567"]) {
      expect(isIpv4(bad), bad).toBe(false);
    }
  });
});

describe("diffConfig / patchNeedsReboot", () => {
  it("只包含改动字段", () => {
    const o = toDraft(base);
    expect(diffConfig(o, draft())).toEqual({});
    const patch = diffConfig(o, draft({ sacnPriority: 150, hostname: "new-name" }));
    expect(patch).toEqual({ sacnPriority: 150, hostname: "new-name" });
  });

  it("网络字段需要重启，输出字段不需要", () => {
    expect(patchNeedsReboot({ hostname: "x" })).toBe(true);
    expect(patchNeedsReboot({ dhcp: false, ip: "10.0.0.2" })).toBe(true);
    expect(patchNeedsReboot({ sacnPriority: 10, uartOutputEnabled: false })).toBe(false);
    expect(patchNeedsReboot({})).toBe(false);
  });
});
