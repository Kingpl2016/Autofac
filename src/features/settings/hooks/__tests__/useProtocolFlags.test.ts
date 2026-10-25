// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const query = vi.hoisted(() => ({
  data: undefined as { protocol: { sacnEnabled: boolean } } | undefined,
}));

vi.mock("../useSettings", () => ({
  useSettingsQuery: () => ({ data: query.data }),
}));

import { useProtocolFlags } from "../useProtocolFlags";

describe("useProtocolFlags", () => {
  it("配置尚未加载时按关闭处理，避免 sACN 内容闪现", () => {
    query.data = undefined;
    const { result } = renderHook(() => useProtocolFlags());
    expect(result.current.sacnEnabled).toBe(false);
  });

  it("跟随设置里的 sACN 开关", () => {
    query.data = { protocol: { sacnEnabled: true } };
    const { result, rerender } = renderHook(() => useProtocolFlags());
    expect(result.current.sacnEnabled).toBe(true);

    query.data = { protocol: { sacnEnabled: false } };
    rerender();
    expect(result.current.sacnEnabled).toBe(false);
  });
});
