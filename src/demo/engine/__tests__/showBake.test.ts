// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadDemoData } from "../../data";
import { EventBus } from "../../lib/eventBus";
import { createStreamHub } from "../../lib/streamHub";
import { createForwardingModule } from "../forwarding";
import { createLiveEngine } from "../live";
import { createRecordingModule } from "../recording";
import { createShowModule } from "../show";
import type { World } from "../world";

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
      recordingDir: () => "D:\\rec",
      currentDiskFree: () => 0,
      programMoved: () => undefined,
    },
  };
}

const project = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ durationMs: 4000, fixtures: [{ universe: 1 }, { universe: 0 }], ...over });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("演示模式：保存后的烘焙", () => {
  function setup() {
    const world = makeWorld();
    const live = createLiveEngine(world);
    createForwardingModule(world);
    const recording = createRecordingModule(world, live);
    const show = createShowModule(world, recording.library);
    const events: { status: string; reason: string | null; frames: number | null }[] = [];
    world.bus.on("show:bake", (e) => events.push(e as (typeof events)[number]));
    const save = (json: string) =>
      show.commands.show_project_save({ args: { name: "烘焙测试", json } }) as string;
    return { recording, events, save };
  }

  it("有灯具：先 running，片刻后 done，条目变为已导出且可播放", () => {
    const { recording, events, save } = setup();
    const path = save(project());
    expect(events.map((e) => e.status)).toEqual(["running"]);
    let entry = recording.library.find(path)?.entry;
    expect(entry).toMatchObject({ editable: true, exported: false, valid: false });
    vi.advanceTimersByTime(700);
    expect(events.map((e) => e.status)).toEqual(["running", "done"]);
    entry = recording.library.find(path)?.entry;
    expect(entry).toMatchObject({ exported: true, valid: true, durationUs: 4_000_000, universes: [0, 1] });
    expect(entry?.frames).toBe(events[1].frames);
  });

  it("没有灯具：跳过并说明没有可烘焙的内容", () => {
    const { recording, events, save } = setup();
    const path = save(project({ fixtures: [] }));
    expect(events).toMatchObject([{ status: "skipped", reason: "nothing_to_bake" }]);
    vi.advanceTimersByTime(1000);
    expect(recording.library.find(path)?.entry.exported).toBe(false);
  });
});