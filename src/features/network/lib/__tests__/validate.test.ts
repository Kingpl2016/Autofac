import { describe, expect, it } from "vitest";

import { validateHost, validateName, validatePort, validateToken } from "../validate";

describe("validateHost", () => {
  it("接受 IPv4 与主机名", () => {
    for (const ok of ["192.168.1.20", " 10.0.0.1 ", "artnet-core.local", "core1"]) {
      expect(validateHost(ok), ok).toBeNull();
    }
  });

  it("拒绝空值、协议、端口、路径与非法 IP", () => {
    expect(validateHost("  ")).toBe("network.form.hostRequired");
    for (const bad of ["http://1.2.3.4", "1.2.3.4:80", "a/b", "999.1.1.1", "1.2.3", "-a", "a..b", "a b"]) {
      expect(validateHost(bad), bad).toBe("network.form.hostInvalid");
    }
  });
});

describe("其它字段", () => {
  it("端口范围", () => {
    expect(validatePort(80)).toBeNull();
    expect(validatePort(0)).not.toBeNull();
    expect(validatePort(65_536)).not.toBeNull();
    expect(validatePort(80.5)).not.toBeNull();
    expect(validatePort(Number.NaN)).not.toBeNull();
  });

  it("名称长度按字符计", () => {
    expect(validateName("")).toBeNull();
    expect(validateName("主".repeat(40))).toBeNull();
    expect(validateName("主".repeat(41))).not.toBeNull();
  });

  it("Token 为空或 8~64 位可见 ASCII", () => {
    expect(validateToken("")).toBeNull();
    expect(validateToken("abcd1234")).toBeNull();
    expect(validateToken("short")).not.toBeNull();
    expect(validateToken("has space 123")).not.toBeNull();
    expect(validateToken("中文中文中文中文")).not.toBeNull();
    expect(validateToken("x".repeat(65))).not.toBeNull();
  });
});
