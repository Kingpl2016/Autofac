import { beforeEach, describe, expect, it } from "vitest";

import { EMPTY_STATUS, type ActivityDto } from "../../lib/types";
import { useRecordingStore } from "../useRecordingStore";

const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));

const delta = (over: Partial<ActivityDto> = {}): ActivityDto => ({
  generation: 0,
  bucketUs: 250_000,
  len: 2,
  from: 0,
  universes: [1],
  change: [b64([1, 2])],
  level: [b64([3, 4])],
  partStartsUs: [0],
  ...over,
});

beforeEach(() => {
  useRecordingStore.setState({ status: EMPTY_STATUS, activity: null, last: null });
});

describe("useRecordingStore 活动时间线", () => {
  it("全量 → 增量依次合并", () => {
    const s = useRecordingStore.getState();
    expect(s.applyActivity(delta())).toBe(true);
    expect(
      useRecordingStore.getState().applyActivity(delta({ from: 1, len: 3, change: [b64([5, 6])], level: [b64([7, 8])] })),
    ).toBe(true);
    const a = useRecordingStore.getState().activity!;
    expect([...a.change[0]]).toEqual([1, 5, 6]);
  });

  it("代次不一致时拒绝合并并保持本地数据，由调用方改拉全量", () => {
    const s = useRecordingStore.getState();
    s.applyActivity(delta());
    expect(useRecordingStore.getState().applyActivity(delta({ generation: 2, from: 1 }))).toBe(false);
    expect(useRecordingStore.getState().activity!.len).toBe(2);
    useRecordingStore.getState().setActivityFull(delta({ generation: 2, len: 1, change: [b64([9])], level: [b64([9])] }));
    expect(useRecordingStore.getState().activity!.generation).toBe(2);
  });

  it("新一次录制开始时清掉上一次的时间线；录制中的后续推送不清", () => {
    const s = useRecordingStore.getState();
    s.applyActivity(delta());
    s.setStatus({ ...EMPTY_STATUS, recording: true });
    expect(useRecordingStore.getState().activity).toBeNull();
    useRecordingStore.getState().applyActivity(delta());
    useRecordingStore.getState().setStatus({ ...EMPTY_STATUS, recording: true, elapsedUs: 1 });
    expect(useRecordingStore.getState().activity).not.toBeNull();
    // 停止后保留
    useRecordingStore.getState().setStatus(EMPTY_STATUS);
    expect(useRecordingStore.getState().activity).not.toBeNull();
  });
});
