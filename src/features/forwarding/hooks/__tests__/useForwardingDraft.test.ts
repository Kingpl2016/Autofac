// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import i18n from "@/shared/i18n";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
const api = vi.hoisted(() => ({ saveForwarding: vi.fn() }));

vi.mock("sonner", () => ({ toast }));
vi.mock("../../lib/api", async (orig) => ({
  ...(await orig<typeof import("../../lib/api")>()),
  ...api,
}));

import { newDestination, type ForwardDestination } from "../../lib/types";
import { AUTOSAVE_DELAY, useForwardingDraft } from "../useForwarding";

const dest = (id: string, name = id): ForwardDestination => ({
  ...newDestination(),
  id,
  name,
  targetIp: "10.0.0.5",
});

const initial = { destinations: [dest("a"), dest("b")] };

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  vi.clearAllMocks();
  vi.useFakeTimers();
  api.saveForwarding.mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

/** 推进定时器并等待保存的 Promise 落定。 */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("useForwardingDraft 自动保存", () => {
  it("连续修改在防抖结束后只保存一次，内容为最终草稿", async () => {
    const { result } = renderHook(() => useForwardingDraft(initial));
    act(() => result.current.toggle("a"));
    act(() => result.current.remove("b"));
    expect(result.current.status).toBe("pending");
    expect(api.saveForwarding).not.toHaveBeenCalled();

    await advance(AUTOSAVE_DELAY);
    expect(api.saveForwarding).toHaveBeenCalledTimes(1);
    const saved = api.saveForwarding.mock.calls[0][0] as { destinations: ForwardDestination[] };
    expect(saved.destinations).toHaveLength(1);
    expect(saved.destinations[0]).toMatchObject({ id: "a", enabled: false });
    expect(result.current.status).toBe("saved");
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it("保存成功后通知 onSaved，参数是刚保存的列表", async () => {
    const onSaved = vi.fn();
    const { result } = renderHook(() => useForwardingDraft(initial, { onSaved }));
    act(() => result.current.toggle("a"));
    await advance(AUTOSAVE_DELAY);
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect((onSaved.mock.calls[0][0] as ForwardDestination[]).map((d) => d.id)).toEqual(["a", "b"]);
  });

  it("没有改动时不保存", async () => {
    renderHook(() => useForwardingDraft(initial));
    await advance(AUTOSAVE_DELAY * 3);
    expect(api.saveForwarding).not.toHaveBeenCalled();
  });
});

describe("useForwardingDraft 卸载时落盘", () => {
  it("还有未保存的改动时，卸载立刻保存而不是丢弃", async () => {
    const { result, unmount } = renderHook(() => useForwardingDraft(initial));
    act(() => result.current.toggle("a"));
    expect(api.saveForwarding).not.toHaveBeenCalled();

    unmount();
    expect(api.saveForwarding).toHaveBeenCalledTimes(1);
    const saved = api.saveForwarding.mock.calls[0][0] as { destinations: ForwardDestination[] };
    expect(saved.destinations[0].enabled).toBe(false);

    // 之后防抖定时器不应再触发第二次保存
    await advance(AUTOSAVE_DELAY * 2);
    expect(api.saveForwarding).toHaveBeenCalledTimes(1);
  });

  it("改动已保存、或根本没有改动时，卸载不再保存", async () => {
    const first = renderHook(() => useForwardingDraft(initial));
    first.unmount();
    expect(api.saveForwarding).not.toHaveBeenCalled();

    const second = renderHook(() => useForwardingDraft(initial));
    act(() => second.result.current.toggle("a"));
    await advance(AUTOSAVE_DELAY);
    expect(api.saveForwarding).toHaveBeenCalledTimes(1);
    second.unmount();
    expect(api.saveForwarding).toHaveBeenCalledTimes(1);
  });
});

describe("useForwardingDraft 保存失败", () => {
  it("失败时提示错误、状态为 error，retry 成功后恢复", async () => {
    api.saveForwarding.mockRejectedValueOnce(new Error("磁盘已满"));
    const onSaved = vi.fn();
    const { result } = renderHook(() => useForwardingDraft(initial, { onSaved }));
    act(() => result.current.toggle("a"));
    await advance(AUTOSAVE_DELAY);

    expect(result.current.status).toBe("error");
    expect(toast.error).toHaveBeenCalledWith("磁盘已满");
    expect(onSaved).not.toHaveBeenCalled();

    await act(async () => {
      result.current.retry();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(api.saveForwarding).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe("saved");
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("失败后离开页面仍会再尝试保存一次", async () => {
    api.saveForwarding.mockRejectedValueOnce(new Error("boom"));
    const { result, unmount } = renderHook(() => useForwardingDraft(initial));
    act(() => result.current.toggle("a"));
    await advance(AUTOSAVE_DELAY);
    expect(api.saveForwarding).toHaveBeenCalledTimes(1);

    unmount();
    expect(api.saveForwarding).toHaveBeenCalledTimes(2);
  });

  it("保存进行中又有新改动时，状态保持待保存，随后再保存一次", async () => {
    let release: () => void = () => undefined;
    api.saveForwarding.mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const { result } = renderHook(() => useForwardingDraft(initial));
    act(() => result.current.toggle("a"));
    await advance(AUTOSAVE_DELAY);
    expect(result.current.status).toBe("saving");

    act(() => result.current.toggle("b"));
    await act(async () => {
      release();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.status).toBe("pending");

    await advance(AUTOSAVE_DELAY);
    expect(api.saveForwarding).toHaveBeenCalledTimes(2);
    const last = api.saveForwarding.mock.calls[1][0] as { destinations: ForwardDestination[] };
    expect(last.destinations.map((d) => d.enabled)).toEqual([false, false]);
    expect(result.current.status).toBe("saved");
  });
});

describe("useForwardingDraft 操作", () => {
  it("duplicate 使用本地化后缀并生成新 id", () => {
    const { result } = renderHook(() => useForwardingDraft(initial));
    act(() => result.current.duplicate("a"));
    const copy = result.current.destinations[2];
    expect(copy.name).toBe("a 副本");
    expect(copy.id).not.toBe("a");
    expect(result.current.destinations).toHaveLength(3);
  });

  it("英文界面使用英文后缀", async () => {
    await i18n.changeLanguage("en");
    const { result } = renderHook(() => useForwardingDraft(initial));
    act(() => result.current.duplicate("a"));
    expect(result.current.destinations[2].name).toBe("a (copy)");
  });

  it("upsert 区分新增与更新", () => {
    const { result } = renderHook(() => useForwardingDraft(initial));
    act(() => result.current.upsert({ ...dest("a"), name: "改名" }));
    expect(result.current.destinations.map((d) => d.name)).toEqual(["改名", "b"]);
    act(() => result.current.upsert(dest("c")));
    expect(result.current.destinations.map((d) => d.id)).toEqual(["a", "b", "c"]);
  });

  it("duplicate 不存在的 id 时什么也不做", () => {
    const { result } = renderHook(() => useForwardingDraft(initial));
    act(() => result.current.duplicate("nope"));
    expect(result.current.destinations).toHaveLength(2);
    expect(result.current.status).toBe("idle");
  });
});