import { describe, expect, it } from "vitest";

import { deriveAccess, type AccessInput } from "../access";

const base: AccessInput = {
  hasDevice: true,
  checking: false,
  online: true,
  error: null,
  config: { tokenSet: true },
  rebooting: false,
  forceWrite: false,
};

describe("deriveAccess", () => {
  it("没有设备", () => {
    expect(deriveAccess({ ...base, hasDevice: false }).state).toBe("none");
  });

  it("在线且已配置 Token：可读可写", () => {
    expect(deriveAccess(base)).toEqual({ state: "ok", canRead: true, canWrite: true });
  });

  it("设备没配置 Token：只读；选择仍然尝试后可写", () => {
    const cfg = { tokenSet: false };
    expect(deriveAccess({ ...base, config: cfg })).toEqual({ state: "readonly", canRead: true, canWrite: false });
    expect(deriveAccess({ ...base, config: cfg, forceWrite: true }).canWrite).toBe(true);
  });

  it("配置尚未取到时不提前判定只读", () => {
    expect(deriveAccess({ ...base, config: null }).state).toBe("ok");
  });

  it("未授权优先于离线", () => {
    const r = deriveAccess({ ...base, online: false, error: { code: "unauthorized", message: "" } });
    expect(r.state).toBe("needToken");
    expect(r.canRead).toBe(false);
  });

  it("离线与首次检测", () => {
    expect(deriveAccess({ ...base, online: false, error: { code: "network", message: "" } }).state).toBe("offline");
    expect(deriveAccess({ ...base, online: false, checking: true }).state).toBe("checking");
  });

  it("重启中压过其它状态", () => {
    expect(deriveAccess({ ...base, rebooting: true, online: false }).state).toBe("rebooting");
    expect(deriveAccess({ ...base, rebooting: true }).canWrite).toBe(false);
  });
});
