// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import i18n from "@/shared/i18n";
import { errorText, isCancelled, isUnauthorized, toNetError } from "../errors";

beforeEach(async () => {
  await i18n.changeLanguage("zh");
});

describe("toNetError", () => {
  it("原样保留后端的 { code, message }", () => {
    expect(toNetError({ code: "busy", message: "忙" })).toEqual({ code: "busy", message: "忙" });
  });

  it("把字符串与 Error 规整为 unknown", () => {
    expect(toNetError("boom")).toEqual({ code: "unknown", message: "boom" });
    expect(toNetError(new Error("bad"))).toEqual({ code: "unknown", message: "bad" });
    expect(toNetError(42).code).toBe("unknown");
  });

  it("缺少字段的对象不会被当成后端错误", () => {
    expect(toNetError({ code: "busy" }).code).toBe("unknown");
  });
});

describe("errorText", () => {
  it("已知错误码走国际化文案", () => {
    const t = i18n.getFixedT("zh");
    expect(errorText(t, { code: "wrong_mode", message: "x" })).toContain("工作模式");
    expect(errorText(t, { code: "no_space", message: "x" })).toContain("空间不足");
  });

  it("本地校验与未知错误显示后端描述", () => {
    const t = i18n.getFixedT("zh");
    expect(errorText(t, { code: "invalid", message: "文件名须以 .artrec 结尾" })).toBe("文件名须以 .artrec 结尾");
    expect(errorText(t, "原始字符串")).toBe("原始字符串");
  });

  it("英文下也有文案", () => {
    const t = i18n.getFixedT("en");
    expect(errorText(t, { code: "unauthorized", message: "x" })).toContain("authentication");
  });
});

describe("判定函数", () => {
  it("识别取消与未授权", () => {
    expect(isCancelled({ code: "cancelled", message: "" })).toBe(true);
    expect(isCancelled({ code: "busy", message: "" })).toBe(false);
    expect(isUnauthorized({ code: "unauthorized", message: "" })).toBe(true);
  });
});
