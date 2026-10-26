import { describe, expect, it } from "vitest";

import { firstError, hasErrors, validateDestination } from "../validate";
import { newDestination, type ForwardDestination } from "../types";

const ok = (over: Partial<ForwardDestination> = {}): ForwardDestination => ({
  ...newDestination(),
  name: "舞台左",
  targetIp: "10.0.0.5",
  ...over,
});

describe("validateDestination", () => {
  it("合法目的地没有错误", () => {
    const e = validateDestination(ok());
    expect(hasErrors(e)).toBe(false);
    expect(firstError(e)).toBeNull();
  });

  it("名称只含空白视为未填", () => {
    expect(validateDestination(ok({ name: "   " })).fields.name).toBe("nameRequired");
  });

  it("目标 IP：必填且必须是 IPv4，忽略首尾空白", () => {
    expect(validateDestination(ok({ targetIp: "" })).fields.targetIp).toBe("ipRequired");
    expect(validateDestination(ok({ targetIp: "  " })).fields.targetIp).toBe("ipRequired");
    for (const bad of ["10.0.0", "256.0.0.1", "a.b.c.d", "::1", "10.0.0.1:6454"]) {
      expect(validateDestination(ok({ targetIp: bad })).fields.targetIp, bad).toBe("ipInvalid");
    }
    expect(validateDestination(ok({ targetIp: " 10.0.0.5 " })).fields.targetIp).toBeUndefined();
  });

  it("端口范围 1 到 65535 且为整数", () => {
    for (const p of [0, -1, 65536, 1.5, Number.NaN]) {
      expect(validateDestination(ok({ port: p })).fields.port, String(p)).toBe("portInvalid");
    }
    expect(validateDestination(ok({ port: 1 })).fields.port).toBeUndefined();
    expect(validateDestination(ok({ port: 65535 })).fields.port).toBeUndefined();
  });

  it("Universe 偏移：整数，绝对值不超过 65535", () => {
    expect(validateDestination(ok({ universeOffset: -100 })).fields.universeOffset).toBeUndefined();
    expect(validateDestination(ok({ universeOffset: 65535 })).fields.universeOffset).toBeUndefined();
    expect(validateDestination(ok({ universeOffset: 65536 })).fields.universeOffset).toBe("offsetInvalid");
    expect(validateDestination(ok({ universeOffset: -65536 })).fields.universeOffset).toBe("offsetInvalid");
    expect(validateDestination(ok({ universeOffset: 0.5 })).fields.universeOffset).toBe("offsetInvalid");
  });

  it("默认延迟 0 到 2000 ms", () => {
    expect(validateDestination(ok({ defaultDelayMs: 2000 })).fields.defaultDelayMs).toBeUndefined();
    expect(validateDestination(ok({ defaultDelayMs: 2001 })).fields.defaultDelayMs).toBe("delayInvalid");
    expect(validateDestination(ok({ defaultDelayMs: -1 })).fields.defaultDelayMs).toBe("delayInvalid");
  });

  it("覆盖规则按下标报告各字段错误", () => {
    const e = validateDestination(
      ok({
        overrides: [
          { sourceUniverse: 1, action: "forward", targetUniverse: null, delayMs: null },
          { sourceUniverse: 70000, action: "forward", targetUniverse: -1, delayMs: 3000 },
        ],
      }),
    );
    expect(e.overrides[0]).toBeUndefined();
    expect(e.overrides[1]).toEqual({
      sourceUniverse: "overrideSource",
      targetUniverse: "overrideTarget",
      delayMs: "overrideDelay",
    });
    expect(hasErrors(e)).toBe(true);
  });

  it("firstError 先报目的地字段，再报覆盖规则", () => {
    const both = validateDestination(
      ok({
        port: 0,
        overrides: [{ sourceUniverse: -1, action: "forward" }],
      }),
    );
    expect(firstError(both)).toEqual({ field: "port", code: "portInvalid" });

    const onlyOverride = validateDestination(
      ok({ overrides: [{ sourceUniverse: -1, action: "forward" }] }),
    );
    expect(firstError(onlyOverride)).toEqual({ field: "overrides[0]", code: "overrideSource" });
  });
});