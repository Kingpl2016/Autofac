import { beforeEach, describe, expect, it } from "vitest";

import { useEngineDataStore } from "../engineDataStore";

const bytes = (...v: number[]) => Uint8Array.from(v);
const channels = () =>
  Object.fromEntries(
    Object.entries(useEngineDataStore.getState().channels).map(([u, d]) => [u, [...d]]),
  );

beforeEach(() => useEngineDataStore.setState({ channels: {} }));

describe("engineDataStore.applyChannelFrame", () => {
  it("全量帧整体替换通道表，未出现的 Universe 被移除", () => {
    const { applyChannelFrame } = useEngineDataStore.getState();
    applyChannelFrame({ full: true, entries: [{ universe: 1, data: bytes(1) }, { universe: 2, data: bytes(2) }] });
    expect(channels()).toEqual({ 1: [1], 2: [2] });

    applyChannelFrame({ full: true, entries: [{ universe: 3, data: bytes(3) }] });
    expect(channels()).toEqual({ 3: [3] });

    applyChannelFrame({ full: true, entries: [] });
    expect(channels()).toEqual({});
  });

  it("增量帧按条目合并，长度 0 删除该 Universe", () => {
    const { applyChannelFrame } = useEngineDataStore.getState();
    applyChannelFrame({ full: true, entries: [{ universe: 1, data: bytes(1) }, { universe: 2, data: bytes(2) }] });
    applyChannelFrame({
      full: false,
      entries: [
        { universe: 2, data: bytes(20, 21) },
        { universe: 1, data: bytes() },
        { universe: 5, data: bytes(5) },
      ],
    });
    expect(channels()).toEqual({ 2: [20, 21], 5: [5] });
  });

  it("每帧只通知一次订阅者；空的增量帧不触发更新", () => {
    const { applyChannelFrame } = useEngineDataStore.getState();
    let notified = 0;
    const off = useEngineDataStore.subscribe(() => {
      notified += 1;
    });
    applyChannelFrame({
      full: false,
      entries: [1, 2, 3, 4].map((universe) => ({ universe, data: bytes(universe) })),
    });
    expect(notified).toBe(1);
    const before = useEngineDataStore.getState().channels;
    applyChannelFrame({ full: false, entries: [] });
    expect(notified).toBe(1);
    expect(useEngineDataStore.getState().channels).toBe(before);
    off();
  });
});
