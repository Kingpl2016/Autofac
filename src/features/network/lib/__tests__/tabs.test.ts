import { describe, expect, it } from "vitest";

import { isLegacyTabParam, parseTab } from "../tabs";

describe("parseTab", () => {
  it("新版一级 Tab 原样返回，非法值回退到文件", () => {
    expect(parseTab("control")).toBe("control");
    expect(parseTab("config")).toBe("config");
    expect(parseTab("diag")).toBe("diag");
    expect(parseTab("firmware")).toBe("firmware");
    expect(parseTab(null)).toBe("files");
    expect(parseTab("bogus")).toBe("files");
  });

  it("兼容旧链接：tab=commands 按 sub 映射，日志并入诊断", () => {
    expect(parseTab("commands", null)).toBe("control");
    expect(parseTab("commands", "control")).toBe("control");
    expect(parseTab("commands", "config")).toBe("config");
    expect(parseTab("commands", "diag")).toBe("diag");
    expect(parseTab("commands", "logs")).toBe("diag");
    expect(parseTab("commands", "bogus")).toBe("control");
  });

  it("isLegacyTabParam：带 commands 或 sub 的地址需要改写", () => {
    expect(isLegacyTabParam("commands", null)).toBe(true);
    expect(isLegacyTabParam("files", "diag")).toBe(true);
    expect(isLegacyTabParam("config", null)).toBe(false);
    expect(isLegacyTabParam(null, null)).toBe(false);
  });
});
