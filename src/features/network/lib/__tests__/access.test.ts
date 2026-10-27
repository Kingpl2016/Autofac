import { describe, expect, it } from "vitest";

import { deriveAccess, type AccessInput } from "../access";

const base: AccessInput = {
  hasDevice: true,
  checking: false,
  online: true,
  error: null,
  rebooting: false,
};

describe("deriveAccess", () => {
  it("没有设备", () => {
    expect(deriveAccess({ ...base, hasDevice: false }).state).toBe("none");
  });

  it("在线：默认可读可写（无论设备是否配置 Token）", () => {
    expect(deriveAccess(base)).toEqual({ state: "ok", canRead: true, canWrite: true });
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
