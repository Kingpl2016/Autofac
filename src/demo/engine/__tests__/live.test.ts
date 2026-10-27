import { describe, expect, it } from "vitest";

import { decodeDmxFrame, DMX_KIND_LIVE, type DmxFrame } from "@/shared/lib/dmxFrame";
import { loadDemoData } from "../../data";
import { EventBus } from "../../lib/eventBus";
import { createStreamHub } from "../../lib/streamHub";
import { createLiveEngine } from "../live";
import type { World } from "../world";

/** 最小的演示世界：实时模式、设置取自演示数据。 */
function makeWorld(): World {
  const data = loadDemoData();
  return {
    bus: new EventBus(),
    stream: createStreamHub(),
    data,
    mode: { mode: "live", receivers: "bound", sender: "ready" },
    elapsedMs: () => 0,
    uptimeMs: () => 0,
    log: () => undefined,
    hooks: {
      isRecording: () => false,
      playerLoaded: () => false,
      showOutputting: () => false,
      closePlayer: () => undefined,
      enterPlayerMode: () => undefined,
      settings: () => data.settings,
      recordingDir: () => "",
      currentDiskFree: () => 0,
      programMoved: () => undefined,
    },
  };
}

/** 帧条目摘要：`[universe, 通道数据长度]`。 */
const summary = (f: DmxFrame) => f.entries.map((e) => [e.universe, e.data.length]);

describe("演示实时引擎的二进制通道流", () => {
  it("首帧全量，之后只推变化；停止接收时推 len=0；满 1 秒全量兜底；无订阅者不推", () => {
    const world = makeWorld();
    const live = createLiveEngine(world);

    const frames: DmxFrame[] = [];
    const off = world.stream.subscribe((buf) => {
      const f = decodeDmxFrame(buf);
      if (f) frames.push(f);
    });
    // Universe 4（静态）与 7（全黑）数据不随时间变化；999 不存在
    void live.commands.set_viewed_universes({ universes: [4, 7, 999] });

    live.tick?.({ dtMs: 33, elapsedMs: 0 });
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ kind: DMX_KIND_LIVE, full: true });
    expect(summary(frames[0])).toEqual([[4, 512], [7, 512]]);
    expect(frames[0].entries[0].data[0]).toBe(200);

    // 数据没变：不推
    live.tick?.({ dtMs: 33, elapsedMs: 33 });
    expect(frames).toHaveLength(1);

    // 进入播放器模式：接收停止，增量帧逐个给出 len = 0
    world.mode.mode = "player";
    live.tick?.({ dtMs: 33, elapsedMs: 66 });
    expect(frames).toHaveLength(2);
    expect(frames[1].full).toBe(false);
    expect(summary(frames[1])).toEqual([[4, 0], [7, 0]]);

    // 满 1 秒：全量兜底（此时没有任何数据，是一个空的全量帧）
    live.tick?.({ dtMs: 33, elapsedMs: 1000 });
    expect(frames).toHaveLength(3);
    expect(frames[2]).toMatchObject({ full: true, entries: [] });

    off();
    live.tick?.({ dtMs: 33, elapsedMs: 3000 });
    expect(frames).toHaveLength(3);
  });

  it("查看集合变化与新订阅都会触发全量帧", () => {
    const world = makeWorld();
    const live = createLiveEngine(world);
    const frames: DmxFrame[] = [];
    const subscribe = () =>
      world.stream.subscribe((buf) => {
        const f = decodeDmxFrame(buf);
        if (f) frames.push(f);
      });
    const off = subscribe();
    void live.commands.set_viewed_universes({ universes: [4] });
    live.tick?.({ dtMs: 33, elapsedMs: 0 });
    live.tick?.({ dtMs: 33, elapsedMs: 33 });
    expect(frames.map((f) => f.full)).toEqual([true]);

    void live.commands.set_viewed_universes({ universes: [7, 4] });
    live.tick?.({ dtMs: 33, elapsedMs: 66 });
    expect(frames[1].full).toBe(true);
    expect(summary(frames[1])).toEqual([[7, 512], [4, 512]]);

    // 严格模式式的“取消 → 再订阅”：新订阅收到全量帧，旧订阅不再收到
    off();
    subscribe();
    live.tick?.({ dtMs: 33, elapsedMs: 99 });
    expect(frames).toHaveLength(3);
    expect(frames[2].full).toBe(true);
  });
});
