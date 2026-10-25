// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/shared/tauri/tauriStorage", () => ({
  createTauriPersistStorage: () => ({
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  }),
}));

import i18n from "@/shared/i18n";
import {
  describeConfigError,
  describeError,
  isConfigError,
  isManualError,
  isSenderError,
  protocolLabel,
} from "../errors";
import type { ConfigError } from "../types";

const t = i18n.t.bind(i18n);

beforeEach(async () => {
  await i18n.changeLanguage("zh");
});

describe("错误类型判断", () => {
  it("后端错误是带 code 的普通对象", () => {
    expect(isConfigError({ code: "invalidPort" })).toBe(true);
    expect(isConfigError({ code: "outOfRange", universe: 1, min: 0, max: 2 })).toBe(true);
    expect(isConfigError({ code: "socket", message: "x" })).toBe(false);
    expect(isConfigError(new Error("x"))).toBe(false);
    expect(isConfigError(null)).toBe(false);
    expect(isConfigError("invalidPort")).toBe(false);
    expect(isConfigError({ code: 3 })).toBe(false);

    expect(isSenderError({ code: "socket", message: "x" })).toBe(true);
    expect(isSenderError({ code: "invalidIp" })).toBe(false);
    expect(isManualError({ code: "channelOutOfRange", channel: 600 })).toBe(true);
    expect(isManualError({ code: "socket" })).toBe(false);
  });
});

describe("describeConfigError", () => {
  const cases: Array<[ConfigError, string]> = [
    [{ code: "invalidIp", value: "foo" }, "“foo”不是合法的 IPv4 地址"],
    [{ code: "invalidPort" }, "端口须是 1 到 65535 的整数"],
    [{ code: "emptyRange" }, "请填写 Universe 范围"],
    [{ code: "invalidRange", fragment: "x" }, "无法识别“x”，请写成 0-50 或 0-20,30 这样"],
    [{ code: "tooMany", count: 101, max: 100 }, "一次最多发送 100 个 Universe，当前是 101 个"],
  ];
  it.each(cases)("%j", (error, text) => {
    expect(describeConfigError(error, t, "artNet")).toBe(text);
  });

  it("越界提示带协议名：Art-Net 与 sACN 的范围不同", () => {
    const e: ConfigError = { code: "outOfRange", universe: 0, min: 1, max: 63999 };
    expect(describeConfigError(e, t, "sacn")).toBe("Universe 0 超出 sACN 允许的 1 到 63999");
  });

  it("切到英文后用英文", async () => {
    await i18n.changeLanguage("en");
    expect(describeConfigError({ code: "emptyRange" }, t, "artNet")).toBe("Enter a universe range");
  });
});

describe("describeError", () => {
  it("已知错误码走本地化，其余取原始信息", () => {
    expect(describeError({ code: "socket", message: "权限不足" }, t, "artNet")).toBe(
      "无法创建发送套接字：权限不足",
    );
    expect(describeError({ code: "channelOutOfRange", channel: 600 }, t, "artNet")).toBe(
      "通道号 600 超出 1 到 512",
    );
    expect(describeError(new Error("boom"), t, "artNet")).toBe("boom");
    expect(describeError("纯文本", t, "artNet")).toBe("纯文本");
  });

  it("协议显示名", () => {
    expect(protocolLabel("artNet")).toBe("Art-Net");
    expect(protocolLabel("sacn")).toBe("sACN");
  });
});
