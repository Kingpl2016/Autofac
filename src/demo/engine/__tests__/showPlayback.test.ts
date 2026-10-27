import { describe, expect, it } from "vitest";
import { loadDemoData } from "../../data";
import { EventBus } from "../../lib/eventBus";
import { createStreamHub } from "../../lib/streamHub";
import { createShowPlaybackModule } from "../showPlayback";
import type { World } from "../world";

/** 最小的演示世界；`recording` / `player` 控制互斥钩子。 */
function makeWorld(flags: { recording?: boolean; player?: boolean } = {}): World {
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
      isRecording: () => flags.recording ?? false,
      playerLoaded: () => flags.player ?? false,
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

const project = (over: Record<string, unknown> = {}) => ({
  durationMs: 1000,
  fixtures: [
    { id: "f1", universe: 0 },
    { id: "f2", universe: 3 },
  ],
  output: { loop: false, target: { kind: "forwarding" } },
  ...over,
});

function setup(flags?: { recording?: boolean; player?: boolean }) {
  const world = makeWorld(flags);
  const mod = createShowPlaybackModule(world);
  const events: { transport: string; positionMs: number }[] = [];
  world.bus.on("show:state", (s) => events.push(s as { transport: string; positionMs: number }));
  const cmd = (name: string, args: Record<string, unknown> = {}) => mod.commands[name](args) as Record<string, unknown>;
  return { world, mod, events, cmd };
}

describe("演示预览播放引擎", () => {
  it("未加载工程不能播放；加载后状态包含 Universe", () => {
    const { cmd } = setup();
    expect(() => cmd("show_play")).toThrow("no_show");
    const s = cmd("show_load", { project: project() });
    expect(s).toMatchObject({ loaded: true, durationMs: 1000, universes: [0, 3], transport: "stopped", destinations: 1 });
    expect(() => cmd("show_load", { project: {} })).toThrow("invalid_project");
  });

  it("按 Universe 表路由：目的地数为启用端口数；端口不合法时拒绝且保留原状态", () => {
    const { cmd } = setup();
    const port = (over: Record<string, unknown> = {}) => ({
      protocol: "artNet",
      mode: "unicast",
      ip: "10.0.0.5",
      remoteUniverse: 1,
      enabled: true,
      ...over,
    });
    const routed = (ports: Record<string, unknown>[]) =>
      project({ output: { loop: false, target: { kind: "routed" }, universes: [{ universe: 0, ports }] } });
    expect(cmd("show_load", { project: routed([port(), port({ protocol: "sacn", mode: "multicast", ip: "" }), port({ enabled: false, ip: "x" })]) })).toMatchObject({
      destinations: 2,
    });
    expect(() => cmd("show_load", { project: routed([port({ ip: "x" })]) })).toThrow("bad_target");
    expect(() => cmd("show_load", { project: routed([port({ mode: "multicast" })]) })).toThrow("bad_target");
    expect(() => cmd("show_load", { project: routed([port({ protocol: "sacn", remoteUniverse: 0 })]) })).toThrow("bad_target");
    expect(cmd("show_status")).toMatchObject({ destinations: 2 });
  });

  it("时长为 0 不能播放", () => {
    const { cmd } = setup();
    cmd("show_load", { project: project({ durationMs: 0 }) });
    expect(() => cmd("show_play")).toThrow("empty_show");
  });

  it("播放期间由时钟推进位置并推送事件；暂停冻结；停止回到 0", () => {
    const { mod, cmd, events } = setup();
    cmd("show_load", { project: project() });
    expect(cmd("show_play")).toMatchObject({ transport: "playing", outputting: true });
    mod.tick?.({ dtMs: 300, elapsedMs: 300 });
    expect(events.at(-1)).toMatchObject({ transport: "playing", positionMs: 300 });
    cmd("show_pause");
    mod.tick?.({ dtMs: 300, elapsedMs: 600 });
    expect(cmd("show_status")).toMatchObject({ transport: "paused", positionMs: 300 });
    cmd("show_stop");
    expect(cmd("show_status")).toMatchObject({ transport: "stopped", positionMs: 0, outputting: false });
  });

  it("播完停在结尾并结束输出；循环则回绕", () => {
    const { mod, cmd } = setup();
    cmd("show_load", { project: project() });
    cmd("show_play");
    mod.tick?.({ dtMs: 1200, elapsedMs: 1200 });
    expect(cmd("show_status")).toMatchObject({ transport: "stopped", positionMs: 1000, outputting: false });
    cmd("show_load", { project: project({ output: { loop: true, target: { kind: "forwarding" } } }) });
    cmd("show_play");
    mod.tick?.({ dtMs: 1300, elapsedMs: 2500 });
    expect(cmd("show_status")).toMatchObject({ transport: "playing", positionMs: 300 });
  });

  it("跳转被夹到范围内", () => {
    const { cmd } = setup();
    cmd("show_load", { project: project() });
    expect(cmd("show_seek", { positionMs: 99_999 })).toMatchObject({ positionMs: 1000 });
    expect(cmd("show_seek", { positionMs: -3 })).toMatchObject({ positionMs: 0 });
  });

  it("定位：灯具必须存在；传 null 结束；定位期间算输出中", () => {
    const { world, cmd } = setup();
    expect(() => cmd("show_locate", { fixtureId: "f1" })).toThrow("no_show");
    cmd("show_load", { project: project() });
    expect(() => cmd("show_locate", { fixtureId: "ghost" })).toThrow("unknown_fixture");
    expect(cmd("show_locate", { fixtureId: "f1" })).toMatchObject({ locate: "f1", outputting: true });
    expect(world.hooks.showOutputting()).toBe(true);
    expect(cmd("show_locate", { fixtureId: null })).toMatchObject({ locate: null, outputting: false });
  });

  it("录制进行中或已打开回放节目时拒绝开始输出", () => {
    const rec = setup({ recording: true });
    rec.cmd("show_load", { project: project() });
    expect(() => rec.cmd("show_play")).toThrow("recording_active");
    const pl = setup({ player: true });
    pl.cmd("show_load", { project: project() });
    expect(() => pl.cmd("show_locate", { fixtureId: "f1" })).toThrow("playback_active");
  });

  it("重新加载工程时，被删除的灯具不再保持定位", () => {
    const { cmd } = setup();
    cmd("show_load", { project: project() });
    cmd("show_locate", { fixtureId: "f2" });
    const s = cmd("show_load", { project: project({ fixtures: [{ id: "f1", universe: 0 }] }) });
    expect(s).toMatchObject({ locate: null });
  });
});