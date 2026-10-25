import { describe, expect, it } from "vitest";

import { forwardingPrefillState, readForwardingPrefill } from "./prefill";

describe("readForwardingPrefill", () => {
  it("读出合法的预填并去掉 IP 两端空白", () => {
    const state = forwardingPrefillState({ name: "舞台左", targetIp: " 10.0.0.5 " });
    expect(readForwardingPrefill(state)).toEqual({ name: "舞台左", targetIp: "10.0.0.5" });
  });

  it("没有 state、没有 prefill 或 IP 为空时返回 null", () => {
    expect(readForwardingPrefill(null)).toBeNull();
    expect(readForwardingPrefill(undefined)).toBeNull();
    expect(readForwardingPrefill({})).toBeNull();
    expect(readForwardingPrefill({ prefill: { name: "x", targetIp: "  " } })).toBeNull();
    expect(readForwardingPrefill({ prefill: { name: "x" } })).toBeNull();
  });

  it("名称缺失时按空串处理", () => {
    expect(readForwardingPrefill({ prefill: { targetIp: "1.2.3.4" } })).toEqual({
      name: "",
      targetIp: "1.2.3.4",
    });
  });
});
