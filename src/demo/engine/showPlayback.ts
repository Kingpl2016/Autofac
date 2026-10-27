import { fail, num, type DemoModule, type World } from "./world";

/** 演示用的工程最小形态：只读取播放引擎关心的字段。 */
interface DemoProject {
  durationMs?: number;
  fixtures?: { id: string; universe: number }[];
  output?: { loop?: boolean; target?: { kind?: string } };
}

type Transport = "stopped" | "playing" | "paused";

/**
 * 创建节目预览播放引擎模块：模拟后端 30 FPS 引擎的传输状态机。
 *
 * 行为对齐真实后端：
 * - 位置由“后端”（这里的时钟节拍）推进，约 30 Hz 推送 `show:state`；
 * - 播完且不循环则停在结尾并结束输出；循环则回绕；停止回到 0；
 * - 录制进行中 / 已打开回放节目时拒绝开始输出；输出期间拒绝录制和打开回放节目；
 * - 定位只在灯具存在时允许。
 *
 * # Arguments
 *
 * * `world` - 共享的演示世界。
 *
 * # Returns
 *
 * 预览播放模块（命令 + 周期驱动）。
 */
export function createShowPlaybackModule(world: World): DemoModule {
  let loaded = false;
  let durationMs = 0;
  let looping = false;
  let forwarding = true;
  let universes: number[] = [];
  let fixtureIds = new Set<string>();
  let transport: Transport = "stopped";
  let positionMs = 0;
  let locate: string | null = null;

  const outputting = () => transport !== "stopped" || locate !== null;

  const state = () => ({
    loaded,
    transport,
    positionMs: Math.round(positionMs),
    durationMs,
    looping,
    locate,
    universes,
    warnings: [] as unknown[],
    outputting: outputting(),
    destinations: forwarding ? 1 : null,
    dropped: 0,
  });

  const publish = () => world.bus.emit("show:state", state());

  /** 开始输出前的互斥检查。 */
  const guard = () => {
    if (outputting()) return;
    if (world.hooks.isRecording()) fail("recording_active");
    if (world.hooks.playerLoaded()) fail("playback_active");
  };

  world.hooks.showOutputting = outputting;

  return {
    commands: {
      show_load: (args) => {
        const p = args.project as DemoProject | undefined;
        if (!p || typeof p.durationMs !== "number") return fail("invalid_project");
        loaded = true;
        durationMs = Math.max(0, p.durationMs);
        looping = p.output?.loop ?? false;
        forwarding = (p.output?.target?.kind ?? "forwarding") === "forwarding";
        fixtureIds = new Set((p.fixtures ?? []).map((f) => f.id));
        universes = [...new Set((p.fixtures ?? []).map((f) => f.universe))].sort((a, b) => a - b);
        positionMs = Math.min(positionMs, durationMs);
        if (locate !== null && !fixtureIds.has(locate)) locate = null;
        publish();
        return state();
      },

      show_play: () => {
        if (!loaded) return fail("no_show");
        if (durationMs <= 0) return fail("empty_show");
        guard();
        if (positionMs >= durationMs) positionMs = 0;
        transport = "playing";
        publish();
        return state();
      },

      show_pause: () => {
        if (transport === "playing") transport = "paused";
        publish();
        return state();
      },

      show_stop: () => {
        transport = "stopped";
        positionMs = 0;
        publish();
        return state();
      },

      show_seek: (args) => {
        positionMs = Math.min(durationMs, Math.max(0, num(args, "positionMs")));
        publish();
        return state();
      },

      show_locate: (args) => {
        const id = args.fixtureId;
        if (typeof id === "string") {
          if (!loaded) return fail("no_show");
          if (!fixtureIds.has(id)) return fail("unknown_fixture");
          guard();
          locate = id;
        } else {
          locate = null;
        }
        publish();
        return state();
      },

      show_status: () => state(),
    },

    tick: ({ dtMs }) => {
      if (transport !== "playing") return;
      positionMs += dtMs;
      if (positionMs >= durationMs) {
        if (looping && durationMs > 0) {
          positionMs %= durationMs;
        } else {
          positionMs = durationMs;
          transport = "stopped";
        }
      }
      publish();
    },
  };
}
