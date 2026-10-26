import { beforeEach, describe, expect, it } from "vitest";

import { EMPTY_PLAYBACK } from "../../lib/types";
import { usePlayerStore } from "../usePlayerStore";

const bytes = (...v: number[]) => Uint8Array.from(v);
const channels = () =>
  Object.fromEntries(
    Object.entries(usePlayerStore.getState().channels).map(([u, d]) => [u, [...d]]),
  );

beforeEach(() => usePlayerStore.setState({ status: EMPTY_PLAYBACK, channels: {} }));

describe("usePlayerStore.applyChannelFrame", () => {
  it("全量帧整体替换回放通道表，未出现的 Universe 被移除；空全量帧清空", () => {
    const { applyChannelFrame } = usePlayerStore.getState();
    applyChannelFrame({ full: true, entries: [{ universe: 5, data: bytes(1) }, { universe: 6, data: bytes(2) }] });
    expect(channels()).toEqual({ 5: [1], 6: [2] });

    applyChannelFrame({ full: true, entries: [{ universe: 7, data: bytes(3) }] });
    expect(channels()).toEqual({ 7: [3] });

    applyChannelFrame({ full: true, entries: [] });
    expect(channels()).toEqual({});
  });

  it("增量帧按条目合并，长度 0 删除该 Universe", () => {
    const { applyChannelFrame } = usePlayerStore.getState();
    applyChannelFrame({ full: true, entries: [{ universe: 5, data: bytes(1) }, { universe: 6, data: bytes(2) }] });
    applyChannelFrame({
      full: false,
      entries: [
        { universe: 6, data: bytes(20, 21) },
        { universe: 5, data: bytes() },
        { universe: 9, data: bytes(9) },
      ],
    });
    expect(channels()).toEqual({ 6: [20, 21], 9: [9] });
  });

  it("每帧只通知一次订阅者；空的增量帧不触发更新；clearChannels 清空", () => {
    const { applyChannelFrame, clearChannels } = usePlayerStore.getState();
    let notified = 0;
    const off = usePlayerStore.subscribe(() => {
      notified += 1;
    });
    applyChannelFrame({
      full: false,
      entries: [1, 2, 3].map((universe) => ({ universe, data: bytes(universe) })),
    });
    expect(notified).toBe(1);
    const before = usePlayerStore.getState().channels;
    applyChannelFrame({ full: false, entries: [] });
    expect(notified).toBe(1);
    expect(usePlayerStore.getState().channels).toBe(before);

    clearChannels();
    expect(channels()).toEqual({});
    off();
  });
});
