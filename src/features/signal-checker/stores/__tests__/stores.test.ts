// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/shared/tauri/tauriStorage", () => ({
  createTauriPersistStorage: () => ({
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  }),
}));

import { DEFAULTS, sanitizeFormData, useCheckerFormStore } from "../useCheckerFormStore";
import { useSenderStore } from "../useSenderStore";

describe("sanitizeFormData：磁盘数据不可信", () => {
  it("合法数据原样通过", () => {
    const raw = {
      draft: { targetIp: "10.0.0.5", port: "5568", protocol: "sacn", universes: "1-4" },
      mode: "manual",
      pattern: "chase",
      speed: 2,
    };
    expect(sanitizeFormData(raw, DEFAULTS)).toEqual(raw);
  });

  it("任何字段不合法都回落到当前值", () => {
    const out = sanitizeFormData(
      {
        draft: { targetIp: 5, port: null, protocol: "udp", universes: ["0"] },
        mode: "both",
        pattern: "disco",
        speed: 3, // 不在档位里
      },
      DEFAULTS,
    );
    expect(out).toEqual(DEFAULTS);
  });

  it("空值、缺字段、非对象都不抛错", () => {
    for (const raw of [null, undefined, {}, "x", 42, []]) {
      expect(sanitizeFormData(raw, DEFAULTS)).toEqual(DEFAULTS);
    }
    expect(sanitizeFormData({ draft: { targetIp: "1.2.3.4" } }, DEFAULTS).draft).toEqual({
      ...DEFAULTS.draft,
      targetIp: "1.2.3.4",
    });
  });
});

describe("useCheckerFormStore", () => {
  beforeEach(() => useCheckerFormStore.setState({ ...DEFAULTS }));

  it("setDraft 只合并给出的字段", () => {
    useCheckerFormStore.getState().setDraft({ port: "5568" });
    expect(useCheckerFormStore.getState().draft).toEqual({ ...DEFAULTS.draft, port: "5568" });
  });

  it("模式 / 图案 / 倍速各自独立", () => {
    const s = useCheckerFormStore.getState();
    s.setMode("manual");
    s.setPattern("rainbow");
    s.setSpeed(0.5);
    expect(useCheckerFormStore.getState()).toMatchObject({ mode: "manual", pattern: "rainbow", speed: 0.5 });
  });
});

describe("useSenderStore 的错误", () => {
  beforeEach(() => useSenderStore.setState({ error: null }));

  it("每条错误有递增的 id，clearError(id) 只清除对应那一条", () => {
    const { pushError, clearError } = useSenderStore.getState();
    pushError({ universe: 1, message: "a" });
    const first = useSenderStore.getState().error!;
    pushError({ universe: 1, message: "a" });
    const second = useSenderStore.getState().error!;
    expect(second.id).toBeGreaterThan(first.id);

    clearError(first.id); // 旧定时器：不应误关新的这条
    expect(useSenderStore.getState().error).toEqual(second);
    clearError(second.id);
    expect(useSenderStore.getState().error).toBeNull();
  });

  it("不带 id 的 clearError 无条件清除", () => {
    useSenderStore.getState().pushError({ universe: null, message: "x" });
    useSenderStore.getState().clearError();
    expect(useSenderStore.getState().error).toBeNull();
  });
});
