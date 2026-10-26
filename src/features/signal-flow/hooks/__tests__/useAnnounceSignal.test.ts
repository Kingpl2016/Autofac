// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";

import i18n from "@/shared/i18n";
import { useAnnouncerStore } from "@/shared/stores/announcerStore";
import type { SignalItem } from "../../lib/signalChanges";
import { useAnnounceSignal } from "../useAnnounceSignal";

const item = (key: string, active: boolean, kind: SignalItem["kind"] = "source", label = key): SignalItem => ({
  key,
  kind,
  label,
  active,
});
const message = () => useAnnouncerStore.getState().message;
const seq = () => useAnnouncerStore.getState().seq;

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  useAnnouncerStore.setState({ message: "", seq: 0 });
});

describe("useAnnounceSignal", () => {
  it("首次渲染不播报", () => {
    renderHook(() => useAnnounceSignal([item("a", true)]));
    expect(seq()).toBe(0);
  });

  it("有信号 / 信号中断各播报一次，来源与目的地带类型前缀", () => {
    const { rerender } = renderHook(({ items }) => useAnnounceSignal(items), {
      initialProps: {
        items: [item("src:10.0.0.1", true, "source", "10.0.0.1"), item("dst:a", false, "destination", "舞台左")],
      },
    });
    rerender({
      items: [item("src:10.0.0.1", false, "source", "10.0.0.1"), item("dst:a", true, "destination", "舞台左")],
    });
    expect(seq()).toBe(1);
    expect(message()).toBe("有信号：目的地 舞台左，信号中断：来源 10.0.0.1");
  });

  it("状态没变时（数值刷新）不播报", () => {
    const { rerender } = renderHook(({ items }) => useAnnounceSignal(items), {
      initialProps: { items: [item("a", true)] },
    });
    rerender({ items: [item("a", true)] });
    rerender({ items: [item("a", true)] });
    expect(seq()).toBe(0);
  });

  it("同一次变化很多时只念前 3 个并折叠", () => {
    const keys = ["a", "b", "c", "d", "e"];
    const { rerender } = renderHook(({ items }) => useAnnounceSignal(items), {
      initialProps: { items: keys.map((k) => item(k, false)) },
    });
    rerender({ items: keys.map((k) => item(k, true)) });
    expect(message()).toBe("有信号：来源 a，来源 b，来源 c 等 2 项");
  });

  it("传 null（离开列表视图）会清除记忆：回来时不播报期间累计的变化", () => {
    const { rerender } = renderHook(({ items }) => useAnnounceSignal(items), {
      initialProps: { items: [item("a", false)] as SignalItem[] | null },
    });
    rerender({ items: null });
    rerender({ items: [item("a", true)] });
    expect(seq()).toBe(0);
  });

  it("英文界面使用英文文案", async () => {
    await i18n.changeLanguage("en");
    const { rerender } = renderHook(({ items }) => useAnnounceSignal(items), {
      initialProps: { items: [item("a", false, "destination", "Left")] },
    });
    rerender({ items: [item("a", true, "destination", "Left")] });
    expect(message()).toBe("Signal on: destination Left");
  });
});