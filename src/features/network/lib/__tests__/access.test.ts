import { describe, expect, it } from "vitest";

import { countFleet, deriveAccess, deriveLinkState, worstLink, type AccessInput, type LinkInput } from "../access";

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

const link: LinkInput = { rebooting: false, online: false, errorCode: null, loading: false };

describe("deriveLinkState", () => {
  it("优先级：重启中 → 在线 → 需要 Token → 检测中 → 离线", () => {
    expect(deriveLinkState({ ...link, rebooting: true, online: true })).toBe("rebooting");
    expect(deriveLinkState({ ...link, online: true, errorCode: "unauthorized" })).toBe("online");
    expect(deriveLinkState({ ...link, errorCode: "unauthorized", loading: true })).toBe("needToken");
    expect(deriveLinkState({ ...link, loading: true })).toBe("checking");
    expect(deriveLinkState({ ...link, errorCode: "network" })).toBe("offline");
  });
});

describe("机群汇总", () => {
  it("countFleet 分类计数，检测中与重启中合并为 pending", () => {
    expect(countFleet(["online", "online", "needToken", "offline", "checking", "rebooting"])).toEqual({
      total: 6,
      online: 2,
      needToken: 1,
      offline: 1,
      pending: 2,
    });
    expect(countFleet([])).toEqual({ total: 0, online: 0, needToken: 0, offline: 0, pending: 0 });
  });

  it("worstLink 取最需要关注的状态", () => {
    expect(worstLink(["online", "offline", "needToken"])).toBe("needToken");
    expect(worstLink(["online", "rebooting", "offline"])).toBe("offline");
    expect(worstLink(["online", "checking"])).toBe("checking");
    expect(worstLink(["online"])).toBe("online");
    expect(worstLink([])).toBeNull();
  });
});
