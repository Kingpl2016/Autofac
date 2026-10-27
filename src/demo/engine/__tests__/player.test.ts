import { describe, expect, it } from "vitest";

import {
  decodeDmxFrame,
  DMX_KIND_LIVE,
  DMX_KIND_PLAYBACK,
  type DmxFrame,
} from "@/shared/lib/dmxFrame";
import { loadDemoData } from "../../data";
import { EventBus } from "../../lib/eventBus";
import { createStreamHub } from "../../lib/streamHub";
import { createForwardingModule } from "../forwarding";
import { createLibrary } from "../library";
import { createLiveEngine } from "../live";
import { createPlayerModule } from "../player";
import type { World } from "../world";

/** 最小的演示世界：时钟由测试推进。 */
function makeWorld(clock: { ms: number }): World {
  const data = loadDemoData();
  return {
    bus: new EventBus(),
    stream: createStreamHub(),
    data,
    mode: { mode: "live", receivers: "bound", sender: "ready" },
    elapsedMs: () => clock.ms,
    uptimeMs: () => clock.ms,
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

/** 装配回放模块，返回它与预置节目“开场秀 Act 1”（U0 前 30 秒静态、U2 正弦渐变）的路径。 */
function setup() {
  const clock = { ms: 0 };
  const world = makeWorld(clock);
  const library = createLibrary(world.data.recordings.programs, world.data.app.recordingDir);
  const player = createPlayerModule(world, library, createForwardingModule(world));
  const path = library.all().find((r) => r.entry.fileName === "开场秀-Act1.artrec")!.entry.path;
  return { clock, world, player, path };
}

/** 订阅通道流，收到的帧解码后记进列表。 */
function record(world: World): { frames: DmxFrame[]; off: () => void } {
  const frames: DmxFrame[] = [];
  const off = world.stream.subscribe((buf) => {
    const f = decodeDmxFrame(buf);
    if (f) frames.push(f);
  });
  return { frames, off };
}

/** 帧条目摘要：`[universe, 通道数据长度]`。 */
const summary = (f: DmxFrame) => f.entries.map((e) => [e.universe, e.data.length]);

describe("演示回放模块的二进制通道流", () => {
  it("全量帧之后只推变化；新订阅推全量；关闭节目推空的全量帧；不再发 player:channels", () => {
    const { clock, world, player, path } = setup();
    const emitted: string[] = [];
    const offBus = world.bus.on("player:channels", () => emitted.push("player:channels"));
    const { frames } = record(world);

    void player.commands.player_open({ path });
    // 999 不在节目里：始终被忽略
    void player.commands.player_set_viewed({ universes: [0, 2, 999] });
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ kind: DMX_KIND_PLAYBACK, full: true });
    expect(summary(frames[0])).toEqual([[0, 512], [2, 512]]);
    expect(frames[0].entries[0].data[0]).toBe(60);

    // 停止态的空闲兜底：数据没变，不推
    player.tick?.({ dtMs: 33, elapsedMs: 0 });
    expect(frames).toHaveLength(1);

    // 播放：U0 静态不变，只推正弦渐变的 U2
    void player.commands.player_play({});
    clock.ms = 33;
    player.tick?.({ dtMs: 33, elapsedMs: 33 });
    expect(frames).toHaveLength(2);
    expect(frames[1].full).toBe(false);
    expect(summary(frames[1])).toEqual([[2, 512]]);

    // 新订阅（如前端重载）：下一帧为全量
    record(world);
    clock.ms = 66;
    player.tick?.({ dtMs: 33, elapsedMs: 66 });
    expect(frames[2].full).toBe(true);
    expect(summary(frames[2])).toEqual([[0, 512], [2, 512]]);

    void player.commands.player_close({});
    expect(frames.at(-1)).toEqual({ kind: DMX_KIND_PLAYBACK, full: true, entries: [] });
    expect(emitted).toEqual([]);
    offBus();
  });

  it("查看集合变化推全量；没有订阅者时不推", () => {
    const { clock, world, player, path } = setup();
    void player.commands.player_open({ path });
    void player.commands.player_set_viewed({ universes: [0] });
    void player.commands.player_play({});

    const { frames, off } = record(world);
    clock.ms = 33;
    player.tick?.({ dtMs: 33, elapsedMs: 33 });
    expect(frames.map((f) => f.full)).toEqual([true]);

    void player.commands.player_set_viewed({ universes: [2, 0] });
    expect(frames).toHaveLength(2);
    expect(frames[1].full).toBe(true);
    expect(summary(frames[1])).toEqual([[2, 512], [0, 512]]);

    off();
    clock.ms = 2000;
    player.tick?.({ dtMs: 33, elapsedMs: 2000 });
    void player.commands.player_close({});
    expect(frames).toHaveLength(2);
  });

  it("实时引擎与回放模块推送到同一个订阅者", () => {
    const { clock, world, player, path } = setup();
    const live = createLiveEngine(world);
    const { frames } = record(world);
    void live.commands.set_viewed_universes({ universes: [4] });
    live.tick?.({ dtMs: 33, elapsedMs: 0 });

    void player.commands.player_open({ path });
    void player.commands.player_set_viewed({ universes: [0] });
    clock.ms = 33;
    player.tick?.({ dtMs: 33, elapsedMs: 33 });

    expect(frames.map((f) => f.kind)).toEqual([DMX_KIND_LIVE, DMX_KIND_PLAYBACK]);
  });
});
