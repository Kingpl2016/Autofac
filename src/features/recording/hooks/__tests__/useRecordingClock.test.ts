// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { EMPTY_STATUS, type RecordingStatus } from "../../lib/types";
import { useRecordingStore } from "../../stores/useRecordingStore";
import { CLOCK_TICK_MS, sessionBase, useRecordingClock } from "../useRecordingClock";

let now = 0;

const live = (over: Partial<RecordingStatus> = {}): RecordingStatus => ({
  ...EMPTY_STATUS,
  recording: true,
  path: "D:\\rec\\a.artrec",
  part: 1,
  elapsedUs: 10_000_000,
  sessionElapsedUs: 10_000_000,
  partStartsUs: [0],
  ...over,
});

beforeEach(() => {
  now = 5000;
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  vi.spyOn(performance, "now").mockImplementation(() => now);
  useRecordingStore.setState({ status: EMPTY_STATUS, statusAt: 0, activity: null });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useRecordingClock", () => {
  it("两次推送之间平滑外推，超过 1 秒没有推送就冻结", () => {
    useRecordingStore.setState({ status: live(), statusAt: 5000 });
    const { result } = renderHook(() => useRecordingClock());
    expect(result.current.sessionUs).toBe(10_000_000);

    now = 5300;
    act(() => vi.advanceTimersByTime(CLOCK_TICK_MS));
    expect(result.current.sessionUs).toBe(10_300_000);

    now = 9000; // 后端 4 秒没推送
    act(() => vi.advanceTimersByTime(CLOCK_TICK_MS));
    expect(result.current.sessionUs).toBe(11_000_000);
  });

  it("新推送略小于外推值时不回跳；分段时长按最后一个分段起点计算", () => {
    useRecordingStore.setState({ status: live(), statusAt: 5000 });
    const { result } = renderHook(() => useRecordingClock());
    now = 5800;
    act(() => vi.advanceTimersByTime(CLOCK_TICK_MS));
    expect(result.current.sessionUs).toBe(10_800_000);

    act(() =>
      useRecordingStore.setState({
        status: live({ sessionElapsedUs: 10_700_000, partStartsUs: [0, 10_000_000], part: 2 }),
        statusAt: 5800,
      }),
    );
    expect(result.current.sessionUs).toBe(10_800_000);
    expect(result.current.partUs).toBe(800_000);
  });

  it("未录制时直接返回后端值", () => {
    useRecordingStore.setState({
      status: { ...EMPTY_STATUS, elapsedUs: 3_000_000, sessionElapsedUs: 3_000_000 },
      statusAt: 0,
    });
    const { result } = renderHook(() => useRecordingClock());
    now = 99_999;
    act(() => vi.advanceTimersByTime(CLOCK_TICK_MS * 5));
    expect(result.current.sessionUs).toBe(3_000_000);
  });

  it("会话时长不小于分段时长（旧版后端缺字段时回落）", () => {
    expect(sessionBase(live({ sessionElapsedUs: 0, elapsedUs: 7 }))).toBe(7);
    expect(sessionBase(live({ sessionElapsedUs: 9, elapsedUs: 7 }))).toBe(9);
  });
});
