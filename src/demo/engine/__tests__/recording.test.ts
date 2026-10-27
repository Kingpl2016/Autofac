import { describe, expect, it } from "vitest";

import { mergeActivity } from "@/features/recording/lib/recordTimeline";
import type { Activity, ActivityDto, RecordingStatsEvent } from "@/features/recording/lib/types";
import { loadDemoData } from "../../data";
import { EventBus } from "../../lib/eventBus";
import { createStreamHub } from "../../lib/streamHub";
import { createLiveEngine } from "../live";
import { createRecordingModule } from "../recording";
import type { World } from "../world";

/** 最小的演示世界：时钟由测试推进，自动分段 1 分钟。 */
function makeWorld(clock: { ms: number }): World {
  const data = loadDemoData();
  const settings = { ...data.settings, recording: { ...data.settings.recording, splitMinutes: 1 } };
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
      settings: () => settings,
      recordingDir: () => "D:\\rec",
      currentDiskFree: () => 0,
      programMoved: () => undefined,
    },
  };
}

describe("演示录制模块的活动时间线", () => {
  it("随 recording:stats 推送增量，跨分段记录起点；增量合并结果与全量快照一致", () => {
    const clock = { ms: 0 };
    const world = makeWorld(clock);
    const live = createLiveEngine(world);
    const rec = createRecordingModule(world, live);
    const events: RecordingStatsEvent[] = [];
    world.bus.on("recording:stats", (p) => events.push(p as RecordingStatsEvent));

    rec.commands.recording_start({
      args: {
        name: "测试",
        notes: "",
        fileStem: "t",
        filter: { sources: [], excludeSources: false, universes: [], protocols: [] },
        universes: [0],
      },
    });

    for (let i = 0; i < 2600; i += 1) {
      clock.ms += 50;
      live.tick?.({ dtMs: 50, elapsedMs: clock.ms });
      rec.tick?.({ dtMs: 50, elapsedMs: clock.ms });
    }

    const last = events[events.length - 1];
    expect(last.recording).toBe(true);
    expect(last.part).toBe(3);
    expect(last.partStartsUs).toEqual([0, 60_000_000, 120_000_000]);
    expect(last.sessionElapsedUs).toBeGreaterThanOrEqual(129_000_000);
    expect(last.elapsedUs).toBe(last.sessionElapsedUs - 120_000_000);
    expect(last.activity?.partStartsUs).toEqual([0, 60_000_000, 120_000_000]);

    let local: Activity | null = null;
    for (const e of events) {
      if (!e.activity) continue;
      const next = mergeActivity(local, e.activity);
      expect(next, "演示后端的增量应总能直接合并").not.toBeNull();
      local = next;
    }
    const full = rec.commands.recording_activity({}) as ActivityDto;
    expect(full.from).toBe(0);
    expect(full.len).toBeGreaterThan(0);
    const fromFull = mergeActivity(null, full)!;
    // 最后一次推送之后还有采样：全量最多多出末尾的桶；已推送部分（最后一个桶仍可能在变）一致
    const settled = local!.len - 1;
    expect(fromFull.len).toBeGreaterThanOrEqual(local!.len);
    expect([...local!.level[0].subarray(0, settled)]).toEqual([...fromFull.level[0].subarray(0, settled)]);
    expect([...local!.change[0].subarray(0, settled)]).toEqual([...fromFull.change[0].subarray(0, settled)]);
    expect(fromFull.level[0].some((v) => v > 0)).toBe(true);

    // 停止后快照保留到下次开始
    rec.commands.recording_stop({});
    expect((rec.commands.recording_activity({}) as ActivityDto).len).toBe(full.len);
  });
});
