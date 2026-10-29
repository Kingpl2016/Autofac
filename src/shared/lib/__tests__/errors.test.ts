import { describe, expect, it } from "vitest";

import { errorMessage } from "../errors";

describe("errorMessage", () => {
  it("字符串原样、Error 取 message、结构化错误取 message", () => {
    expect(errorMessage("disk_full")).toBe("disk_full");
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage({ code: "busy", message: "设备忙" })).toBe("设备忙");
  });

  it("其它值转成字符串", () => {
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(null)).toBe("null");
    expect(errorMessage({ code: 1 })).toBe("[object Object]");
  });
});
